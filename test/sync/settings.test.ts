import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS, parseSettings } from "../../src/sync/settings.ts";

describe("parseSettings", () => {
  it("defaults everything", () => {
    assert.deepEqual(parseSettings({}), DEFAULT_SETTINGS);
    assert.deepEqual(parseSettings(undefined), DEFAULT_SETTINGS);
    assert.deepEqual(DEFAULT_SETTINGS, {
      mode: "speed",
      strength: 100,
      speedFull: 300,
      minLevel: 0,
      latencyMs: 0,
      invert: false,
      snapPulse: true,
      namePrefix: "",
      axisMap: "",
      nudgeCooldownSec: 4,
      nudgesPerMinute: 6,
      estimSpeedMinHz: 10,
      estimSpeedMaxHz: 100,
    });
  });

  it("reads valid values", () => {
    assert.deepEqual(
      parseSettings({
        mode: "position",
        strength: 60,
        speedFull: 450,
        minLevel: 3,
        latencyMs: 120,
        invert: true,
        snapPulse: false,
        namePrefix: " LVS-Mine ",
      }),
      { ...DEFAULT_SETTINGS, mode: "position", strength: 60, speedFull: 450, minLevel: 3, latencyMs: 120, invert: true, snapPulse: false, namePrefix: "LVS-Mine" },
    );
  });

  it("is lenient with strings and case", () => {
    const s = parseSettings({ mode: " Position ", strength: "50 %", speedFull: "250,5", minLevel: "2", latencyMs: "-40", invert: "true", snapPulse: "false" });
    assert.equal(s.mode, "position");
    assert.equal(s.strength, 50);
    assert.equal(s.speedFull, 250.5);
    assert.equal(s.minLevel, 2);
    assert.equal(s.latencyMs, -40);
    assert.equal(s.invert, true);
    assert.equal(s.snapPulse, false);
  });

  it("falls back or clamps out-of-range values", () => {
    const s = parseSettings({ mode: "wobble", strength: 250, speedFull: 0, minLevel: 99, latencyMs: 60000, invert: "maybe", snapPulse: 3 });
    assert.equal(s.mode, "speed");
    assert.equal(s.strength, 100);
    assert.equal(s.speedFull, 300);
    assert.equal(s.minLevel, 20);
    assert.equal(s.latencyMs, 5000);
    assert.equal(s.invert, false);
    assert.equal(s.snapPulse, true);
    assert.equal(parseSettings({ strength: -5 }).strength, 0);
    assert.equal(parseSettings({ minLevel: 2.6 }).minLevel, 3);
    assert.equal(parseSettings({ speedFull: -10 }).speedFull, 300);
    assert.equal(parseSettings({ strength: "abc" }).strength, 100);
    assert.equal(parseSettings({ strength: Number.NaN }).strength, 100);
  });

  it("reads the multi-device settings", () => {
    const s = parseSettings({ axisMap: " volume=intensity, e1=a ", nudgeCooldownSec: "6", nudgesPerMinute: 3, estimSpeedMinHz: 5, estimSpeedMaxHz: "80" });
    assert.equal(s.axisMap, "volume=intensity, e1=a");
    assert.equal(s.nudgeCooldownSec, 6);
    assert.equal(s.nudgesPerMinute, 3);
    assert.equal(s.estimSpeedMinHz, 5);
    assert.equal(s.estimSpeedMaxHz, 80);
  });

  it("keeps the nudge limits within bounds", () => {
    assert.equal(parseSettings({ nudgeCooldownSec: 0.5 }).nudgeCooldownSec, 2);
    assert.equal(parseSettings({ nudgesPerMinute: 50 }).nudgesPerMinute, 10);
    assert.equal(parseSettings({ nudgesPerMinute: -1 }).nudgesPerMinute, 0);
    assert.equal(parseSettings({ nudgesPerMinute: 0 }).nudgesPerMinute, 0);
  });

  it("falls back to the default e-stim range when it is crossed", () => {
    const s = parseSettings({ estimSpeedMinHz: 120, estimSpeedMaxHz: 20 });
    assert.equal(s.estimSpeedMinHz, 10);
    assert.equal(s.estimSpeedMaxHz, 100);
    assert.equal(parseSettings({ estimSpeedMinHz: 0 }).estimSpeedMinHz, 1);
    assert.equal(parseSettings({ estimSpeedMaxHz: 5000 }).estimSpeedMaxHz, 1000);
  });
});
