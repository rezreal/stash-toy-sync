// A DG-LAB Coyote as a CalibratableDevice, shared by both versions. The
// version specifics (wire format, handshakes, device-side limits) live in a
// transport (v2.ts, v3.ts); the Bluetooth connection in link.ts; what to
// output in plan.ts. This module owns the timing:
//
// - While something is output, a packet goes out every 100 ms (ticker.ts),
//   each one built from the current plan.
// - Watchdog: drive() / probe() calls older than 300 ms count as silence.
// - Stopping = strength 0 plus silent waveforms for at least 300 ms (until
//   the device confirmed 0, at most 2 s); then the packets stop. Whether the
//   hardware stops by itself when packets stop is unverified, so silence is
//   always sent explicitly - also on disconnect(), dispose() and pagehide.
// - Nothing is output without a valid calibration (except calibration probes).
// - One Coyote per instance: the first instance remembers its device under
//   the old key ("toysync.<kind>.device"), others under
//   "toysync.<kind>.device.<instanceId>"; devices other instances hold are
//   never taken (ctx.claims). Calibration stays per physical device.
import {
  loadCalibration,
  saveCalibration,
  validateCalibration,
  type StorageLike,
} from "../devices/calibration.ts";
import { instanceClaims } from "../devices/claims.ts";
import { instanceStorageKey } from "../devices/instances.ts";
import type { DriverContext } from "../devices/registry.ts";
import type { Calibration, CalibratableDevice, DeviceStatus, DriveFrame } from "../devices/types.ts";
import type { Bluetooth } from "../lovense/bluetooth.d.ts";
import { createListeners } from "../util/timers.ts";
import { createCoyoteLink, type CoyoteLink, type CoyoteProfile } from "./link.ts";
import {
  computePlan,
  frameLive,
  LEVEL_MAX,
  nudgeLive,
  probeLive,
  testLive,
  QUIET_MAX_MS,
  QUIET_MS,
  speedRange,
  TICK_MS,
  type Plan,
  type ProbeState,
} from "./plan.ts";
import { createTicker, type Ticker, type WorkerCtor } from "./ticker.ts";
import { driveDefaultMapping, ESTIM_TARGETS } from "../mapping/targets.ts";

export type CoyoteKind = "coyote-v2" | "coyote-v3";

export const LEVEL_RANGE = Object.freeze({ min: 0, max: LEVEL_MAX });

/** The version-specific half of a Coyote driver. */
export interface CoyoteTransport extends CoyoteProfile {
  readonly kind: CoyoteKind;
  /**
   * One packet for this plan (through the link's io). False when skipped
   * because the GATT queue is still busy; the driver then retries once it
   * drains. The first packet after (re)connect must set the device to 0.
   */
  tick(plan: Plan, now: number): boolean;
  /** strength 0 and silence right away (front of the queue), bypassing handshakes */
  zero(now: number): Promise<void>;
  /** the device is known to be at strength 0 */
  settled(): boolean;
  /** per channel: the most the user allows on the device right now (wheel turned down), 0..200 */
  ceilings(): { a: number; b: number };
  /** something to tell the user (e.g. a wheel turned down) */
  message(): string | undefined;
  /** called when message() or ceilings() change outside a tick */
  setListener(cb: () => void): void;
}

export interface CoyoteDeviceOptions {
  bluetooth?: Bluetooth;
  /** device id and calibration storage; null = don't store; default localStorage */
  storage?: StorageLike | null;
  secureContext?: boolean;
  reconnectDelaysMs?: number[];
  batteryPollMs?: number;
  opTimeoutMs?: number;
  /** the packet clock; default a Blob worker with the context's timers as fallback */
  ticker?: (onTick: () => void, intervalMs: number) => Ticker;
  /** the Worker constructor for the default ticker; null = timers only */
  worker?: WorkerCtor | null;
  /** where "pagehide" is listened for; default window; null = nowhere */
  pageEvents?: PageEvents | null;
}

export interface PageEvents {
  addEventListener(type: string, cb: () => void): void;
  removeEventListener(type: string, cb: () => void): void;
}

export interface CoyoteDevice extends CalibratableDevice {
  readonly kind: CoyoteKind;
  readonly selfReconnects: true;
  resume(): Promise<void>;
  dispose(): void;
  /** the plan of the last packet (for tests and debugging) */
  lastPlan(): Plan | undefined;
}

/** the status message after the wheels turned channels down (they stay capped until reconnect) */
export function wheelMessage(ceil: { a: number; b: number }, turned: ReadonlySet<"a" | "b">): string | undefined {
  if (turned.size === 0) return undefined;
  const parts = [...turned].sort().map((c) => `${c.toUpperCase()} ≤ ${ceil[c]}`);
  return `Turned down on the Coyote (channel ${parts.join(", ")}). Toy Sync stays at or below that until you reconnect.`;
}

const NO_STORAGE: StorageLike = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined };

function defaultPageEvents(): PageEvents | undefined {
  const w = (globalThis as { window?: Partial<PageEvents> }).window;
  return w && typeof w.addEventListener === "function" && typeof w.removeEventListener === "function" ? (w as PageEvents) : undefined;
}

export function createCoyoteDevice(ctx: DriverContext, transport: CoyoteTransport, opts: CoyoteDeviceOptions = {}): CoyoteDevice {
  const kind = transport.kind;
  const storage = opts.storage === null ? NO_STORAGE : opts.storage;
  const inst = ctx.instance;
  const first = !inst || inst.ordinal <= 1;
  const link: CoyoteLink = createCoyoteLink({
    profile: transport,
    storageKey: instanceStorageKey(`toysync.${kind}.device`, inst),
    claims: instanceClaims(ctx.claims, inst?.id ?? kind),
    nameFallback: first,
    timers: ctx.timers,
    ...(opts.bluetooth ? { bluetooth: opts.bluetooth } : {}),
    ...(opts.storage !== undefined ? { storage: opts.storage } : {}),
    ...(opts.secureContext !== undefined ? { secureContext: opts.secureContext } : {}),
    ...(opts.reconnectDelaysMs ? { reconnectDelaysMs: opts.reconnectDelaysMs } : {}),
    ...(opts.batteryPollMs !== undefined ? { batteryPollMs: opts.batteryPollMs } : {}),
    ...(opts.opTimeoutMs !== undefined ? { opTimeoutMs: opts.opTimeoutMs } : {}),
  });
  const statuses = createListeners<DeviceStatus>();

  let frame: { frame: DriveFrame; at: number } | undefined;
  let test: { start: number } | undefined;
  let nudge: { start: number } | undefined;
  let probe: ProbeState | undefined;
  let calCache: { id: string; cal: Calibration | undefined } | undefined;
  let calMessage: string | undefined;
  let streaming = false;
  let lastActiveAt = -Infinity;
  let tickWhenDrained = false;
  let output = { a: 0, b: 0 };
  let plan: Plan | undefined;
  let lastEmitted = "";
  let disposed = false;

  const ticker: Ticker = opts.ticker
    ? opts.ticker(() => tick(), TICK_MS)
    : createTicker(() => tick(), TICK_MS, { timers: ctx.timers, ...(opts.worker !== undefined ? { worker: opts.worker } : {}) });

  // before the first connect: the instance id (the kind for the first instance, as before)
  const id = (): string => link.deviceId() ?? (first ? kind : inst.id);

  function storedCalibration(): Calibration | undefined {
    const key = id();
    if (!calCache || calCache.id !== key) calCache = { id: key, cal: loadCalibration(kind, key, storage) };
    return calCache.cal;
  }

  function validCalibration(): Calibration | undefined {
    const c = storedCalibration();
    return c && validateCalibration(c, LEVEL_RANGE).length === 0 ? c : undefined;
  }

  function planAt(now: number): Plan {
    return computePlan({ now, calibration: validCalibration(), frame, test, nudge, probe, speed: speedRange(ctx.settings()) });
  }

  // --- status -----------------------------------------------------------------------

  function status(): DeviceStatus {
    const ls = link.status();
    const out: DeviceStatus = { connection: ls.connection, device: transport.label };
    if (ls.battery !== undefined) out.battery = ls.battery;
    const message = ls.message ?? calMessage ?? (ls.connection === "connected" ? transport.message() : undefined);
    if (message) out.message = message;
    if (ls.connection === "connected") out.output = { a: output.a / LEVEL_MAX, b: output.b / LEVEL_MAX };
    if (!validCalibration()) out.needsCalibration = true;
    return out;
  }

  function emit(): void {
    const s = status();
    const key = JSON.stringify(s);
    if (key === lastEmitted) return;
    lastEmitted = key;
    statuses.emit(s);
  }

  // --- the packet loop ----------------------------------------------------------------

  function stopStreaming(): void {
    streaming = false;
    tickWhenDrained = false;
    ticker.stop();
    if (output.a !== 0 || output.b !== 0) {
      output = { a: 0, b: 0 };
      emit();
    }
  }

  function expire(now: number): void {
    if (!frameLive(frame, now)) frame = undefined;
    if (!testLive(test, now)) test = undefined;
    if (!nudgeLive(nudge, now)) nudge = undefined;
    if (!probeLive(probe, now)) probe = undefined;
  }

  function tick(): void {
    if (disposed || !streaming) return;
    if (!link.ready()) {
      stopStreaming();
      return;
    }
    const now = ctx.now();
    expire(now);
    const p = planAt(now);
    plan = p;
    if (p.active) lastActiveAt = now;
    let sent = false;
    try {
      sent = transport.tick(p, now);
    } catch (err) {
      console.error(`[toysync] ${kind} packet failed`, err);
    }
    if (!sent) tickWhenDrained = true;
    const ceil = transport.ceilings();
    const level = (c: "a" | "b") => (p[c].slots.some((s) => s > 0) ? Math.min(p[c].level, ceil[c]) : 0);
    output = { a: level("a"), b: level("b") };
    emit();
    if (!p.active) {
      const quiet = now - lastActiveAt;
      if ((quiet >= QUIET_MS && transport.settled()) || quiet >= QUIET_MAX_MS) stopStreaming();
    }
  }

  /** starts the packets (first one right away); `urgent` re-phases a running clock and sends now */
  function ensureStreaming(urgent: boolean): void {
    if (disposed || !link.ready()) return;
    if (!streaming) {
      streaming = true;
      ticker.start();
      tick();
    } else if (urgent) {
      ticker.start();
      tick();
    }
  }

  function clearAll(): void {
    frame = undefined;
    test = undefined;
    nudge = undefined;
    probe = undefined;
  }

  /** best-effort stop packets outside the loop (page going away, dispose) */
  function zeroNow(): Promise<void> {
    if (!link.ready()) return Promise.resolve();
    try {
      return transport.zero(ctx.now()).catch(() => undefined);
    } catch {
      return Promise.resolve();
    }
  }

  // --- wiring ----------------------------------------------------------------------------

  transport.setListener(() => emit());
  const offStatus = link.onStatus(() => emit());
  const offReady = link.onReady(() => {
    // a fresh link: the transport's first packet sets 0 (and V3 its limits)
    streaming = false;
    lastActiveAt = ctx.now();
    ensureStreaming(false);
  });
  const offLost = link.onLost(() => stopStreaming());
  const offDrain = link.onDrain(() => {
    if (!tickWhenDrained || !streaming) return;
    tickWhenDrained = false;
    ticker.start();
    tick();
  });

  const page = opts.pageEvents === null ? undefined : (opts.pageEvents ?? defaultPageEvents());
  const onPageHide = () => {
    clearAll();
    void zeroNow();
  };
  page?.addEventListener("pagehide", onPageHide);

  return {
    kind,
    get id() {
      return id();
    },
    channels: ["a", "b"] as const,
    selfReconnects: true,
    connect: () => link.connect(),
    resume: () => link.resume(),
    disconnect() {
      clearAll();
      stopStreaming();
      void link.disconnect(() => transport.zero(ctx.now()));
    },
    status,
    onStatus: (cb) => statuses.add(cb),
    drive(f) {
      if (f === null) {
        // silence: the running packets carry it (strength 0 + quiet period)
        frame = undefined;
        return;
      }
      frame = { frame: f, at: ctx.now() };
      if (!streaming && planAt(ctx.now()).active) ensureStreaming(false);
    },
    nudge() {
      if (!validCalibration() || !link.ready()) return false;
      const now = ctx.now();
      // a nudge in progress isn't restarted or stacked: nudges never escalate
      if (!nudgeLive(nudge, now)) {
        nudge = { start: now };
        ensureStreaming(true);
      }
      return true;
    },
    test() {
      if (!validCalibration() || !link.ready()) return;
      test = { start: ctx.now() };
      ensureStreaming(true);
    },
    stopNow() {
      clearAll();
      if (streaming) ensureStreaming(true);
      else if (link.ready() && !transport.settled()) {
        lastActiveAt = ctx.now();
        ensureStreaming(false);
      }
    },
    calibration: () => storedCalibration(),
    setCalibration(c) {
      const key = id();
      if (c !== undefined) {
        const problems = validateCalibration(c, LEVEL_RANGE);
        if (problems.length > 0) {
          calMessage = `Calibration not saved: ${problems.join(" ")}`;
          emit();
          return;
        }
      }
      const copy: Calibration | undefined = c && { ...c, a: { ...c.a }, ...(c.b ? { b: { ...c.b } } : {}) };
      calMessage = saveCalibration(kind, key, copy, storage)
        ? undefined
        : "The calibration couldn't be stored in this browser; it is used until the page reloads.";
      calCache = { id: key, cal: copy };
      // new limits go to the device right away (Coyote 3.0 BF)
      if (link.ready()) ensureStreaming(true);
      emit();
    },
    probe(channel, level, kind2, active) {
      if (channel !== "a" && channel !== "b") return;
      if (!active) {
        if (probe) {
          probe = undefined;
          if (streaming) ensureStreaming(true);
        }
        return;
      }
      const now = ctx.now();
      const lv = Number.isFinite(level) ? level : 0;
      if (!probe || probe.channel !== channel || probe.kind !== kind2) probe = { channel, level: lv, kind: kind2, start: now, at: now };
      else probe = { ...probe, level: lv, at: now };
      ensureStreaming(false);
    },
    levelRange: () => ({ ...LEVEL_RANGE }),
    // per-scene mapping (scene tab): the frame parts this driver reads
    mappingTargets: () => ESTIM_TARGETS,
    defaultMapping: (channels) => driveDefaultMapping(channels, ctx.settings().axisMap, ESTIM_TARGETS.map((t) => t.id)),
    lastPlan: () => plan,
    forget: () => link.forget(),
    dispose() {
      if (disposed) return;
      clearAll();
      stopStreaming();
      void link.disconnect(() => transport.zero(ctx.now())).finally(() => link.release());
      disposed = true;
      ticker.dispose();
      page?.removeEventListener("pagehide", onPageHide);
      offStatus();
      offReady();
      offLost();
      offDrain();
      statuses.clear();
    },
  };
}
