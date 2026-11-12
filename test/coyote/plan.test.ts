import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Calibration } from "../../src/devices/types.ts";
import {
  burstOn,
  channelSplit,
  computePlan,
  NUDGE_TOTAL_MS,
  nudgeOn,
  slotsFrom,
  speedHz,
  speedRange,
  type PlanInput,
} from "../../src/coyote/plan.ts";
import { DEFAULT_SETTINGS } from "../../src/sync/settings.ts";
import { CAL } from "./fakes.ts";


const base = (over: Partial<PlanInput> = {}): PlanInput => ({ now: 1000, calibration: CAL, speed: { minHz: 10, maxHz: 100 }, ...over });

describe("speedRange", () => {
  it("defaults to 10..100 Hz when the settings don't have the fields", () => {
    assert.deepEqual(speedRange(DEFAULT_SETTINGS), { minHz: 10, maxHz: 100 });
    assert.deepEqual(speedRange(undefined), { minHz: 10, maxHz: 100 });
  });

  it("reads estimSpeedMinHz / estimSpeedMaxHz, clamped to 1..200 with min < max", () => {
    assert.deepEqual(speedRange({ ...DEFAULT_SETTINGS, estimSpeedMinHz: 5, estimSpeedMaxHz: 150 } as never), { minHz: 5, maxHz: 150 });
    assert.deepEqual(speedRange({ estimSpeedMinHz: 0, estimSpeedMaxHz: 999 }), { minHz: 1, maxHz: 200 });
    assert.deepEqual(speedRange({ estimSpeedMinHz: 80, estimSpeedMaxHz: 20 }), { minHz: 20, maxHz: 80 });
    assert.deepEqual(speedRange({ estimSpeedMinHz: 50, estimSpeedMaxHz: 50 }), { minHz: 50, maxHz: 51 });
    assert.deepEqual(speedRange({ estimSpeedMinHz: 300, estimSpeedMaxHz: 300 }), { minHz: 199, maxHz: 200 });
    assert.deepEqual(speedRange({ estimSpeedMinHz: "x", estimSpeedMaxHz: NaN }), { minHz: 10, maxHz: 100 });
  });

  it("maps speed 0..1 linearly", () => {
    const r = { minHz: 10, maxHz: 100 };
    assert.equal(speedHz(0, r), 10);
    assert.equal(speedHz(1, r), 100);
    assert.equal(speedHz(0.5, r), 55);
    assert.equal(speedHz(7, r), 100);
  });
});

describe("channelSplit", () => {
  it("splits intensity by balance, doubled and capped at 1", () => {
    assert.deepEqual(channelSplit({ intensity: 1, balance: 0.5, speed: 0 }), { a: 1, b: 1 });
    assert.deepEqual(channelSplit({ intensity: 0.4, balance: 0.5, speed: 0 }), { a: 0.4, b: 0.4 });
    assert.deepEqual(channelSplit({ intensity: 1, balance: 0, speed: 0 }), { a: 1, b: 0 });
    assert.deepEqual(channelSplit({ intensity: 1, balance: 1, speed: 0 }), { a: 0, b: 1 });
    const s = channelSplit({ intensity: 0.5, balance: 0.25, speed: 0 });
    assert.equal(s.a, 0.75);
    assert.equal(s.b, 0.25);
  });

  it("prefers the explicit channels, each on its own", () => {
    assert.deepEqual(channelSplit({ intensity: 1, balance: 0.5, speed: 0, a: 0.2 }), { a: 0.2, b: 1 });
    assert.deepEqual(channelSplit({ intensity: 1, balance: 0.5, speed: 0, a: 0, b: 1.5 }), { a: 0, b: 1 });
  });
});

describe("nudge timeline", () => {
  it("is 3 × 120 ms on with 150 ms gaps", () => {
    assert.equal(NUDGE_TOTAL_MS, 660);
    const on = [0, 119, 270, 389, 540, 659];
    const off = [-1, 120, 269, 390, 539, 660, 800];
    for (const t of on) assert.equal(nudgeOn(t), true, `on at ${t}`);
    for (const t of off) assert.equal(nudgeOn(t), false, `off at ${t}`);
  });

  it("renders into 25 ms slots", () => {
    assert.deepEqual(slotsFrom(0, nudgeOn), [100, 100, 100, 100]);
    assert.deepEqual(slotsFrom(100, nudgeOn), [100, 0, 0, 0]);
    assert.deepEqual(slotsFrom(200, nudgeOn), [0, 0, 0, 100]);
    assert.deepEqual(slotsFrom(500, nudgeOn), [0, 0, 100, 100]);
    assert.deepEqual(slotsFrom(600, nudgeOn), [100, 100, 100, 0]);
  });

  it("repeats for the burst probe", () => {
    assert.equal(burstOn(0), true);
    assert.equal(burstOn(700), false);
    assert.equal(burstOn(810), true);
    assert.equal(burstOn(810 + 270), true);
    assert.equal(burstOn(810 + 125), false);
  });
});

describe("computePlan", () => {
  it("is idle without anything to do", () => {
    const p = computePlan(base());
    assert.equal(p.source, "idle");
    assert.equal(p.active, false);
    assert.equal(p.a.level, 0);
    assert.deepEqual(p.limits, { a: 100, b: 90 });
  });

  it("drives levels via levelFor within [firstFelt, comfortMax] and frequency from speed", () => {
    const p = computePlan(base({ frame: { frame: { intensity: 1, balance: 0.5, speed: 0 }, at: 1000 } }));
    assert.equal(p.source, "drive");
    assert.equal(p.active, true);
    assert.equal(p.a.level, 60);
    assert.equal(p.b.level, 50);
    assert.equal(p.a.periodMs, 100);
    assert.equal(p.a.sharp, false);
    assert.deepEqual(p.a.slots, [100, 100, 100, 100]);
    const half = computePlan(base({ frame: { frame: { intensity: 0.25, balance: 0.5, speed: 1 }, at: 1000 } }));
    assert.equal(half.a.level, 30); // 20 + 0.25 × 40
    assert.equal(half.b.level, 20);
    assert.equal(half.a.periodMs, 10);
  });

  it("is silent for a tiny intensity and inactive", () => {
    const p = computePlan(base({ frame: { frame: { intensity: 0.004, balance: 0.5, speed: 0 }, at: 1000 } }));
    assert.equal(p.a.level, 0);
    assert.deepEqual(p.a.slots, [0, 0, 0, 0]);
    assert.equal(p.active, false);
  });

  it("drops a frame older than 300 ms (watchdog)", () => {
    const f = { frame: { intensity: 1, balance: 0.5, speed: 0 }, at: 1000 };
    assert.equal(computePlan(base({ now: 1300, frame: f })).source, "drive");
    assert.equal(computePlan(base({ now: 1301, frame: f })).source, "idle");
  });

  it("outputs nothing at all without a calibration (except probes)", () => {
    const p = computePlan(base({ calibration: undefined, frame: { frame: { intensity: 1, balance: 0.5, speed: 0 }, at: 1000 }, nudge: { start: 1000 }, test: { start: 1000 } }));
    assert.equal(p.a.level, 0);
    assert.equal(p.b.level, 0);
    assert.deepEqual(p.limits, { a: 200, b: 200 });
  });

  it("leaves an uncalibrated channel B silent", () => {
    const cal: Calibration = { a: CAL.a, updatedAt: "" };
    const p = computePlan(base({ calibration: cal, frame: { frame: { intensity: 1, balance: 0.5, speed: 0 }, at: 1000 }, nudge: undefined }));
    assert.equal(p.a.level, 60);
    assert.equal(p.b.level, 0);
    assert.equal(p.limits.b, 200);
  });

  it("nudges every calibrated channel at its nudge level, 100 Hz, sharp, with the pattern in the slots", () => {
    const p = computePlan(base({ now: 1100, nudge: { start: 1000 }, frame: { frame: { intensity: 1, balance: 0.5, speed: 0 }, at: 1100 } }));
    assert.equal(p.source, "nudge");
    assert.equal(p.a.level, 80);
    assert.equal(p.b.level, 70);
    assert.equal(p.a.periodMs, 10);
    assert.equal(p.a.sharp, true);
    assert.deepEqual(p.a.slots, [100, 0, 0, 0]);
    // after 660 ms back to the frame
    assert.equal(computePlan(base({ now: 1660, nudge: { start: 1000 }, frame: { frame: { intensity: 1, balance: 0.5, speed: 0 }, at: 1660 } })).source, "drive");
  });

  it("never nudges above hardMax", () => {
    const cal = { a: { firstFelt: 1, comfortMax: 2, nudge: 250, hardMax: 9 }, updatedAt: "" } as Calibration;
    assert.equal(computePlan(base({ calibration: cal, nudge: { start: 1000 } })).a.level, 9);
  });

  it("tests at the middle of [firstFelt, comfortMax] at 50 Hz for 1 s", () => {
    const p = computePlan(base({ test: { start: 500 } }));
    assert.equal(p.source, "test");
    assert.equal(p.a.level, 40);
    assert.equal(p.b.level, 30);
    assert.equal(p.a.periodMs, 20);
    assert.equal(computePlan(base({ test: { start: 0 } })).source, "idle");
  });

  it("probes one channel up to 200 with that channel's soft limit lifted", () => {
    const p = computePlan(base({ probe: { channel: "b", level: 150, kind: "steady", start: 900, at: 1000 } }));
    assert.equal(p.source, "probe");
    assert.equal(p.a.level, 0);
    assert.equal(p.b.level, 150);
    assert.equal(p.b.periodMs, 20);
    assert.deepEqual(p.limits, { a: 100, b: 200 });
    assert.equal(computePlan(base({ probe: { channel: "a", level: 999, kind: "steady", start: 0, at: 1000 } })).a.level, 200);
    // works uncalibrated too
    assert.equal(computePlan(base({ calibration: undefined, probe: { channel: "a", level: 30, kind: "steady", start: 0, at: 1000 } })).a.level, 30);
  });

  it("repeats the burst pattern in a burst probe and stops a stale probe", () => {
    const p = computePlan(base({ probe: { channel: "a", level: 50, kind: "burst", start: 900, at: 1000 } }));
    assert.equal(p.a.sharp, true);
    assert.equal(p.a.periodMs, 10);
    assert.deepEqual(p.a.slots, [100, 0, 0, 0]);
    assert.equal(computePlan(base({ now: 1301, probe: { channel: "a", level: 50, kind: "burst", start: 900, at: 1000 } })).source, "idle");
  });
});
