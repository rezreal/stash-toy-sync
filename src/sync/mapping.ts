// Funscript stroke -> intensity, depth and speed. Pure and DOM-free.
//
// Two modes:
// - speed (default): how fast the stroke moves right now. Intensity is the
//   segment's |Δpos| / Δt (position units per second) over `speedFull`,
//   clamped to 0..1, smoothed with an exponential filter so single short
//   segments don't jerk the motor.
// - position: how deep the stroke is. Funscript pos 100 is the top of the
//   stroke (out) and 0 the deepest point, so depth = 100 - pos; a file
//   marked `inverted` already counts the other way and is taken as is
//   (depth = pos). The `invert` setting flips the result.
// Outside the script (before the first or after the last action) the
// intensity is 0 in both modes.
import type { Action, Funscript } from "../funscript/parse.ts";

export interface StrokeScript {
  /** sorted by `at`, positions normalised to 0..100 (range applied) */
  actions: Action[];
  /** the file's main axis is marked inverted */
  inverted: boolean;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : Number.isFinite(v) ? v : 0);

/** the main axis with `range` applied (`inverted` kept as a flag) */
export function strokeScript(f: Funscript): StrokeScript {
  const range = f.range && f.range > 0 ? f.range : 100;
  const actions =
    range === 100
      ? f.actions
      : f.actions.map((a) => ({ at: a.at, pos: Math.max(0, Math.min(100, (a.pos / range) * 100)) }));
  return { actions, inverted: f.inverted === true };
}

/** index of the last action with at <= t, or -1 */
export function segmentIndex(actions: readonly Action[], t: number): number {
  let lo = 0;
  let hi = actions.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (actions[mid]!.at <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

/**
 * Speed intensity at script time t (ms): |Δpos| / Δt_seconds / speedFull,
 * clamped to 0..1, for the segment around t. 0 before the first action,
 * after the last one, and on flat segments.
 */
export function speedIntensity(actions: readonly Action[], t: number, speedFull: number): number {
  const i = segmentIndex(actions, t);
  if (i < 0 || i >= actions.length - 1) return 0;
  const a = actions[i]!;
  // skip zero-length steps (several actions at the same time)
  let j = i + 1;
  while (j < actions.length && actions[j]!.at <= a.at) j++;
  if (j >= actions.length) return 0;
  const b = actions[j]!;
  const dt = (b.at - a.at) / 1000;
  if (dt <= 0 || speedFull <= 0) return 0;
  return clamp01(Math.abs(b.pos - a.pos) / dt / speedFull);
}

/** the script's position at t (linear between actions); undefined outside the script */
export function positionAt(actions: readonly Action[], t: number): number | undefined {
  if (actions.length === 0) return undefined;
  const first = actions[0]!;
  const last = actions[actions.length - 1]!;
  if (t < first.at || t > last.at) return undefined;
  const i = segmentIndex(actions, t);
  const a = actions[i]!;
  if (i >= actions.length - 1 || a.at === t) return a.pos;
  const b = actions[i + 1]!;
  const span = b.at - a.at;
  if (span <= 0) return b.pos;
  return a.pos + ((b.pos - a.pos) * (t - a.at)) / span;
}

/**
 * Position intensity at t: depth / 100 with depth = 100 - pos (pos 100 is
 * out), or depth = pos for a file marked inverted; `invert` flips it.
 * 0 outside the script.
 */
export function positionIntensity(script: StrokeScript, t: number, invert: boolean): number {
  const pos = positionAt(script.actions, t);
  if (pos === undefined) return 0;
  const depth = script.inverted ? pos : 100 - pos;
  const v = clamp01(depth / 100);
  return invert ? 1 - v : v;
}

/**
 * Depth 0..1 at t (0 = out, 1 = deepest): (100 - pos) / 100, or pos / 100
 * for a file marked inverted. undefined outside the script.
 */
export function strokeDepth(script: StrokeScript, t: number): number | undefined {
  const pos = positionAt(script.actions, t);
  if (pos === undefined) return undefined;
  return clamp01((script.inverted ? pos : 100 - pos) / 100);
}

export const DEFAULT_SMOOTHING_MS = 150;
/** a gap longer than this restarts the filter instead of easing across it */
const SMOOTHER_MAX_GAP_MS = 1000;

export interface Smoother {
  /** the filtered value after feeding `value` at time t (ms) */
  next(value: number, t: number): number;
  reset(): void;
}

/**
 * Exponential smoothing with time constant tauMs (frame-rate independent).
 * With `initial`, the filter starts (and restarts after reset or a gap)
 * from that value instead of jumping to the first input: output that
 * starts from 0 ramps up instead of kicking in at full level.
 */
export function createSmoother(tauMs = DEFAULT_SMOOTHING_MS, initial?: number): Smoother {
  let y: number | undefined;
  let lastT = 0;
  return {
    next(value, t) {
      if (y === undefined || tauMs <= 0) {
        y = initial !== undefined && tauMs > 0 ? initial : value;
        lastT = t;
        return y;
      }
      const dt = t - lastT;
      lastT = t;
      if (dt < 0 || dt > SMOOTHER_MAX_GAP_MS) {
        y = initial ?? value;
        return y;
      }
      const alpha = 1 - Math.exp(-dt / tauMs);
      y = y + (value - y) * alpha;
      return y;
    },
    reset() {
      y = undefined;
    },
  };
}
