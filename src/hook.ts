// The contract other plugins (e.g. Skilltree) use. See README.md, "Hook
// contract":
// - window "lovense:gain" CustomEvent { source, gain | null } -> gain combiner
// - window "lovense:status" CustomEvent { ...status } whenever the status or
//   the sent level changes; level-only changes at most every 200 ms (5/s)
// - window.stashLovense = { version: 1, status(), connect() }
import type { LovenseDevice, LovenseStatus } from "./lovense/device.ts";
import { listenGainEvents, type EventTargetLike, type GainCombiner } from "./sync/gain.ts";
import { defaultNow, GLOBAL_TIMERS, type Timers } from "./util/timers.ts";

export const STATUS_EVENT = "lovense:status";
/** level-only status events are at most this often (5 per second) */
export const LEVEL_EVENT_MIN_MS = 200;

export interface StashLovenseApi {
  version: 1;
  status(): LovenseStatus;
  /** must be called from a user gesture (a click) the first time: it may open the Bluetooth picker */
  connect(): void;
}

export interface DispatchTarget extends EventTargetLike {
  dispatchEvent(e: Event): boolean;
}

function sameExceptLevel(a: LovenseStatus, b: LovenseStatus): boolean {
  const { level: _la, ...ra } = a;
  const { level: _lb, ...rb } = b;
  return JSON.stringify(ra) === JSON.stringify(rb);
}

export interface StatusBroadcaster {
  push(s: LovenseStatus): void;
  dispose(): void;
}

/** dispatches "lovense:status" on `target`, throttling level-only changes */
export function createStatusBroadcaster(
  target: DispatchTarget,
  opts: { timers?: Timers; now?: () => number; minLevelIntervalMs?: number } = {},
): StatusBroadcaster {
  const timers = opts.timers ?? GLOBAL_TIMERS;
  const now = opts.now ?? defaultNow;
  const minMs = opts.minLevelIntervalMs ?? LEVEL_EVENT_MIN_MS;
  let last: LovenseStatus | undefined;
  let lastAt = -Infinity;
  let latest: LovenseStatus | undefined;
  let timer: unknown;

  function flush(): void {
    if (timer !== undefined) timers.clearTimeout(timer);
    timer = undefined;
    if (!latest) return;
    last = latest;
    lastAt = now();
    try {
      target.dispatchEvent(new CustomEvent(STATUS_EVENT, { detail: { ...latest } }));
    } catch (err) {
      console.error("[lovense] status event failed", err);
    }
  }

  return {
    push(s) {
      latest = s;
      if (!last || !sameExceptLevel(last, s)) return flush();
      if (last.level === s.level) {
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

export interface HookDeps {
  device: Pick<LovenseDevice, "status" | "connect" | "onStatus">;
  gains: GainCombiner;
  timers?: Timers;
  now?: () => number;
}

/** installs the gain listener, the status events and window.stashLovense; returns an uninstall */
export function installHook(win: DispatchTarget & { stashLovense?: StashLovenseApi }, deps: HookDeps): () => void {
  const stopGains = listenGainEvents(win, deps.gains);
  const broadcaster = createStatusBroadcaster(win, { timers: deps.timers, now: deps.now });
  const stopStatus = deps.device.onStatus((s) => broadcaster.push(s));
  const api: StashLovenseApi = {
    version: 1,
    status: () => deps.device.status(),
    connect: () => {
      void deps.device.connect();
    },
  };
  win.stashLovense = api;
  return () => {
    stopGains();
    stopStatus();
    broadcaster.dispose();
    if (win.stashLovense === api) delete win.stashLovense;
  };
}
