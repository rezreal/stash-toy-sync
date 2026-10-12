import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseFunscript } from "../../src/funscript/parse.ts";
import {
  createSmoother,
  levelFor,
  positionAt,
  positionIntensity,
  segmentIndex,
  speedIntensity,
  strokeScript,
} from "../../src/sync/mapping.ts";

const a = (at: number, pos: number) => ({ at, pos });
const close = (x: number, y: number, eps = 1e-9) => assert.ok(Math.abs(x - y) < eps, `${x} ≉ ${y}`);

describe("speedIntensity", () => {
  const acts = [a(1000, 0), a(1500, 100), a(2000, 100), a(3000, 0)];
  it("is |Δpos| / Δt / speedFull for the surrounding segment", () => {
    // 100 units in 0.5 s = 200 u/s
    close(speedIntensity(acts, 1200, 300), 200 / 300);
    close(speedIntensity(acts, 1200, 100), 1); // clamped
    // 100 units in 1 s
    close(speedIntensity(acts, 2500, 300), 100 / 300);
    // at an action's time the segment starting there applies
    close(speedIntensity(acts, 1000, 300), 200 / 300);
  });
  it("is 0 before the first, after the last action and on flat segments", () => {
    assert.equal(speedIntensity(acts, 999, 300), 0);
    assert.equal(speedIntensity(acts, 3000, 300), 0);
    assert.equal(speedIntensity(acts, 5000, 300), 0);
    assert.equal(speedIntensity(acts, 1700, 300), 0);
    assert.equal(speedIntensity([], 0, 300), 0);
    assert.equal(speedIntensity([a(0, 50)], 0, 300), 0);
  });
  it("skips zero-length steps", () => {
    close(speedIntensity([a(0, 0), a(0, 50), a(1000, 100)], 0, 100), 0.5);
  });
});

describe("position mode", () => {
  it("interpolates the position, undefined outside the script", () => {
    const acts = [a(0, 100), a(1000, 0)];
    assert.equal(positionAt(acts, 500), 50);
    assert.equal(positionAt(acts, 0), 100);
    assert.equal(positionAt(acts, 1000), 0);
    assert.equal(positionAt(acts, -1), undefined);
    assert.equal(positionAt(acts, 1001), undefined);
    assert.equal(segmentIndex(acts, -5), -1);
  });
  it("maps depth = 100 - pos (pos 100 = out); inverted files are taken as is; invert flips", () => {
    const s = strokeScript(parseFunscript({ actions: [a(0, 100), a(1000, 0)] }));
    close(positionIntensity(s, 0, false), 0);
    close(positionIntensity(s, 250, false), 0.25);
    close(positionIntensity(s, 1000, false), 1);
    close(positionIntensity(s, 250, true), 0.75);
    assert.equal(positionIntensity(s, 2000, false), 0);
    const inv = strokeScript(parseFunscript({ inverted: true, actions: [a(0, 100), a(1000, 0)] }));
    close(positionIntensity(inv, 250, false), 0.75);
    close(positionIntensity(inv, 250, true), 0.25);
  });
  it("applies the file's range", () => {
    const s = strokeScript(parseFunscript({ range: 90, actions: [a(0, 90), a(1000, 45)] }));
    assert.deepEqual(s.actions, [a(0, 100), a(1000, 50)]);
    close(positionIntensity(s, 1000, false), 0.5);
  });
});

describe("levelFor", () => {
  const p = { strength: 100, gain: 1, minLevel: 0 };
  it("is round(20 × intensity × strength × gain)", () => {
    assert.equal(levelFor(1, p), 20);
    assert.equal(levelFor(0.5, p), 10);
    assert.equal(levelFor(0.5, { ...p, strength: 50 }), 5);
    assert.equal(levelFor(1, { ...p, gain: 0.25 }), 5);
    assert.equal(levelFor(1, { ...p, strength: 50, gain: 0.5 }), 5);
    assert.equal(levelFor(0.33, p), 7);
  });
  it("clamps inputs", () => {
    assert.equal(levelFor(3, p), 20);
    assert.equal(levelFor(-1, p), 0);
    assert.equal(levelFor(1, { ...p, strength: 400, gain: 9 }), 20);
    assert.equal(levelFor(Number.NaN, p), 0);
  });
  it("is 0 with gain or strength 0", () => {
    assert.equal(levelFor(1, { ...p, gain: 0 }), 0);
    assert.equal(levelFor(1, { ...p, strength: 0, minLevel: 5 }), 0);
  });
  it("raises any intensity to minLevel, but not above the strength cap, and keeps 0 at 0", () => {
    const m = { ...p, minLevel: 6 };
    assert.equal(levelFor(0.05, m), 6);
    assert.equal(levelFor(0.9, m), 18);
    assert.equal(levelFor(0, m), 0);
    assert.equal(levelFor(0.001, m), 0, "the smoothing tail counts as none");
    assert.equal(levelFor(0.05, { ...m, strength: 20 }), 4, "the strength cap wins");
  });
});

describe("createSmoother", () => {
  it("eases towards the input with a ~150 ms time constant", () => {
    const s = createSmoother(150);
    assert.equal(s.next(0, 0), 0);
    // a short spike only moves it part of the way
    const v = s.next(1, 50);
    close(v, 1 - Math.exp(-50 / 150));
    assert.ok(v < 0.3);
    let y = v;
    for (let t = 100; t <= 1000; t += 50) y = s.next(1, t);
    assert.ok(y > 0.99);
  });
  it("is frame-rate independent", () => {
    const a1 = createSmoother(150);
    const a2 = createSmoother(150);
    a1.next(0, 0);
    a2.next(0, 0);
    a2.next(1, 50);
    close(a1.next(1, 100), a2.next(1, 100), 1e-12);
  });
  it("can start from a fixed value instead of the first input", () => {
    const s = createSmoother(150, 0);
    assert.equal(s.next(1, 0), 0);
    close(s.next(1, 50), 1 - Math.exp(-50 / 150));
    s.reset();
    assert.equal(s.next(1, 100), 0);
    assert.equal(s.next(1, 5000), 0, "a gap restarts from the initial value too");
  });

  it("restarts after a gap or a reset", () => {
    const s = createSmoother(150);
    s.next(0, 0);
    assert.equal(s.next(1, 5000), 1);
    s.reset();
    assert.equal(s.next(0.3, 5050), 0.3);
  });
});
