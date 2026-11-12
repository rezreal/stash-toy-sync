// What both Coyote drivers output in one 100 ms packet, decided from the
// engine's frame, the calibration and the running test / nudge / probe.
// Pure: time and state are passed in.
//
// Priority: a calibration probe, then a nudge, then the test pulse, then the
// engine's frame. Every level is a device level 0..200; a calibrated channel
// never gets more than its hardMax (probes may go up to 200: they are how
// hardMax gets found). Each channel carries four 25 ms slots of pulse
// intensity (0..100), so the nudge pattern keeps its shape inside a packet.
import { levelFor } from "../devices/calibration.ts";
import type { Calibration, ChannelCalibration, DriveFrame } from "../devices/types.ts";
import type { Settings } from "../sync/settings.ts";

export type Channel = "a" | "b";
export const CHANNELS: readonly Channel[] = ["a", "b"];

export const LEVEL_MAX = 200;
export const TICK_MS = 100;
export const SLOT_MS = 25;
export const SLOTS = 4;
/** no drive() / probe() call for longer than this while outputting = silence */
export const WATCHDOG_MS = 300;
/** after the last output: keep sending silence (strength 0) this long */
export const QUIET_MS = 300;
/** stop streaming after this much silence even when the device never confirmed 0 */
export const QUIET_MAX_MS = 2000;

export const NUDGE_ON_MS = 120;
export const NUDGE_GAP_MS = 150;
export const NUDGE_COUNT = 3;
export const NUDGE_TOTAL_MS = NUDGE_COUNT * NUDGE_ON_MS + (NUDGE_COUNT - 1) * NUDGE_GAP_MS;
/** a held burst probe repeats the nudge pattern with one more gap */
export const BURST_CYCLE_MS = NUDGE_TOTAL_MS + NUDGE_GAP_MS;
export const NUDGE_HZ = 100;

export const TEST_MS = 1000;
export const TEST_HZ = 50;
export const PROBE_HZ = 50;

export const DEFAULT_SPEED_MIN_HZ = 10;
export const DEFAULT_SPEED_MAX_HZ = 100;
export const SPEED_HZ_LIMIT = { min: 1, max: 200 } as const;

export interface SpeedRange {
  minHz: number;
  maxHz: number;
}

/**
 * The e-stim frequency range from the settings (estimSpeedMinHz /
 * estimSpeedMaxHz, defaults 10 / 100), clamped to 1..200 Hz with min < max.
 * Read defensively: older settings objects don't have the fields.
 */
export function speedRange(settings: Settings | Record<string, unknown> | undefined): SpeedRange {
  const s = (settings ?? {}) as { estimSpeedMinHz?: unknown; estimSpeedMaxHz?: unknown };
  const num = (v: unknown, fallback: number) => {
    const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
    return Number.isFinite(n) ? Math.max(SPEED_HZ_LIMIT.min, Math.min(SPEED_HZ_LIMIT.max, n)) : fallback;
  };
  let minHz = num(s.estimSpeedMinHz, DEFAULT_SPEED_MIN_HZ);
  let maxHz = num(s.estimSpeedMaxHz, DEFAULT_SPEED_MAX_HZ);
  if (minHz > maxHz) [minHz, maxHz] = [maxHz, minHz];
  if (minHz === maxHz) {
    if (maxHz < SPEED_HZ_LIMIT.max) maxHz = Math.min(SPEED_HZ_LIMIT.max, maxHz + 1);
    else minHz = maxHz - 1;
  }
  return { minHz, maxHz };
}

const clamp01 = (v: number | undefined): number => (typeof v !== "number" || !Number.isFinite(v) ? 0 : v < 0 ? 0 : v > 1 ? 1 : v);

/** frequency in Hz for a frame speed 0..1 */
export function speedHz(speed: number, range: SpeedRange): number {
  return range.minHz + clamp01(speed) * (range.maxHz - range.minHz);
}

/**
 * Per-channel strength 0..1: the explicit frame.a / frame.b when set, else
 * A = intensity × (1 − balance) × 2 and B = intensity × balance × 2, each
 * capped at 1 (balance 0.5 gives both channels the full intensity).
 */
export function channelSplit(frame: DriveFrame): { a: number; b: number } {
  const i = clamp01(frame.intensity);
  const bal = typeof frame.balance === "number" && Number.isFinite(frame.balance) ? clamp01(frame.balance) : 0.5;
  return {
    a: frame.a !== undefined ? clamp01(frame.a) : clamp01(i * (1 - bal) * 2),
    b: frame.b !== undefined ? clamp01(frame.b) : clamp01(i * bal * 2),
  };
}

/** the nudge pattern: 3 × 120 ms on with 150 ms gaps (elapsed ms since its start) */
export function nudgeOn(elapsedMs: number): boolean {
  if (elapsedMs < 0 || elapsedMs >= NUDGE_TOTAL_MS) return false;
  return elapsedMs % (NUDGE_ON_MS + NUDGE_GAP_MS) < NUDGE_ON_MS;
}

/** the burst probe: the nudge pattern, repeating */
export function burstOn(elapsedMs: number): boolean {
  if (elapsedMs < 0) return false;
  return nudgeOn(elapsedMs % BURST_CYCLE_MS);
}

/** four 25 ms slots of intensity from a pattern, starting at `elapsedMs` */
export function slotsFrom(elapsedMs: number, on: (t: number) => boolean, intensity = 100): number[] {
  const out: number[] = [];
  for (let i = 0; i < SLOTS; i++) out.push(on(elapsedMs + i * SLOT_MS) ? intensity : 0);
  return out;
}

export interface ChannelPlan {
  /** device level 0..200; 0 = silent */
  level: number;
  /** pulse period in ms */
  periodMs: number;
  /** the sharp nudge waveform (else feel-good) */
  sharp: boolean;
  /** pulse intensity 0..100 per 25 ms slot */
  slots: number[];
}

export const SILENT_CHANNEL: ChannelPlan = Object.freeze({ level: 0, periodMs: 1000 / TEST_HZ, sharp: false, slots: [0, 0, 0, 0] }) as ChannelPlan;

export type PlanSource = "idle" | "drive" | "test" | "nudge" | "probe";

export interface Plan {
  a: ChannelPlan;
  b: ChannelPlan;
  source: PlanSource;
  /** something is (or may soon be) output: keep the packet clock running */
  active: boolean;
  /** device soft limits per channel (Coyote 3.0 BF): hardMax, or 200 uncalibrated / while probing */
  limits: { a: number; b: number };
}

export interface ProbeState {
  channel: Channel;
  level: number;
  kind: "steady" | "burst";
  /** when this probe (channel + kind) started */
  start: number;
  /** the last probe() call */
  at: number;
}

export interface PlanInput {
  now: number;
  /** a valid calibration, or undefined */
  calibration: Calibration | undefined;
  frame?: { frame: DriveFrame; at: number } | undefined;
  test?: { start: number } | undefined;
  nudge?: { start: number } | undefined;
  probe?: ProbeState | undefined;
  speed: SpeedRange;
}

export const frameLive = (f: PlanInput["frame"], now: number): boolean => !!f && now - f.at <= WATCHDOG_MS;
export const testLive = (t: PlanInput["test"], now: number): boolean => !!t && now - t.start < TEST_MS;
export const nudgeLive = (n: PlanInput["nudge"], now: number): boolean => !!n && now - n.start < NUDGE_TOTAL_MS;
export const probeLive = (p: PlanInput["probe"], now: number): boolean => !!p && now - p.at <= WATCHDOG_MS;

const period = (hz: number) => Math.round(1000 / hz);

function on(level: number, hz: number, sharp: boolean, slots = [100, 100, 100, 100]): ChannelPlan {
  if (level <= 0) return SILENT_CHANNEL;
  return { level, periodMs: period(hz), sharp, slots };
}

function cap(level: number, ch: ChannelCalibration): number {
  return Math.max(0, Math.min(ch.hardMax, Math.round(level)));
}

/** the middle of [firstFelt, comfortMax] */
export function testLevel(ch: ChannelCalibration): number {
  return cap((ch.firstFelt + ch.comfortMax) / 2, ch);
}

export function nudgeLevel(ch: ChannelCalibration): number {
  return cap(ch.nudge, ch);
}

export function computePlan(input: PlanInput): Plan {
  const { now, calibration: cal } = input;
  const limits = { a: cal?.a.hardMax ?? LEVEL_MAX, b: cal?.b?.hardMax ?? LEVEL_MAX };
  const chCal = (c: Channel): ChannelCalibration | undefined => (cal ? (c === "a" ? cal.a : cal.b) : undefined);

  const p = input.probe;
  if (p && probeLive(p, now)) {
    const level = Math.max(0, Math.min(LEVEL_MAX, Math.round(Number.isFinite(p.level) ? p.level : 0)));
    const elapsed = now - p.start;
    const plan =
      p.kind === "burst" ? on(level, NUDGE_HZ, true, slotsFrom(elapsed, burstOn)) : on(level, PROBE_HZ, false);
    const out: Plan = { a: SILENT_CHANNEL, b: SILENT_CHANNEL, source: "probe", active: true, limits: { ...limits, [p.channel]: LEVEL_MAX } };
    out[p.channel] = plan;
    return out;
  }

  if (!cal) return { a: SILENT_CHANNEL, b: SILENT_CHANNEL, source: "idle", active: false, limits };

  const n = input.nudge;
  if (n && nudgeLive(n, now)) {
    const slots = slotsFrom(now - n.start, nudgeOn);
    const ch = (c: Channel) => {
      const k = chCal(c);
      return k ? on(nudgeLevel(k), NUDGE_HZ, true, slots) : SILENT_CHANNEL;
    };
    return { a: ch("a"), b: ch("b"), source: "nudge", active: true, limits };
  }

  const t = input.test;
  if (t && testLive(t, now)) {
    const ch = (c: Channel) => {
      const k = chCal(c);
      return k ? on(testLevel(k), TEST_HZ, false) : SILENT_CHANNEL;
    };
    return { a: ch("a"), b: ch("b"), source: "test", active: true, limits };
  }

  const f = input.frame;
  if (f && frameLive(f, now)) {
    const split = channelSplit(f.frame);
    const hz = speedHz(f.frame.speed, input.speed);
    const ch = (c: Channel) => {
      const k = chCal(c);
      return k ? on(levelFor(split[c], k), hz, false) : SILENT_CHANNEL;
    };
    const a = ch("a");
    const b = ch("b");
    return { a, b, source: "drive", active: a.level > 0 || b.level > 0, limits };
  }

  return { a: SILENT_CHANNEL, b: SILENT_CHANNEL, source: "idle", active: false, limits };
}
