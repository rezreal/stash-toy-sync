// Helpers for e-stim drivers (DG-Lab Coyote and alike), so every driver
// reads a DriveFrame the same way. Pure, tested.
//
//   const { a, b } = channelLevels(frame, calibration);   // raw device levels, 0 = off
//   const hz = estimFrequencyHz(frame.speed, ctx.settings());
import type { Settings } from "../sync/settings.ts";
import { levelFor } from "./calibration.ts";
import type { Calibration, DriveFrame } from "./types.ts";

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : Number.isFinite(v) ? v : 0);

/**
 * Per-channel strength 0..1 of a frame. frame.a / frame.b win when set;
 * otherwise intensity is panned by balance with full strength at the
 * centre: A = intensity × min(1, 2 × (1 − balance)),
 * B = intensity × min(1, 2 × balance). So balance 0 = A only, 1 = B only,
 * 0.5 = both at full intensity.
 */
export function channelIntensities(frame: DriveFrame): { a: number; b: number } {
  const i = clamp01(frame.intensity);
  const bal = clamp01(frame.balance);
  return {
    a: frame.a !== undefined ? clamp01(frame.a) : i * Math.min(1, 2 * (1 - bal)),
    b: frame.b !== undefined ? clamp01(frame.b) : i * Math.min(1, 2 * bal),
  };
}

/**
 * Raw device levels for a frame on a calibrated device: each channel's
 * strength through levelFor (0 at or below 0.005, else within
 * [firstFelt, comfortMax], never above hardMax). null, no calibration, or no
 * calibration for channel B gives 0 on that channel.
 */
export function channelLevels(frame: DriveFrame | null, cal: Calibration | undefined): { a: number; b: number } {
  if (!frame || !cal) return { a: 0, b: 0 };
  const s = channelIntensities(frame);
  return { a: levelFor(s.a, cal.a), b: cal.b ? levelFor(s.b, cal.b) : 0 };
}

/**
 * The pulse frequency (Hz) for a frame's speed 0..1, linear between the
 * estimSpeedMinHz and estimSpeedMaxHz settings (already validated: min <
 * max). The driver clamps the result to what its device can do.
 */
export function estimFrequencyHz(speed01: number, s: Pick<Settings, "estimSpeedMinHz" | "estimSpeedMaxHz">): number {
  return s.estimSpeedMinHz + clamp01(speed01) * (s.estimSpeedMaxHz - s.estimSpeedMinHz);
}
