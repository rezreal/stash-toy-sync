// Hold-to-output for the calibration page: while the button is held the
// device outputs the chosen level on one channel, ramping up from 0 over
// ~1 s instead of jumping; on release it stops at once. Time and timers are
// injected; no DOM.
import type { CalibratableDevice } from "../devices/types.ts";
import { GLOBAL_TIMERS, type Timers } from "../util/timers.ts";

export const RAMP_MS = 1000;
export const PROBE_TICK_MS = 50;

/**
 * One ramp step: from `current` towards `target` by target × dt / rampMs
 * (so 0 -> target takes rampMs); a lower target is taken at once.
 */
export function rampLevel(current: number, target: number, dtMs: number, rampMs = RAMP_MS): number {
  if (target <= current) return Math.max(0, target);
  if (rampMs <= 0) return target;
  return Math.min(target, current + (target * Math.max(0, dtMs)) / rampMs);
}

export interface ProbeSession {
  /** button down: output starts at 0 and ramps to `target` */
  start(target: number): void;
  /** the chosen level changed while held (ramps up, drops at once) */
  setTarget(target: number): void;
  /** button up / blur / hidden / unmount: output 0 now; safe to call any time */
  stop(): void;
  active(): boolean;
}

export interface ProbeOptions {
  channel: "a" | "b";
  kind: "steady" | "burst";
  timers?: Timers;
  rampMs?: number;
  tickMs?: number;
  /** called with the level sent while active, 0 after stop (for the UI) */
  onLevel?: (level: number) => void;
}

export function createProbeSession(device: Pick<CalibratableDevice, "probe" | "levelRange">, opts: ProbeOptions): ProbeSession {
  const timers = opts.timers ?? GLOBAL_TIMERS;
  const tickMs = opts.tickMs ?? PROBE_TICK_MS;
  const rampMs = opts.rampMs ?? RAMP_MS;
  let active = false;
  let target = 0;
  let current = 0;
  let timer: unknown;

  function cap(v: number): number {
    const r = device.levelRange();
    return Math.max(0, Math.min(r.max, Math.round(v)));
  }

  function send(level: number, on: boolean): void {
    try {
      device.probe(opts.channel, level, opts.kind, on);
    } catch (err) {
      console.error("[toysync] probe failed", err);
    }
    opts.onLevel?.(on ? level : 0);
  }

  function tick(): void {
    timer = undefined;
    if (!active) return;
    current = rampLevel(current, target, tickMs, rampMs);
    send(Math.round(current), true);
    timer = timers.setTimeout(tick, tickMs);
  }

  return {
    start(t) {
      if (active) return;
      active = true;
      target = cap(t);
      current = 0;
      send(0, true);
      timer = timers.setTimeout(tick, tickMs);
    },
    setTarget(t) {
      target = cap(t);
    },
    stop() {
      if (timer !== undefined) timers.clearTimeout(timer);
      timer = undefined;
      if (!active) return;
      active = false;
      current = 0;
      send(0, false);
    },
    active: () => active,
  };
}
