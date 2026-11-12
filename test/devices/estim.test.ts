import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { channelIntensities, channelLevels, estimFrequencyHz } from "../../src/devices/estim.ts";
import { DEFAULT_SETTINGS } from "../../src/sync/settings.ts";

const close = (x: number, y: number) => assert.ok(Math.abs(x - y) < 1e-9, `${x} ≉ ${y}`);

describe("e-stim helpers", () => {
  it("pans intensity by balance, full strength at the centre", () => {
    assert.deepEqual(channelIntensities({ intensity: 0.8, balance: 0, speed: 0 }), { a: 0.8, b: 0 });
    assert.deepEqual(channelIntensities({ intensity: 0.8, balance: 1, speed: 0 }), { a: 0, b: 0.8 });
    assert.deepEqual(channelIntensities({ intensity: 0.8, balance: 0.5, speed: 0 }), { a: 0.8, b: 0.8 });
    const q = channelIntensities({ intensity: 1, balance: 0.75, speed: 0 });
    close(q.a, 0.5);
    close(q.b, 1);
  });

  it("direct channels replace intensity × balance for their channel", () => {
    assert.deepEqual(channelIntensities({ intensity: 1, balance: 0, speed: 0, b: 0.3 }), { a: 1, b: 0.3 });
    assert.deepEqual(channelIntensities({ intensity: 0, balance: 0.5, speed: 0, a: 2, b: -1 }), { a: 1, b: 0 });
  });

  it("maps channels onto calibrated levels, 0 without a calibration", () => {
    const cal = { a: { firstFelt: 10, comfortMax: 50, nudge: 60, hardMax: 70 }, updatedAt: "" };
    assert.deepEqual(channelLevels({ intensity: 0.5, balance: 0.5, speed: 0 }, cal), { a: 30, b: 0 });
    assert.deepEqual(channelLevels(null, cal), { a: 0, b: 0 });
    assert.deepEqual(channelLevels({ intensity: 1, balance: 0.5, speed: 0 }, undefined), { a: 0, b: 0 });
    const both = { ...cal, b: { firstFelt: 0, comfortMax: 100, nudge: 110, hardMax: 120 } };
    assert.deepEqual(channelLevels({ intensity: 0, balance: 0.5, speed: 0, a: 1, b: 0.25 }, both), { a: 50, b: 25 });
  });

  it("maps speed onto the e-stim frequency range", () => {
    assert.equal(estimFrequencyHz(0, DEFAULT_SETTINGS), 10);
    assert.equal(estimFrequencyHz(1, DEFAULT_SETTINGS), 100);
    assert.equal(estimFrequencyHz(0.5, { estimSpeedMinHz: 20, estimSpeedMaxHz: 60 }), 40);
    assert.equal(estimFrequencyHz(5, DEFAULT_SETTINGS), 100);
  });
});
