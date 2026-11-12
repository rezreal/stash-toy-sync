import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createProbeSession, PROBE_TICK_MS, RAMP_MS, rampLevel } from "../../src/pages/probe.ts";
import { FakeClock } from "../fakes/clock.ts";
import { FakeDevice } from "../fakes/device.ts";

describe("rampLevel", () => {
  it("climbs to the target over the ramp time and drops at once", () => {
    assert.equal(rampLevel(0, 100, 500), 50);
    assert.equal(rampLevel(90, 100, 500), 100);
    assert.equal(rampLevel(80, 30, 50), 30);
    assert.equal(rampLevel(0, 100, 50, 0), 100);
    assert.equal(rampLevel(10, -5, 50), 0);
  });
});

describe("probe session", () => {
  function setup(kind: "steady" | "burst" = "steady") {
    const clock = new FakeClock();
    const dev = new FakeDevice();
    const levels: number[] = [];
    const s = createProbeSession(dev, { channel: "b", kind, timers: clock, onLevel: (l) => levels.push(l) });
    return { clock, dev, s, levels };
  }

  it("ramps from 0 to the level over ~1 s while held, then holds it", () => {
    const t = setup();
    t.s.start(80);
    assert.deepEqual(t.dev.probes[0], { channel: "b", level: 0, kind: "steady", active: true });
    t.clock.advance(RAMP_MS / 2);
    const mid = t.dev.probes.at(-1)!;
    assert.ok(mid.level >= 38 && mid.level <= 42, `half way: ${mid.level}`);
    t.clock.advance(RAMP_MS / 2);
    assert.equal(t.dev.probes.at(-1)!.level, 80);
    t.clock.advance(500);
    assert.equal(t.dev.probes.at(-1)!.level, 80);
    // never a jump: each step at most target × tick / ramp
    for (let i = 1; i < t.dev.probes.length; i++) {
      assert.ok(t.dev.probes[i]!.level - t.dev.probes[i - 1]!.level <= Math.ceil((80 * PROBE_TICK_MS) / RAMP_MS) + 1);
    }
  });

  it("stops at once on release and outputs nothing after", () => {
    const t = setup("burst");
    t.s.start(50);
    t.clock.advance(300);
    t.s.stop();
    assert.deepEqual(t.dev.probes.at(-1), { channel: "b", level: 0, kind: "burst", active: false });
    const n = t.dev.probes.length;
    t.clock.advance(2000);
    assert.equal(t.dev.probes.length, n);
    assert.equal(t.clock.pending, 0);
    assert.equal(t.levels.at(-1), 0);
    t.s.stop();
    assert.equal(t.dev.probes.length, n, "stop() when released sends nothing");
  });

  it("follows a target change: up gently, down at once", () => {
    const t = setup();
    t.s.start(40);
    t.clock.advance(RAMP_MS);
    t.s.setTarget(10);
    t.clock.advance(PROBE_TICK_MS);
    assert.equal(t.dev.probes.at(-1)!.level, 10);
    t.s.setTarget(100);
    t.clock.advance(PROBE_TICK_MS);
    assert.ok(t.dev.probes.at(-1)!.level <= 16);
  });

  it("never asks above the device range", () => {
    const t = setup();
    t.s.start(5000);
    t.clock.advance(3000);
    assert.equal(Math.max(...t.dev.probes.map((p) => p.level)), 200);
  });

  it("ignores a second start while held", () => {
    const t = setup();
    t.s.start(40);
    t.clock.advance(500);
    const before = t.dev.probes.at(-1)!.level;
    t.s.start(40);
    t.clock.advance(PROBE_TICK_MS);
    assert.ok(t.dev.probes.at(-1)!.level >= before, "no restart from 0");
    assert.equal(t.s.active(), true);
  });
});
