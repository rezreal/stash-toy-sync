import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createSnapPulser, SNAP_PULSE_MS } from "../../src/sync/snapPulse.ts";

const a = (at: number, pos: number) => ({ at, pos });

/** plays from fromMs to toMs in 50 ms ticks; returns the wall times with pulse output */
function play(p: ReturnType<typeof createSnapPulser>, fromMs: number, toMs: number, wall0 = fromMs) {
  const on: number[] = [];
  for (let t = fromMs + 50; t <= toMs; t += 50) {
    const wall = wall0 + (t - fromMs);
    if (p.step((t - 50) / 1000, t / 1000, wall) > 0) on.push(wall);
  }
  return on;
}

describe("snap pulses", () => {
  it("pulses for 300 ms after each rising edge", () => {
    const p = createSnapPulser([a(0, 0), a(1000, 100), a(1100, 0), a(3000, 100), a(3100, 0)]);
    const on = play(p, 0, 4000);
    // crossing 1000 is seen at the tick ending 1050
    assert.equal(on[0], 1050);
    assert.ok(on.includes(1050 + SNAP_PULSE_MS - 50));
    assert.ok(!on.includes(1050 + SNAP_PULSE_MS));
    assert.equal(on.filter((t) => t < 2000).length, SNAP_PULSE_MS / 50);
    assert.ok(on.includes(3050));
  });

  it("starts at most 3 pulses per second", () => {
    // a snap every 100 ms for 2 s
    const acts = [];
    for (let t = 0; t < 2000; t += 100) acts.push(a(t, 100), a(t + 50, 0));
    let starts = 0;
    const p = createSnapPulser(acts, { pulseMs: 10 });
    for (let t = 50; t <= 2000; t += 50) {
      if (p.step((t - 50) / 1000, t / 1000, t) > 0) starts++;
    }
    // each accepted pulse lasts 10 ms < one tick, so outputs = starts
    assert.ok(starts <= 6, `${starts} pulses in 2 s`);
    assert.ok(starts >= 5, `${starts} pulses in 2 s`);
    // and never 4 within any second
    const p2 = createSnapPulser(acts, { pulseMs: 10 });
    const times: number[] = [];
    for (let t = 50; t <= 2000; t += 50) if (p2.step((t - 50) / 1000, t / 1000, t) > 0) times.push(t);
    for (const t of times) assert.ok(times.filter((x) => x >= t && x < t + 1000).length <= 3);
  });

  it("seeking doesn't fire the snaps jumped over", () => {
    const p = createSnapPulser([a(1000, 100), a(1100, 0), a(2000, 100), a(2100, 0)]);
    assert.equal(p.step(0, 5, 0), 0);
    assert.equal(p.step(5, 0.5, 50), 0);
    assert.equal(p.step(0.5, 0.55, 100), 0);
  });

  it("reset ends a running pulse", () => {
    const p = createSnapPulser([a(100, 100), a(200, 0)]);
    assert.equal(p.step(0.05, 0.15, 150), 1);
    p.reset();
    assert.equal(p.step(0.15, 0.2, 200), 0);
  });
});
