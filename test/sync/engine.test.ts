import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseFunscript } from "../../src/funscript/parse.ts";
import type { DriveFrame } from "../../src/devices/types.ts";
import { vibrationLevel } from "../../src/lovense/toy.ts";
import { createSyncEngine, STOP_HOLD_MS, TEST_MS, type PlaybackState } from "../../src/sync/engine.ts";
import { DEFAULT_SETTINGS, type Settings } from "../../src/sync/settings.ts";
import { FakeClock } from "../fakes/clock.ts";

const a = (at: number, pos: number) => ({ at, pos });

/** a steady stroke: 0 -> 100 -> 0 every second from 0 s to 60 s (200 units/s) */
function steadyScript(extra: Record<string, unknown> = {}) {
  const actions = [];
  for (let t = 0; t <= 60_000; t += 500) actions.push(a(t, (t / 500) % 2 === 0 ? 0 : 100));
  return parseFunscript({ actions, ...extra });
}

function setup(settings: Partial<Settings> = {}, gain = 1) {
  const clock = new FakeClock();
  const levels: number[] = [];
  const frames: (DriveFrame | null)[] = [];
  let g = gain;
  const full: Settings = { ...DEFAULT_SETTINGS, ...settings };
  /** what the Lovense driver makes of a frame: the old engine-level numbers */
  const lvl = (f: DriveFrame | null) =>
    f ? vibrationLevel(f.intensity, { strength: full.strength, minLevel: full.minLevel, gain: f.gain ?? 1 }) : 0;
  const raw = createSyncEngine({
    output: {
      drive: (f) => {
        frames.push(f);
        levels.push(lvl(f));
      },
    },
    gain: () => g,
    now: clock.now,
    timers: clock,
  });
  raw.setSettings(full);
  const engine = {
    ...raw,
    tick: (p: PlaybackState) => lvl(raw.tick(p)),
    refresh: () => lvl(raw.refresh()),
    level: () => lvl(raw.frame()),
  };
  /** plays from fromSec for ms milliseconds of wall time in 50 ms ticks; returns the last level */
  const play = (fromSec: number, ms: number) => {
    let level = 0;
    for (let w = 0; w <= ms; w += 50) {
      level = engine.tick({ playing: true, timeSec: fromSec + w / 1000 });
      if (w < ms) clock.advance(50);
    }
    return level;
  };
  return {
    clock,
    engine,
    raw,
    levels,
    frames,
    play,
    setGain: (v: number) => {
      g = v;
    },
  };
}

describe("sync engine", () => {
  it("is 0 without a script or while not playing", () => {
    const t = setup();
    assert.equal(t.engine.tick({ playing: true, timeSec: 1 }), 0);
    t.engine.setScript(steadyScript());
    assert.equal(t.engine.tick({ playing: false, timeSec: 1.2 }), 0);
    assert.equal(t.engine.hasScript(), true);
    t.engine.setScript(parseFunscript({ actions: [] }));
    assert.equal(t.engine.hasScript(), false);
  });

  it("speed mode settles at |Δpos|/Δt / speedFull, smoothed", () => {
    const t = setup();
    t.engine.setScript(steadyScript());
    // 200 u/s over speedFull 300 -> 0.667 -> level 13
    const first = t.engine.tick({ playing: true, timeSec: 10 });
    assert.ok(first < 13, "the filter starts from the first sample, not a jump");
    assert.equal(t.play(10, 1500), 13);
    const fast = setup({ speedFull: 200 });
    fast.engine.setScript(steadyScript());
    assert.equal(fast.play(10, 1500), 20);
  });

  it("smoothing keeps a short spike from jerking the motor", () => {
    const t = setup();
    // still, a 100 ms full-speed spike, still again
    t.engine.setScript(parseFunscript({ actions: [a(0, 50), a(5000, 50), a(5100, 100), a(10_000, 100)] }));
    let peak = 0;
    for (let w = 0; w <= 1000; w += 50) {
      peak = Math.max(peak, t.engine.tick({ playing: true, timeSec: 4.6 + w / 1000 }));
      t.clock.advance(50);
    }
    assert.ok(peak > 0 && peak < 14, `peak ${peak}`);
  });

  it("position mode follows depth (100 - pos)", () => {
    const t = setup({ mode: "position" });
    t.engine.setScript(parseFunscript({ actions: [a(0, 100), a(10_000, 0)] }));
    assert.equal(t.engine.tick({ playing: true, timeSec: 2.5 }), 5);
    t.clock.advance(50);
    assert.equal(t.engine.tick({ playing: true, timeSec: 2.55 }), 5);
    const inv = setup({ mode: "position", invert: true });
    inv.engine.setScript(parseFunscript({ actions: [a(0, 100), a(10_000, 0)] }));
    assert.equal(inv.engine.tick({ playing: true, timeSec: 2.5 }), 15);
  });

  it("reads the script latencyMs ahead of the video", () => {
    const script = parseFunscript({ actions: [a(0, 100), a(10_000, 0)] });
    const t = setup({ mode: "position", latencyMs: 1000 });
    t.engine.setScript(script);
    // video at 4 s -> script at 5 s -> depth 50 -> level 10
    assert.equal(t.engine.tick({ playing: true, timeSec: 4 }), 10);
    const behind = setup({ mode: "position", latencyMs: -1000 });
    behind.engine.setScript(script);
    assert.equal(behind.engine.tick({ playing: true, timeSec: 6 }), 10);
  });

  it("composes strength, gain and minLevel", () => {
    const t = setup({ mode: "position", strength: 50 }, 0.5);
    t.engine.setScript(parseFunscript({ actions: [a(0, 0), a(10_000, 0)] }));
    // depth 100 × 50 % × 0.5 -> 5
    assert.equal(t.engine.tick({ playing: true, timeSec: 1 }), 5);
    t.setGain(0);
    assert.equal(t.engine.refresh(), 0);
    const m = setup({ mode: "position", minLevel: 4 });
    m.engine.setScript(parseFunscript({ actions: [a(0, 99), a(10_000, 99)] }));
    assert.equal(m.engine.tick({ playing: true, timeSec: 1 }), 4);
    const z = setup({ mode: "position", minLevel: 4 });
    z.engine.setScript(parseFunscript({ actions: [a(0, 100), a(10_000, 100)] }));
    assert.equal(z.engine.tick({ playing: true, timeSec: 1 }), 0);
  });

  it("refresh() applies a gain change right away", () => {
    const t = setup({ mode: "position" });
    t.engine.setScript(parseFunscript({ actions: [a(0, 0), a(10_000, 0)] }));
    assert.equal(t.engine.tick({ playing: true, timeSec: 1 }), 20);
    t.setGain(0.5);
    assert.equal(t.engine.refresh(), 10);
    assert.equal(t.levels.at(-1), 10);
  });

  it("holds 0 after a pause, so the final 0 isn't coalesced away", () => {
    const t = setup({ mode: "position" });
    t.engine.setScript(parseFunscript({ actions: [a(0, 0), a(60_000, 0)] }));
    assert.equal(t.play(1, 500), 20);
    t.clock.advance(50);
    assert.equal(t.engine.tick({ playing: false, timeSec: 1.5 }), 0);
    t.clock.advance(50);
    // resumed after 50 ms: still 0 until the hold is over
    assert.equal(t.engine.tick({ playing: true, timeSec: 1.5 }), 0);
    t.clock.advance(STOP_HOLD_MS);
    assert.equal(t.engine.tick({ playing: true, timeSec: 1.5 + STOP_HOLD_MS / 1000 }), 20);
  });

  it("treats a jump of the video while playing as a seek: 0 for a moment", () => {
    const t = setup({ mode: "position" });
    t.engine.setScript(parseFunscript({ actions: [a(0, 0), a(60_000, 0)] }));
    assert.equal(t.play(1, 500), 20);
    t.clock.advance(50);
    assert.equal(t.engine.tick({ playing: true, timeSec: 30 }), 0);
    t.clock.advance(50);
    assert.equal(t.engine.tick({ playing: true, timeSec: 30.05 }), 0);
    t.clock.advance(STOP_HOLD_MS);
    assert.equal(t.engine.tick({ playing: true, timeSec: 30.05 + STOP_HOLD_MS / 1000 }), 20);
  });

  it("adds snap pulses from the snap axis, scaled by strength × gain", () => {
    const script = parseFunscript({
      actions: [a(0, 100), a(60_000, 100)], // position mode: depth 0 -> no base output
      channels: { snap: { actions: [a(0, 0), a(2000, 100), a(2100, 0)] } },
    });
    const t = setup({ mode: "position", strength: 50 });
    t.engine.setScript(script);
    let peak = 0;
    for (let w = 0; w <= 1000; w += 50) {
      peak = Math.max(peak, t.engine.tick({ playing: true, timeSec: 1.6 + w / 1000 }));
      t.clock.advance(50);
    }
    assert.equal(peak, 10);
    const off = setup({ mode: "position", snapPulse: false });
    off.engine.setScript(script);
    let peakOff = 0;
    for (let w = 0; w <= 1000; w += 50) {
      peakOff = Math.max(peakOff, off.engine.tick({ playing: true, timeSec: 1.6 + w / 1000 }));
      off.clock.advance(50);
    }
    assert.equal(peakOff, 0);
  });

  it("test() pulses at 10 × strength for one second, then returns to normal", () => {
    const t = setup({ strength: 60 });
    t.engine.test();
    assert.equal(t.levels.at(-1), 6);
    t.clock.advance(TEST_MS - 1);
    assert.equal(t.engine.tick({ playing: false, timeSec: 0 }), 6);
    t.clock.advance(1);
    assert.equal(t.levels.at(-1), 0, "the timer ends it even when nothing ticks");
  });

  it("stop() sends 0 and cancels a test pulse", () => {
    const t = setup({ mode: "position" });
    t.engine.setScript(parseFunscript({ actions: [a(0, 0), a(60_000, 0)] }));
    t.play(1, 200);
    t.engine.test();
    t.engine.stop();
    assert.equal(t.levels.at(-1), 0);
    assert.equal(t.engine.level(), 0);
    t.clock.advance(TEST_MS);
    assert.equal(t.levels.at(-1), 0);
    assert.equal(t.clock.pending, 0);
    assert.equal(t.frames.at(-1), null);
  });

  it("sends null (silence) while not playing, without a script, and during the stop hold", () => {
    const t = setup({ mode: "position" });
    assert.equal(t.raw.tick({ playing: true, timeSec: 1 }), null);
    t.raw.setScript(parseFunscript({ actions: [a(0, 0), a(60_000, 0)] }));
    assert.equal(t.raw.tick({ playing: false, timeSec: 1 }), null);
    assert.notEqual(t.raw.tick({ playing: true, timeSec: 1 }), null);
    t.clock.advance(50);
    assert.equal(t.raw.tick({ playing: false, timeSec: 1.05 }), null);
    t.clock.advance(50);
    assert.equal(t.raw.tick({ playing: true, timeSec: 1.05 }), null);
  });
});
