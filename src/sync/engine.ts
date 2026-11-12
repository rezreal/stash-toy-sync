// Turns playback + funscript + settings + gain into one DriveFrame per tick
// (the player slot ticks every ~50 ms) and hands it to the output (the
// DeviceManager). Pure apart from injected time, timers and the output.
//
// Output is null (silence) unless the video is playing and the scene has a
// script. Whenever output stops (pause, end, seek, no script, unmount) the
// engine keeps sending null for a little longer than the drivers' rate
// limits, so the final 0 is really written and not coalesced away by a
// quick resume.
//
// The frame, from the stroke (the main axis):
// - intensity: speed mode = stroke speed |Δpos|/Δt over speedFull, smoothed
//   (~150 ms); position mode = depth (100 - pos), `invert` flips it
// - balance: depth / 100 (pos 100 = out -> 0 = channel A; deepest -> B);
//   a file marked `inverted` is taken as is; 0.5 outside the script
// - speed: stroke speed over speedFull, lightly smoothed (~60 ms)
// and from embedded axes (sync/axes.ts), which win over the stroke:
// - a mapped intensity / balance / speed axis replaces the stroke value
// - mapped a / b axes are sent as frame.a / frame.b (they replace
//   intensity × balance for that channel in the e-stim drivers)
// - with no stroke and no intensity axis, intensity = max(a, b)
// Snap pulses lift intensity (and a / b when present) to full for 300 ms.
// The hook gain multiplies intensity, a and b, never balance or speed.
import type { DriveFrame } from "../devices/types.ts";
import type { Funscript } from "../funscript/parse.ts";
import { findAxis } from "../funscript/parse.ts";
import { GLOBAL_TIMERS, defaultNow, type Timers } from "../util/timers.ts";
import { parseAxisMap, resolveAxes, type AxisTarget, type ResolvedAxes } from "./axes.ts";
import {
  createSmoother,
  positionAt,
  positionIntensity,
  speedIntensity,
  strokeDepth,
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

export interface FrameOutput {
  drive(frame: DriveFrame | null): void;
}

export interface SyncEngineOptions {
  output: FrameOutput;
  /** effective hook gain, 0..1 */
  gain?: () => number;
  now?: () => number;
  timers?: Timers;
}

/** what feeds each part of the frame for the current script, for display */
export interface EffectiveMapping {
  /** the script has a main stroke axis */
  stroke: boolean;
  /** per target: the axis id, "stroke", or undefined (nothing: a / b unset, intensity from a / b) */
  targets: Record<AxisTarget, string | undefined>;
  /** problems reading the axisMap setting */
  problems: string[];
}

export interface SyncEngine {
  setSettings(s: Settings): void;
  /** the scene's funscript, or undefined for none */
  setScript(f: Funscript | undefined): void;
  hasScript(): boolean;
  /** what drives what for the current script; undefined without one */
  mapping(): EffectiveMapping | undefined;
  /** computes and sends the frame for this moment; returns it */
  tick(p: PlaybackState): DriveFrame | null;
  /** recomputes with the last playback state (e.g. the gain changed) */
  refresh(): DriveFrame | null;
  /** a pulse at intensity 0.5 (gain ignored) for durationMs, then back to normal */
  test(durationMs?: number): void;
  /** output null now and forget the playback state (unmount, scene change) */
  stop(): void;
  /** the frame last sent */
  frame(): DriveFrame | null;
  /** called after every frame sent (for meters and status events) */
  onFrame(cb: (frame: DriveFrame | null) => void): () => void;
  dispose(): void;
}

/** a step of the video this far (ms) off the wall clock is a seek */
export const SEEK_JUMP_MS = 500;
/** silence is held this long after output stops; longer than the Lovense sender's 100 ms rate limit */
export const STOP_HOLD_MS = 150;
export const TEST_INTENSITY = 0.5;
export const TEST_MS = 1000;
/** smoothing of the speed part of the frame (light: e-stim frequency may follow quickly) */
export const SPEED_SMOOTHING_MS = 60;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : Number.isFinite(v) ? v : 0);

/** an axis' value 0..1 at script time ms, undefined outside it */
function axisAt(axes: ResolvedAxes, target: AxisTarget, ms: number): number | undefined {
  const m = axes[target];
  if (!m) return undefined;
  const pos = positionAt(m.actions, ms);
  return pos === undefined ? undefined : clamp01(pos / 100);
}

export function createSyncEngine(opts: SyncEngineOptions): SyncEngine {
  const now = opts.now ?? defaultNow;
  const timers = opts.timers ?? GLOBAL_TIMERS;
  const gainOf = opts.gain ?? (() => 1);
  const frameListeners = new Set<(f: DriveFrame | null) => void>();

  let settings: Settings = DEFAULT_SETTINGS;
  let source: Funscript | undefined;
  let script: StrokeScript | undefined;
  let axes: ResolvedAxes = {};
  let axisProblems: string[] = [];
  let pulser: SnapPulser | undefined;
  let snapAxis: Funscript["actions"] | undefined;
  // both start from 0 whenever output starts, so they ramp up instead of kicking in
  const smoother: Smoother = createSmoother(undefined, 0);
  const speedSmoother: Smoother = createSmoother(SPEED_SMOOTHING_MS, 0);

  let last: PlaybackState = { playing: false, timeSec: 0 };
  /** the previous active tick: script seconds and wall ms */
  let prev: { sec: number; wall: number } | undefined;
  let active = false;
  let holdUntil = -Infinity;
  let testUntil = -Infinity;
  let testTimer: unknown;
  let current: DriveFrame | null = null;

  function rebuildPulser(): void {
    pulser = settings.snapPulse && snapAxis && snapAxis.length > 0 ? createSnapPulser(snapAxis) : undefined;
  }

  function rebuildAxes(): void {
    const parsed = parseAxisMap(settings.axisMap);
    axisProblems = parsed.problems;
    axes = source ? resolveAxes(source, parsed.entries) : {};
  }

  function usable(): boolean {
    return (script !== undefined && script.actions.length > 0) || Object.keys(axes).length > 0;
  }

  function output(frame: DriveFrame | null): DriveFrame | null {
    current = frame;
    opts.output.drive(frame);
    for (const cb of [...frameListeners]) {
      try {
        cb(frame);
      } catch (err) {
        console.error("[toysync] frame listener failed", err);
      }
    }
    return frame;
  }

  /** output stopped: forget the motion state and hold silence briefly */
  function stopActive(t: number): void {
    if (active) holdUntil = Math.max(holdUntil, t + STOP_HOLD_MS);
    active = false;
    prev = undefined;
    smoother.reset();
    speedSmoother.reset();
    pulser?.reset();
  }

  function frameAt(ms: number, t: number, pulse: number): DriveFrame {
    const stroke = script && script.actions.length > 0 ? script : undefined;
    const rawSpeed = stroke ? speedIntensity(stroke.actions, ms, settings.speedFull) : 0;
    const strokeSpeed = speedSmoother.next(rawSpeed, t);
    const strokeIntensity = !stroke
      ? undefined
      : settings.mode === "position"
        ? positionIntensity(stroke, ms, settings.invert)
        : smoother.next(rawSpeed, t);
    const strokeBalance = stroke ? (strokeDepth(stroke, ms) ?? 0.5) : 0.5;

    // a mapped a / b axis outside its actions is silence on that channel
    const a = axes.a ? (axisAt(axes, "a", ms) ?? 0) : undefined;
    const b = axes.b ? (axisAt(axes, "b", ms) ?? 0) : undefined;
    let intensity: number;
    if (axes.intensity) intensity = axisAt(axes, "intensity", ms) ?? 0;
    else if (strokeIntensity !== undefined) intensity = strokeIntensity;
    else intensity = Math.max(a ?? 0, b ?? 0);
    const balance = axes.balance ? (axisAt(axes, "balance", ms) ?? strokeBalance) : strokeBalance;
    const speed = axes.speed ? (axisAt(axes, "speed", ms) ?? clamp01(strokeSpeed)) : clamp01(strokeSpeed);

    const g = clamp01(gainOf());
    const lift = (v: number) => clamp01(Math.max(v, pulse) * g);
    const frame: DriveFrame = { intensity: lift(intensity), balance: clamp01(balance), speed: clamp01(speed), gain: g };
    if (a !== undefined) frame.a = lift(a);
    if (b !== undefined) frame.b = lift(b);
    return frame;
  }

  function compute(p: PlaybackState): DriveFrame | null {
    const t = now();
    if (t < testUntil) {
      // the test pulse wins; motion state restarts afterwards
      stopActive(t);
      holdUntil = -Infinity;
      return { intensity: TEST_INTENSITY, balance: 0.5, speed: 0.5 };
    }
    if (!p.playing || !usable() || !Number.isFinite(p.timeSec)) {
      stopActive(t);
      return null;
    }
    const sec = p.timeSec + settings.latencyMs / 1000;
    if (prev && Math.abs((sec - prev.sec) * 1000 - (t - prev.wall)) > SEEK_JUMP_MS) {
      // a seek while playing: silence for a moment, then pick up at the new place
      stopActive(t);
      prev = { sec, wall: t };
      return null;
    }
    const prevSec = prev?.sec ?? sec;
    prev = { sec, wall: t };
    if (t < holdUntil) {
      // keep the cursor moving so a snap during the hold doesn't fire late
      pulser?.step(prevSec, sec, t);
      return null;
    }
    active = true;
    const pulse = pulser ? pulser.step(prevSec, sec, t) : 0;
    return frameAt(sec * 1000, t, pulse);
  }

  return {
    setSettings(s) {
      const snapChanged = s.snapPulse !== settings.snapPulse;
      const axesChanged = s.axisMap !== settings.axisMap;
      settings = s;
      if (snapChanged) rebuildPulser();
      if (axesChanged) rebuildAxes();
    },
    setScript(f) {
      source = f;
      script = f && f.actions.length > 0 ? strokeScript(f) : undefined;
      snapAxis = f ? findAxis(f, ["snap", "snaps"]) : undefined;
      rebuildAxes();
      rebuildPulser();
      prev = undefined;
      smoother.reset();
      speedSmoother.reset();
    },
    hasScript: usable,
    mapping() {
      if (!source || !usable()) return undefined;
      const stroke = script !== undefined && script.actions.length > 0;
      const strokeOr = (t: AxisTarget) => axes[t]?.axis ?? (stroke ? "stroke" : undefined);
      return {
        stroke,
        targets: {
          intensity: strokeOr("intensity"),
          balance: strokeOr("balance"),
          speed: strokeOr("speed"),
          a: axes.a?.axis,
          b: axes.b?.axis,
        },
        problems: axisProblems,
      };
    },
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
        // back to whatever playback asks for (silence when nothing ticks any more)
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
      output(null);
    },
    frame: () => current,
    onFrame(cb) {
      frameListeners.add(cb);
      return () => frameListeners.delete(cb);
    },
    dispose() {
      if (testTimer !== undefined) timers.clearTimeout(testTimer);
      testTimer = undefined;
      frameListeners.clear();
    },
  };
}
