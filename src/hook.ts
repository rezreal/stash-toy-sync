// The contract other plugins (e.g. Skilltree) use, version 2. See README.md,
// "Hook contract":
// - window "toysync:gain" CustomEvent { source, gain | null } -> gain
//   combiner (product of sources); the legacy "lovense:gain" is an alias
// - window "toysync:nudge" CustomEvent { source, reason } -> one nudge on
//   every device that has one, through the nudge limiter (sync/nudge.ts);
//   every request is answered with "toysync:nudge-result"
// - window "toysync:status" CustomEvent { devices, frame, gain } whenever a
//   device's status changes; changes of the output alone (frame, meters) at
//   most every 200 ms (5/s), the latest always delivered
// - legacy "lovense:status" { ...Lovense status } for one more version
// - window.stashToySync = { version: 2, status(), connect(kind) }
// - window.stashLovense = { version: 1, status(), connect() }, deprecated
import type { DeviceEntry } from "./devices/manager.ts";
import type { DeviceKind, DriveFrame } from "./devices/types.ts";
import type { LovenseStatus } from "./lovense/device.ts";
import { listenGainEvents, type EventTargetLike, type GainCombiner } from "./sync/gain.ts";
import type { NudgeDrop, NudgeLimiter } from "./sync/nudge.ts";
import { defaultNow, GLOBAL_TIMERS, type Timers } from "./util/timers.ts";

export const STATUS_EVENT = "toysync:status";
export const LEGACY_STATUS_EVENT = "lovense:status";
export const NUDGE_EVENT = "toysync:nudge";
export const NUDGE_RESULT_EVENT = "toysync:nudge-result";
/** output-only status events are at most this often (5 per second) */
export const LEVEL_EVENT_MIN_MS = 200;

export interface ToySyncStatus {
  devices: DeviceEntry[];
  /** the frame last sent to the devices; null = silence (nothing playing, paused, stopped) */
  frame: DriveFrame | null;
  /** the effective hook gain, 0..1 */
  gain: number;
}

export interface StashToySyncApi {
  version: 2;
  status(): ToySyncStatus;
  /** must be called from a user gesture (a click) the first time: it may open the Bluetooth picker. Default "lovense". */
  connect(kind?: DeviceKind): void;
}

/** the Lovense Sync 0.1 API, kept as window.stashLovense for one version */
export interface StashLovenseApi {
  version: 1;
  deprecated: true;
  status(): LovenseStatus;
  connect(): void;
}

export interface NudgeDetail {
  source: string;
  reason: string;
}

export interface NudgeResultDetail extends NudgeDetail {
  accepted: boolean;
  /** why it was dropped (accepted = false) */
  dropped?: NudgeDrop | "invalid";
  /** how many devices nudged (accepted = true; 0 when none can nudge) */
  devices?: number;
}

export interface DispatchTarget extends EventTargetLike {
  dispatchEvent(e: Event): boolean;
}

export interface StatusBroadcaster<T> {
  push(s: T): void;
  dispose(): void;
}

export interface BroadcasterOptions<T> {
  event: string;
  /** a key of the parts that are sent right away when they change */
  stable(s: T): string;
  timers?: Timers;
  now?: () => number;
  minIntervalMs?: number;
}

/**
 * Dispatches `event` on `target`: a change of the stable parts right away,
 * changes of the rest (levels, meters) at most every minIntervalMs, the
 * latest always delivered.
 */
export function createStatusBroadcaster<T>(target: DispatchTarget, opts: BroadcasterOptions<T>): StatusBroadcaster<T> {
  const timers = opts.timers ?? GLOBAL_TIMERS;
  const now = opts.now ?? defaultNow;
  const minMs = opts.minIntervalMs ?? LEVEL_EVENT_MIN_MS;
  let last: T | undefined;
  let lastFull = "";
  let lastAt = -Infinity;
  let latest: T | undefined;
  let timer: unknown;

  function flush(): void {
    if (timer !== undefined) timers.clearTimeout(timer);
    timer = undefined;
    if (latest === undefined) return;
    last = latest;
    lastFull = JSON.stringify(latest);
    lastAt = now();
    try {
      // a copy: listeners can't change what the plugin holds
      target.dispatchEvent(new CustomEvent(opts.event, { detail: JSON.parse(lastFull) as T }));
    } catch (err) {
      console.error("[toysync] status event failed", err);
    }
  }

  return {
    push(s) {
      latest = s;
      if (last === undefined || opts.stable(last) !== opts.stable(s)) return flush();
      if (lastFull === JSON.stringify(s)) {
        // back to what was last sent: nothing pending to tell
        if (timer !== undefined) timers.clearTimeout(timer);
        timer = undefined;
        return;
      }
      const wait = lastAt + minMs - now();
      if (wait <= 0) flush();
      else if (timer === undefined) timer = timers.setTimeout(flush, wait);
    },
    dispose() {
      if (timer !== undefined) timers.clearTimeout(timer);
      timer = undefined;
    },
  };
}

/** the stable part of a toysync:status: everything but the frame values and the meters */
export function stableToySyncKey(s: ToySyncStatus): string {
  return JSON.stringify({
    devices: s.devices.map((d) => {
      const { output: _output, ...rest } = d.status;
      return { kind: d.kind, id: d.id, status: rest };
    }),
    gain: s.gain,
    silent: s.frame === null,
  });
}

/** the stable part of a legacy lovense:status: everything but the level */
export function stableLovenseKey(s: LovenseStatus): string {
  const { level: _level, ...rest } = s;
  return JSON.stringify(rest);
}

export interface HookDeps {
  manager: {
    statuses(): DeviceEntry[];
    onChange(cb: (entries: DeviceEntry[]) => void): () => void;
    connect(kind: DeviceKind): Promise<void>;
    nudgeAll(): number;
  };
  engine: {
    frame(): DriveFrame | null;
    onFrame(cb: (f: DriveFrame | null) => void): () => void;
  };
  gains: GainCombiner;
  nudges: NudgeLimiter;
  /** a scene is open in the player */
  sceneOpen(): boolean;
  /** the Lovense driver's own status, for the legacy event and window.stashLovense */
  legacy?: {
    status(): LovenseStatus;
    onStatus(cb: (s: LovenseStatus) => void): () => void;
    connect(): void;
  };
  timers?: Timers;
  now?: () => number;
}

export type HookWindow = DispatchTarget & { stashToySync?: StashToySyncApi; stashLovense?: StashLovenseApi };

/** a request's detail, or undefined when it isn't { source: non-empty string, reason?: string } */
export function readNudgeDetail(detail: unknown): NudgeDetail | undefined {
  if (!detail || typeof detail !== "object") return undefined;
  const d = detail as Partial<Record<keyof NudgeDetail, unknown>>;
  if (typeof d.source !== "string" || d.source.trim() === "") return undefined;
  return { source: d.source.trim(), reason: typeof d.reason === "string" ? d.reason : "" };
}

/** installs the listeners, the status events and the window APIs; returns an uninstall */
export function installHook(win: HookWindow, deps: HookDeps): () => void {
  const stops: (() => void)[] = [];
  stops.push(listenGainEvents(win, deps.gains));

  const status = (): ToySyncStatus => ({
    devices: deps.manager.statuses(),
    frame: deps.engine.frame(),
    gain: deps.gains.gain(),
  });
  const broadcaster = createStatusBroadcaster<ToySyncStatus>(win, {
    event: STATUS_EVENT,
    stable: stableToySyncKey,
    timers: deps.timers,
    now: deps.now,
  });
  const push = () => broadcaster.push(status());
  stops.push(deps.manager.onChange(push), deps.engine.onFrame(push), deps.gains.onChange(push));
  stops.push(() => broadcaster.dispose());

  const answer = (d: NudgeResultDetail) => {
    try {
      win.dispatchEvent(new CustomEvent(NUDGE_RESULT_EVENT, { detail: d }));
    } catch (err) {
      console.error("[toysync] nudge result event failed", err);
    }
  };
  const onNudge = (e: Event) => {
    const raw = (e as CustomEvent<unknown>).detail;
    const detail = readNudgeDetail(raw);
    if (!detail) {
      console.info("[toysync] nudge dropped: the request needs { source, reason }", raw);
      answer({ source: "", reason: "", accepted: false, dropped: "invalid" });
      return;
    }
    const decision = deps.nudges.request(deps.sceneOpen());
    if (!decision.ok) {
      console.info(`[toysync] nudge from ${detail.source} (${detail.reason || "no reason"}) dropped: ${decision.dropped}`);
      answer({ ...detail, accepted: false, dropped: decision.dropped });
      return;
    }
    const devices = deps.manager.nudgeAll();
    answer({ ...detail, accepted: true, devices });
  };
  win.addEventListener(NUDGE_EVENT, onNudge);
  stops.push(() => win.removeEventListener(NUDGE_EVENT, onNudge));

  const api: StashToySyncApi = {
    version: 2,
    status,
    connect: (kind = "lovense") => {
      void deps.manager.connect(kind);
    },
  };
  win.stashToySync = api;
  stops.push(() => {
    if (win.stashToySync === api) delete win.stashToySync;
  });

  const legacy = deps.legacy;
  if (legacy) {
    const legacyBroadcaster = createStatusBroadcaster<LovenseStatus>(win, {
      event: LEGACY_STATUS_EVENT,
      stable: stableLovenseKey,
      timers: deps.timers,
      now: deps.now,
    });
    stops.push(legacy.onStatus((s) => legacyBroadcaster.push(s)), () => legacyBroadcaster.dispose());
    // deprecated alias for plugins written against Lovense Sync 0.1
    const old: StashLovenseApi = { version: 1, deprecated: true, status: () => legacy.status(), connect: () => legacy.connect() };
    win.stashLovense = old;
    stops.push(() => {
      if (win.stashLovense === old) delete win.stashLovense;
    });
  }

  return () => {
    for (const stop of stops.splice(0)) stop();
  };
}
