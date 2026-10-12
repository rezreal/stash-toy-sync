// Snap events from a funscript "snap" axis, and a cursor that tells which
// snaps the playhead just crossed. Pure and DOM-free.
import type { Action } from "./parse.ts";

export const DEFAULT_SNAP_THRESHOLD = 50;

/** a forward step longer than this (seconds) is a seek, not playback */
export const MAX_PLAY_STEP_SEC = 1.5;

/**
 * Snap times in ms: every rising edge where pos goes from below `threshold`
 * to at or above it. A first point already at or above the threshold counts.
 * Points that stay high don't repeat. Input need not be sorted.
 */
export function snapEvents(actions: Action[], opts: { threshold?: number } = {}): number[] {
  const threshold = opts.threshold ?? DEFAULT_SNAP_THRESHOLD;
  const sorted = actions
    .filter((a) => Number.isFinite(a.at) && Number.isFinite(a.pos))
    .slice()
    .sort((x, y) => x.at - y.at);
  const out: number[] = [];
  let high = false;
  for (const a of sorted) {
    const isHigh = a.pos >= threshold;
    if (isHigh && !high) out.push(a.at);
    high = isHigh;
  }
  return out;
}

export interface SnapCursor {
  /**
   * Snaps (ms) crossed while the video moved from `prevSec` to `curSec`:
   * events in [prev, cur) during normal forward playback. A paused video
   * returns none; a backward seek (or loop restart) or a forward jump longer
   * than MAX_PLAY_STEP_SEC returns none and resyncs, so seeking never causes
   * a burst of flashes.
   */
  crossed(prevSec: number, curSec: number): number[];
}

/** `events` must be sorted ascending (snapEvents output is). */
export function snapCursor(events: number[]): SnapCursor {
  // index of the first event at or after the last seen time
  let next = 0;
  let lastMs = -Infinity;

  const lowerBound = (ms: number) => {
    let lo = 0;
    let hi = events.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (events[mid] < ms) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };

  return {
    crossed(prevSec, curSec) {
      if (!Number.isFinite(prevSec) || !Number.isFinite(curSec)) return [];
      const prevMs = prevSec * 1000;
      const curMs = curSec * 1000;
      const step = curSec - prevSec;
      if (step <= 0 || step > MAX_PLAY_STEP_SEC) {
        next = lowerBound(curMs);
        lastMs = curMs;
        return [];
      }
      // the hint is valid when the caller continues from where it left off
      if (prevMs !== lastMs) next = lowerBound(prevMs);
      const out: number[] = [];
      while (next < events.length && events[next] < curMs) {
        if (events[next] >= prevMs) out.push(events[next]);
        next++;
      }
      lastMs = curMs;
      return out;
    },
  };
}
