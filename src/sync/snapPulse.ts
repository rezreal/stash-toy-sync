// Snap pulses: each rising edge of the funscript's "snap" axis that the
// playhead crosses starts a short full-intensity pulse. At most
// maxPerSecond pulses start in any one second; snaps beyond that are
// skipped. Seeks never cause a burst (snapCursor resyncs on jumps).
// Time is passed in; pure apart from its own state.
import { snapCursor, snapEvents } from "../funscript/snap.ts";
import type { Action } from "../funscript/parse.ts";

export const SNAP_PULSE_MS = 300;
export const SNAP_MAX_PER_SECOND = 3;

export interface SnapPulser {
  /**
   * Intensity (0 or 1) from snap pulses after the video moved from prevSec
   * to curSec (script seconds, latency applied) at wall time nowMs.
   */
  step(prevSec: number, curSec: number, nowMs: number): number;
  /** ends a running pulse (output stopped) */
  reset(): void;
}

export function createSnapPulser(
  snapAxis: readonly Action[],
  opts: { pulseMs?: number; maxPerSecond?: number } = {},
): SnapPulser {
  const pulseMs = opts.pulseMs ?? SNAP_PULSE_MS;
  const maxPerSecond = opts.maxPerSecond ?? SNAP_MAX_PER_SECOND;
  const cursor = snapCursor(snapEvents([...snapAxis]));
  /** wall times of accepted pulse starts within the last second */
  let starts: number[] = [];
  let pulseUntil = -Infinity;

  return {
    step(prevSec, curSec, nowMs) {
      const crossed = cursor.crossed(prevSec, curSec);
      if (crossed.length > 0) {
        starts = starts.filter((t) => nowMs - t < 1000);
        // several snaps within one tick start one pulse
        if (starts.length < maxPerSecond) {
          starts.push(nowMs);
          pulseUntil = nowMs + pulseMs;
        }
      }
      return nowMs < pulseUntil ? 1 : 0;
    },
    reset() {
      pulseUntil = -Infinity;
    },
  };
}
