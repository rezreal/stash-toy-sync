// Turns playback + funscript + settings + gain into DriveFrames every tick
// (the player slot ticks every ~50 ms) and hands them to the output (the
// DeviceManager): one default frame (the built-in mapping: what the hook
// contract reports) plus one per device kind with a mapping
// (setDeviceMappings, from the scene's mapping; src/mapping/frame.ts builds
// them). Pure apart from injected time, timers and the output.
//
// Output is null (silence) unless the video is playing and the scene has a
// script. Whenever output stops (pause, end, seek, no script, unmount) the
// engine keeps sending null for a little longer than the drivers' rate
// limits, so the final 0 is really written and not coalesced away by a
// quick resume.
//
// The default frame, from the stroke (the main axis):
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
// Script time = video time + latency setting + the scene offset.
import type { ChannelMapping, DeviceKind, DriveFrame, ScriptChannel } from "../devices/types.ts";
import type { Funscript } from "../funscript/parse.ts";
import { findAxis } from "../funscript/parse.ts";
import { scriptChannels } from "../mapping/channels.ts";
import { activeMapping, buildFrame, type FrameSources } from "../mapping/frame.ts";
import { DRIVE_TARGET_IDS, driveDefaultMapping, resolveDriveSources } from "../mapping/targets.ts";
import { GLOBAL_TIMERS, defaultNow, type Timers } from "../util/timers.ts";
import { parseAxisMap, type AxisTarget } from "./axes.ts";
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
  /**
   * frame: the default frame (null = silence for every device); perKind: the
   * frames of device kinds with their own mapping (absent while silent or
   * during the test pulse: then `frame` is for everyone)
   */
  drive(frame: DriveFrame | null, perKind?: ReadonlyMap<DeviceKind, DriveFrame>): void;
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
  /** the script's channels (same array until the script changes) */
  channels(): readonly ScriptChannel[];
  /** per device kind: its mapping for the scene (DriveFrame devices only); kinds left out get the default frame */
  setDeviceMappings(m: ReadonlyMap<DeviceKind, Readonly<Record<string, ChannelMapping>>> | undefined): void;
  /** the scene's offset in ms (added to the video time, like the latency setting) */
  setOffsetMs(ms: number): void;
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
  /** the default frame last sent */
  frame(): DriveFrame | null;
  /** the frame last sent to a device kind (its own, else the default) */
  frameFor(kind: DeviceKind): DriveFrame | null;
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

export function createSyncEngine(opts: SyncEngineOptions): SyncEngine {
  const now = opts.now ?? defaultNow;
  const timers = opts.timers ?? GLOBAL_TIMERS;
  const gainOf = opts.gain ?? (() => 1);
  const frameListeners = new Set<(f: DriveFrame | null) => void>();

  let settings: Settings = DEFAULT_SETTINGS;
  let source: Funscript | undefined;
  let script: StrokeScript | undefined;
  let channels: readonly ScriptChannel[] = [];
  const channelById = new Map<string, ScriptChannel>();
  /** the built-in mapping (every DriveFrame target), without "off" entries */
  let defaultMapping: Record<string, ChannelMapping> = {};
  let deviceMappings = new Map<DeviceKind, Record<string, ChannelMapping>>();
  let offsetMs = 0;
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
  let currentPerKind: ReadonlyMap<DeviceKind, DriveFrame> | undefined;

  function rebuildPulser(): void {
    pulser = settings.snapPulse && snapAxis && snapAxis.length > 0 ? createSnapPulser(snapAxis) : undefined;
  }

  function rebuildAxes(): void {
    axisProblems = parseAxisMap(settings.axisMap).problems;
    defaultMapping = activeMapping(driveDefaultMapping(channels, settings.axisMap, DRIVE_TARGET_IDS));
  }

  function usable(): boolean {
    if (script !== undefined && script.actions.length > 0) return true;
    if (Object.keys(defaultMapping).length > 0) return true;
    for (const m of deviceMappings.values()) if (Object.keys(m).length > 0) return true;
    return false;
  }

  function level(id: string, ms: number): number | undefined {
    const ch = channelById.get(id);
    if (!ch) return undefined;
    const pos = positionAt(ch.actions, ms);
    return pos === undefined ? undefined : clamp01(pos / 100);
  }

  interface Computed {
    frame: DriveFrame | null;
    perKind?: Map<DeviceKind, DriveFrame>;
  }

  function output(c: Computed): DriveFrame | null {
    const frame = c.frame;
    current = frame;
    currentPerKind = frame ? c.perKind : undefined;
    opts.output.drive(frame, currentPerKind);
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

  function framesAt(ms: number, t: number, pulse: number): Computed {
    const stroke = script && script.actions.length > 0 ? script : undefined;
    const rawSpeed = stroke ? speedIntensity(stroke.actions, ms, settings.speedFull) : 0;
    const strokeSpeed = speedSmoother.next(rawSpeed, t);
    const sources: FrameSources = {
      level: (id) => level(id, ms),
    };
    if (stroke) {
      sources.stroke = {
        intensity: settings.mode === "position" ? positionIntensity(stroke, ms, settings.invert) : smoother.next(rawSpeed, t),
        balance: strokeDepth(stroke, ms),
        speed: clamp01(strokeSpeed),
      };
    }
    const g = gainOf();
    const frame = buildFrame(defaultMapping, sources, pulse, g);
    if (deviceMappings.size === 0) return { frame };
    const perKind = new Map<DeviceKind, DriveFrame>();
    for (const [kind, m] of deviceMappings) perKind.set(kind, buildFrame(m, sources, pulse, g));
    return { frame, perKind };
  }

  function compute(p: PlaybackState): Computed {
    const t = now();
    if (t < testUntil) {
      // the test pulse wins (every DriveFrame device); motion state restarts afterwards
      stopActive(t);
      holdUntil = -Infinity;
      return { frame: { intensity: TEST_INTENSITY, balance: 0.5, speed: 0.5 } };
    }
    if (!p.playing || !usable() || !Number.isFinite(p.timeSec)) {
      stopActive(t);
      return { frame: null };
    }
    const sec = p.timeSec + (settings.latencyMs + offsetMs) / 1000;
    if (prev && Math.abs((sec - prev.sec) * 1000 - (t - prev.wall)) > SEEK_JUMP_MS) {
      // a seek while playing: silence for a moment, then pick up at the new place
      stopActive(t);
      prev = { sec, wall: t };
      return { frame: null };
    }
    const prevSec = prev?.sec ?? sec;
    prev = { sec, wall: t };
    if (t < holdUntil) {
      // keep the cursor moving so a snap during the hold doesn't fire late
      pulser?.step(prevSec, sec, t);
      return { frame: null };
    }
    active = true;
    const pulse = pulser ? pulser.step(prevSec, sec, t) : 0;
    return framesAt(sec * 1000, t, pulse);
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
      channels = scriptChannels(f);
      channelById.clear();
      for (const ch of channels) channelById.set(ch.id, ch);
      snapAxis = f ? findAxis(f, ["snap", "snaps"]) : undefined;
      rebuildAxes();
      rebuildPulser();
      prev = undefined;
      smoother.reset();
      speedSmoother.reset();
    },
    channels: () => channels,
    setDeviceMappings(m) {
      const next = new Map<DeviceKind, Record<string, ChannelMapping>>();
      if (m) for (const [kind, mapping] of m) next.set(kind, activeMapping(mapping));
      deviceMappings = next;
    },
    setOffsetMs(ms) {
      offsetMs = Number.isFinite(ms) ? ms : 0;
    },
    hasScript: usable,
    mapping() {
      if (!source || !usable()) return undefined;
      const stroke = script !== undefined && script.actions.length > 0;
      const src = resolveDriveSources(channels, settings.axisMap);
      const strokeOr = (t: AxisTarget) => src[t] ?? (src.auto ? "stroke" : undefined);
      return {
        stroke,
        targets: {
          intensity: strokeOr("intensity"),
          balance: strokeOr("balance"),
          speed: strokeOr("speed"),
          a: src.a,
          b: src.b,
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
      output({ frame: null });
    },
    frame: () => current,
    frameFor: (kind) => (current ? (currentPerKind?.get(kind) ?? current) : null),
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
