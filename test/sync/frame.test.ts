// The engine's DriveFrame: balance, speed, embedded axes, precedence, gain.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { DriveFrame } from "../../src/devices/types.ts";
import { parseFunscript } from "../../src/funscript/parse.ts";
import { createSyncEngine } from "../../src/sync/engine.ts";
import { DEFAULT_SETTINGS, type Settings } from "../../src/sync/settings.ts";
import { FakeClock } from "../fakes/clock.ts";

const a = (at: number, pos: number) => ({ at, pos });
const close = (x: number | undefined, y: number, eps = 0.02) =>
  assert.ok(x !== undefined && Math.abs(x - y) < eps, `${x} ≉ ${y}`);

function setup(settings: Partial<Settings> = {}, gain = 1) {
  const clock = new FakeClock();
  let g = gain;
  const engine = createSyncEngine({ output: { drive: () => undefined }, gain: () => g, now: clock.now, timers: clock });
  engine.setSettings({ ...DEFAULT_SETTINGS, ...settings });
  /** plays from fromSec for ms of wall time in 50 ms ticks; returns the last frame */
  const play = (fromSec: number, ms: number): DriveFrame => {
    let f: DriveFrame | null = null;
    for (let w = 0; w <= ms; w += 50) {
      f = engine.tick({ playing: true, timeSec: fromSec + w / 1000 });
      if (w < ms) clock.advance(50);
    }
    assert.ok(f, "a frame while playing");
    return f;
  };
  return { clock, engine, play, setGain: (v: number) => (g = v) };
}

/** 0 -> 100 -> 0 every second (200 units/s) */
function steady(extra: Record<string, unknown> = {}) {
  const actions = [];
  for (let t = 0; t <= 60_000; t += 500) actions.push(a(t, (t / 500) % 2 === 0 ? 0 : 100));
  return parseFunscript({ actions, ...extra });
}

/** a linear e-stim axis over 0..60 s from `from` to `to` */
const ramp = (from: number, to: number) => ({ actions: [a(0, from), a(60_000, to)] });
const flat = (pos: number) => ramp(pos, pos);

describe("stroke-only frames", () => {
  it("balance = depth / 100: pos 100 (out) -> A, deepest -> B", () => {
    const t = setup({ mode: "position" });
    t.engine.setScript(parseFunscript({ actions: [a(0, 100), a(10_000, 0)] }));
    close(t.engine.tick({ playing: true, timeSec: 0 })!.balance, 0);
    t.clock.advance(50);
    close(t.engine.tick({ playing: true, timeSec: 0.05 })!.balance, 0.005);
    const deep = setup({ mode: "position" });
    deep.engine.setScript(parseFunscript({ actions: [a(0, 100), a(10_000, 0)] }));
    close(deep.engine.tick({ playing: true, timeSec: 7.5 })!.balance, 0.75);
  });

  it("a file marked inverted is taken as is; the invert setting doesn't move balance", () => {
    const t = setup({ mode: "position", invert: true });
    t.engine.setScript(parseFunscript({ inverted: true, actions: [a(0, 100), a(10_000, 0)] }));
    const f = t.engine.tick({ playing: true, timeSec: 2.5 })!;
    close(f.balance, 0.75);
    close(f.intensity, 0.25, 1e-9);
  });

  it("speed = stroke speed / speedFull, in speed and position mode", () => {
    const t = setup();
    t.engine.setScript(steady());
    const f = t.play(10, 1000);
    // 200 u/s over 300
    close(f.speed, 0.667);
    close(f.intensity, 0.667);
    const p = setup({ mode: "position", speedFull: 400 });
    p.engine.setScript(steady());
    close(p.play(10, 1000).speed, 0.5);
  });

  it("speed follows quickly, intensity is smoothed more", () => {
    const t = setup();
    t.engine.setScript(steady());
    const first = t.engine.tick({ playing: true, timeSec: 10 })!;
    assert.equal(first.speed, 0, "both start from 0");
    t.clock.advance(100);
    const f = t.engine.tick({ playing: true, timeSec: 10.1 })!;
    assert.ok(f.speed > f.intensity, `speed ${f.speed} intensity ${f.intensity}`);
  });

  it("has no a / b without mapped axes", () => {
    const t = setup();
    t.engine.setScript(steady());
    const f = t.play(10, 200);
    assert.equal(f.a, undefined);
    assert.equal(f.b, undefined);
  });
});

describe("multi-axis frames", () => {
  it("auto-detects volume, alpha, e1/e2 and pulse_frequency (v2 channels)", () => {
    const t = setup({ mode: "position" });
    t.engine.setScript(
      parseFunscript({
        actions: [a(0, 0), a(60_000, 0)], // stroke: depth 1, balance 1
        channels: {
          VOLUME: flat(40),
          alpha: flat(25),
          e1: flat(60),
          e2: flat(80),
          pulse_frequency: flat(10),
        },
      }),
    );
    const f = t.engine.tick({ playing: true, timeSec: 5 })!;
    close(f.intensity, 0.4, 1e-9);
    close(f.balance, 0.25, 1e-9);
    close(f.a, 0.6, 1e-9);
    close(f.b, 0.8, 1e-9);
    close(f.speed, 0.1, 1e-9);
    const m = t.engine.mapping()!;
    assert.deepEqual(m.targets, { intensity: "volume", balance: "alpha", speed: "pulse_frequency", a: "e1", b: "e2" });
  });

  it("reads v1.1 axes[] and the other auto names", () => {
    const t = setup({ mode: "position" });
    t.engine.setScript(
      parseFunscript({
        actions: [a(0, 0), a(60_000, 0)],
        axes: [
          { id: "channel_a", actions: flat(30).actions },
          { id: "B", actions: flat(70).actions },
          { id: "frequency", actions: flat(90).actions },
        ],
      }),
    );
    const f = t.engine.tick({ playing: true, timeSec: 5 })!;
    close(f.a, 0.3, 1e-9);
    close(f.b, 0.7, 1e-9);
    close(f.speed, 0.9, 1e-9);
    close(f.intensity, 1, 1e-9, );
    assert.equal(t.engine.mapping()!.targets.intensity, "stroke", "unmapped targets fall back to the stroke");
  });

  it("an explicit axisMap replaces auto-detection", () => {
    const t = setup({ mode: "position", axisMap: "level=intensity; left: a, foo=bar" });
    t.engine.setScript(
      parseFunscript({
        actions: [a(0, 0), a(60_000, 0)],
        channels: { level: flat(20), left: flat(50), volume: flat(90), e2: flat(99) },
      }),
    );
    const f = t.engine.tick({ playing: true, timeSec: 5 })!;
    close(f.intensity, 0.2, 1e-9);
    close(f.a, 0.5, 1e-9);
    assert.equal(f.b, undefined, "auto-detection is off while axisMap is set");
    const m = t.engine.mapping()!;
    assert.equal(m.targets.b, undefined);
    assert.equal(m.problems.length, 1);
    assert.match(m.problems[0]!, /foo=bar/);
  });

  it("works without a stroke axis: intensity = max(a, b)", () => {
    const t = setup();
    t.engine.setScript(parseFunscript({ channels: { e1: flat(30), e2: ramp(0, 100) } }));
    assert.equal(t.engine.hasScript(), true);
    const f = t.engine.tick({ playing: true, timeSec: 30 })!;
    close(f.a, 0.3, 1e-9);
    close(f.b, 0.5, 1e-9);
    close(f.intensity, 0.5, 1e-9);
    assert.equal(f.balance, 0.5);
    assert.equal(f.speed, 0);
    assert.equal(t.engine.mapping()!.stroke, false);
  });

  it("is silent without a stroke and without mapped axes", () => {
    const t = setup();
    t.engine.setScript(parseFunscript({ channels: { roll: flat(30) } }));
    assert.equal(t.engine.hasScript(), false);
    assert.equal(t.engine.tick({ playing: true, timeSec: 1 }), null);
    assert.equal(t.engine.mapping(), undefined);
  });

  it("a mapped channel outside its actions is 0; balance / speed fall back to the stroke", () => {
    const t = setup({ mode: "position" });
    t.engine.setScript(
      parseFunscript({
        actions: [a(0, 50), a(60_000, 50)],
        channels: { e1: { actions: [a(10_000, 80), a(20_000, 80)] }, alpha: { actions: [a(10_000, 90), a(20_000, 90)] } },
      }),
    );
    const f = t.engine.tick({ playing: true, timeSec: 30 })!;
    assert.equal(f.a, 0);
    close(f.balance, 0.5, 1e-9);
  });

  it("reapplies the axisMap when the setting changes", () => {
    const t = setup({ mode: "position" });
    t.engine.setScript(parseFunscript({ actions: [a(0, 0), a(60_000, 0)], channels: { x: flat(10) } }));
    assert.equal(t.engine.tick({ playing: true, timeSec: 1 })!.a, undefined);
    t.engine.setSettings({ ...DEFAULT_SETTINGS, mode: "position", axisMap: "x=a" });
    t.clock.advance(50);
    close(t.engine.tick({ playing: true, timeSec: 1.05 })!.a, 0.1, 1e-9);
  });
});

describe("gain", () => {
  it("multiplies intensity, a and b, not balance or speed", () => {
    const t = setup({ mode: "position" }, 0.5);
    t.engine.setScript(
      parseFunscript({
        actions: [a(0, 0), a(60_000, 0)],
        channels: { e1: flat(60), e2: flat(80), alpha: flat(30), pulse_frequency: flat(40) },
      }),
    );
    const f = t.engine.tick({ playing: true, timeSec: 5 })!;
    close(f.intensity, 0.5, 1e-9);
    close(f.a, 0.3, 1e-9);
    close(f.b, 0.4, 1e-9);
    close(f.balance, 0.3, 1e-9);
    close(f.speed, 0.4, 1e-9);
    assert.equal(f.gain, 0.5);
    t.setGain(0);
    const z = t.engine.refresh()!;
    assert.equal(z.intensity, 0);
    assert.equal(z.a, 0);
    assert.equal(z.b, 0);
  });

  it("snap pulses lift intensity and the direct channels, times gain", () => {
    const t = setup({ mode: "position" }, 0.5);
    t.engine.setScript(
      parseFunscript({
        actions: [a(0, 100), a(60_000, 100)],
        channels: { e1: flat(10), snap: { actions: [a(0, 0), a(2000, 100), a(2100, 0)] } },
      }),
    );
    let peak: DriveFrame | undefined;
    for (let w = 0; w <= 1000; w += 50) {
      const f = t.engine.tick({ playing: true, timeSec: 1.6 + w / 1000 })!;
      if (!peak || f.intensity > peak.intensity) peak = f;
      t.clock.advance(50);
    }
    close(peak!.intensity, 0.5, 1e-9);
    close(peak!.a, 0.5, 1e-9);
  });
});

describe("per-device frames and the scene offset", () => {
  it("builds a frame per mapped kind next to the default frame", () => {
    const sent: [DriveFrame | null, ReadonlyMap<string, DriveFrame> | undefined][] = [];
    const clock = new FakeClock();
    const engine = createSyncEngine({ output: { drive: (f, k) => sent.push([f, k]) }, now: clock.now, timers: clock });
    engine.setSettings({ ...DEFAULT_SETTINGS, mode: "position" });
    engine.setScript(parseFunscript({ actions: [a(0, 0), a(60_000, 0)], channels: { roll: flat(30) } }));
    engine.setDeviceMappings(new Map([["lovense", { roll: { target: "intensity" }, stroke: { target: "off" } }]]));
    const f = engine.tick({ playing: true, timeSec: 5 })!;
    close(f.intensity, 1, 1e-9);
    close(engine.frameFor("lovense")!.intensity, 0.3, 1e-9);
    assert.equal(engine.frameFor("coyote-v3"), f);
    engine.test(100);
    assert.equal(sent.at(-1)![1], undefined, "the test pulse goes to everyone");
    engine.stop();
    assert.deepEqual(sent.at(-1), [null, undefined]);
  });

  it("adds the scene offset to the video time", () => {
    const t = setup({ mode: "position" });
    t.engine.setScript(parseFunscript({ actions: [a(0, 100), a(10_000, 0)] }));
    t.engine.setOffsetMs(2500);
    close(t.engine.tick({ playing: true, timeSec: 5 })!.intensity, 0.75, 1e-9);
  });
});
