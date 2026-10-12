// Turns playback + funscript + settings + gain into the level to send, once
// per tick (the player slot ticks every ~50 ms). Pure apart from injected
// time, timers and the output.
//
// Output is 0 unless the video is playing and the scene has a script.
// Whenever output stops (pause, end, seek, no script, unmount) the engine
// holds 0 for a little longer than the sender's rate limit, so the final
// "Vibrate:0;" is really sent and not coalesced away by a quick resume.
import type { Funscript } from "../funscript/parse.ts";
import { findAxis } from "../funscript/parse.ts";
import { clampLevel } from "../lovense/protocol.ts";
import { GLOBAL_TIMERS, defaultNow, type Timers } from "../util/timers.ts";
import {
  createSmoother,
  levelFor,
  positionIntensity,
  speedIntensity,
  strokeScript,
  type Smoother,
  type StrokeScript,
} from "./mapping.ts";
import { DEFAULT_SETTINGS, type Settings } from "./settings.ts";
import { createSnapPulser, type SnapPulser } from "./snapPulse.ts";

export interface PlaybackState {
  /** playing: not paused, not ended, not seeking, enough data */
  playing: boolean;
  /** the video's current time in seconds */
  timeSec: number;
}

export interface LevelOutput {
  setLevel(level: number): void;
}

export interface SyncEngineOptions {
  output: LevelOutput;
  /** effective hook gain, 0..1 */
  gain?: () => number;
  now?: () => number;
  timers?: Timers;
}

export interface SyncEngine {
  setSettings(s: Settings): void;
  /** the scene's funscript, or undefined for none */
  setScript(f: Funscript | undefined): void;
  hasScript(): boolean;
  /** computes and sends the level for this moment; returns it */
  tick(p: PlaybackState): number;
  /** recomputes with the last playback state (e.g. the gain changed) */
  refresh(): number;
  /** a pulse at level 10 × strength for durationMs, then back to normal */
  test(durationMs?: number): void;
  /** output 0 now and forget the playback state (unmount, scene change) */
  stop(): void;
  /** the level last asked for */
  level(): number;
  dispose(): void;
}

/** a step of the video this far (ms) off the wall clock is a seek */
export const SEEK_JUMP_MS = 500;
/** 0 is held this long after output stops; longer than the sender's 100 ms rate limit */
export const STOP_HOLD_MS = 150;
export const TEST_LEVEL = 10;
export const TEST_MS = 1000;

export function createSyncEngine(opts: SyncEngineOptions): SyncEngine {
  const now = opts.now ?? defaultNow;
  const timers = opts.timers ?? GLOBAL_TIMERS;
  const gainOf = opts.gain ?? (() => 1);

  let settings: Settings = DEFAULT_SETTINGS;
  let script: StrokeScript | undefined;
  let pulser: SnapPulser | undefined;
  let snapAxis: Funscript["actions"] | undefined;
  // starts from 0 whenever output starts, so it ramps up instead of kicking in
  const smoother: Smoother = createSmoother(undefined, 0);

  let last: PlaybackState = { playing: false, timeSec: 0 };
  /** the previous active tick: script seconds and wall ms */
  let prev: { sec: number; wall: number } | undefined;
  let active = false;
  let holdUntil = -Infinity;
  let testUntil = -Infinity;
  let testTimer: unknown;
  let current = 0;

  function rebuildPulser(): void {
    pulser = settings.snapPulse && snapAxis && snapAxis.length > 0 ? createSnapPulser(snapAxis) : undefined;
  }

  function output(level: number): number {
    current = clampLevel(level);
    opts.output.setLevel(current);
    return current;
  }

  /** output stopped: forget the motion state and hold 0 briefly */
  function stopActive(t: number): void {
    if (active) holdUntil = Math.max(holdUntil, t + STOP_HOLD_MS);
    active = false;
    prev = undefined;
    smoother.reset();
    pulser?.reset();
  }

  function compute(p: PlaybackState): number {
    const t = now();
    if (t < testUntil) {
      // the test pulse wins; motion state restarts afterwards
      stopActive(t);
      holdUntil = -Infinity;
      return clampLevel(Math.round((TEST_LEVEL * settings.strength) / 100));
    }
    if (!p.playing || !script || !Number.isFinite(p.timeSec)) {
      stopActive(t);
      return 0;
    }
    const sec = p.timeSec + settings.latencyMs / 1000;
    if (prev && Math.abs((sec - prev.sec) * 1000 - (t - prev.wall)) > SEEK_JUMP_MS) {
      // a seek while playing: 0 for a moment, then pick up at the new place
      stopActive(t);
      prev = { sec, wall: t };
      return 0;
    }
    const prevSec = prev?.sec ?? sec;
    prev = { sec, wall: t };
    if (t < holdUntil) {
      // keep the cursor moving so a snap during the hold doesn't fire late
      pulser?.step(prevSec, sec, t);
      return 0;
    }
    active = true;
    const ms = sec * 1000;
    let intensity =
      settings.mode === "position"
        ? positionIntensity(script, ms, settings.invert)
        : smoother.next(speedIntensity(script.actions, ms, settings.speedFull), t);
    if (pulser) intensity = Math.max(intensity, pulser.step(prevSec, sec, t));
    return levelFor(intensity, { strength: settings.strength, gain: gainOf(), minLevel: settings.minLevel });
  }

  return {
    setSettings(s) {
      const snapChanged = s.snapPulse !== settings.snapPulse;
      settings = s;
      if (snapChanged) rebuildPulser();
    },
    setScript(f) {
      script = f && f.actions.length > 0 ? strokeScript(f) : undefined;
      snapAxis = f ? findAxis(f, ["snap", "snaps"]) : undefined;
      rebuildPulser();
      prev = undefined;
      smoother.reset();
    },
    hasScript: () => script !== undefined,
    tick(p) {
      last = p;
      return output(compute(p));
    },
    refresh() {
      return output(compute(last));
    },
    test(durationMs = TEST_MS) {
      testUntil = now() + durationMs;
      if (testTimer !== undefined) timers.clearTimeout(testTimer);
      testTimer = timers.setTimeout(() => {
        testTimer = undefined;
        testUntil = -Infinity;
        // back to whatever playback asks for (0 when nothing ticks any more)
        output(compute(last));
      }, durationMs);
      output(compute(last));
    },
    stop() {
      last = { playing: false, timeSec: 0 };
      testUntil = -Infinity;
      if (testTimer !== undefined) timers.clearTimeout(testTimer);
      testTimer = undefined;
      stopActive(now());
      output(0);
    },
    level: () => current,
    dispose() {
      if (testTimer !== undefined) timers.clearTimeout(testTimer);
      testTimer = undefined;
    },
  };
}
