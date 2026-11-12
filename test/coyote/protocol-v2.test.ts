import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_MAX_POWER,
  decodeStrength,
  decodeWave,
  encodeStrength,
  encodeWave,
  levelToRaw,
  parseBattery,
  parseMaxPower,
  rawToLevelFloor,
  readLe24,
  SILENT_WAVE,
  V2_BATTERY,
  V2_BATTERY_SERVICE,
  V2_SERVICE,
  V2_STRENGTH,
  V2_WAVE_A,
  V2_WAVE_B,
  waveCharacteristic,
  waveForPeriod,
} from "../../src/coyote/protocol-v2.ts";

const arr = (u: Uint8Array) => Array.from(u);

describe("Coyote 2.0 UUIDs", () => {
  it("are lowercase full UUIDs on the 955Axxxx base", () => {
    assert.equal(V2_SERVICE, "955a180b-0fe2-f5aa-a094-84b8d4f3e8ad");
    assert.equal(V2_BATTERY_SERVICE, "955a180a-0fe2-f5aa-a094-84b8d4f3e8ad");
    assert.equal(V2_BATTERY, "955a1500-0fe2-f5aa-a094-84b8d4f3e8ad");
    assert.equal(V2_STRENGTH, "955a1504-0fe2-f5aa-a094-84b8d4f3e8ad");
  });

  it("maps channel A to 1506 and B to 1505", () => {
    assert.equal(waveCharacteristic("a"), V2_WAVE_A);
    assert.equal(waveCharacteristic("b"), V2_WAVE_B);
    assert.ok(V2_WAVE_A.startsWith("955a1506"));
    assert.ok(V2_WAVE_B.startsWith("955a1505"));
  });
});

describe("Coyote 2.0 strength packet", () => {
  it("is (A << 11) | B, 3 bytes little-endian", () => {
    // A = 1, B = 0 -> 0x000800
    assert.deepEqual(arr(encodeStrength(1, 0)), [0x00, 0x08, 0x00]);
    // A = 0, B = 0x7ff
    assert.deepEqual(arr(encodeStrength(0, 2047)), [0xff, 0x07, 0x00]);
    // A = 2047, B = 2047 -> 0x3fffff
    assert.deepEqual(arr(encodeStrength(2047, 2047)), [0xff, 0xff, 0x3f]);
    // A = 420, B = 280 -> 420 * 2048 + 280 = 860440 = 0x0d2118
    assert.deepEqual(arr(encodeStrength(420, 280)), [0x18, 0x21, 0x0d]);
    assert.deepEqual(decodeStrength([0x18, 0x21, 0x0d]), { a: 420, b: 280 });
  });

  it("clamps to 0..2047", () => {
    assert.deepEqual(decodeStrength(encodeStrength(5000, -3)), { a: 2047, b: 0 });
    assert.deepEqual(decodeStrength(encodeStrength(NaN, 12.4)), { a: 0, b: 12 });
    assert.equal(decodeStrength([1, 2]), undefined);
  });
});

describe("Coyote 2.0 waveform packet", () => {
  it("is (Z << 15) | (Y << 5) | X, 3 bytes little-endian", () => {
    // X = 1, Y = 9, Z = 20 -> 20 * 32768 + 9 * 32 + 1 = 655649 = 0x0a0121
    assert.deepEqual(arr(encodeWave({ x: 1, y: 9, z: 20 })), [0x21, 0x01, 0x0a]);
    assert.deepEqual(decodeWave([0x21, 0x01, 0x0a]), { x: 1, y: 9, z: 20 });
    assert.equal(readLe24([0x21, 0x01, 0x0a]), 655649);
  });

  it("clamps X, Y, Z to their bit widths", () => {
    assert.deepEqual(decodeWave(encodeWave({ x: 99, y: 5000, z: 40 })), { x: 31, y: 1023, z: 31 });
    assert.deepEqual(decodeWave(encodeWave({ x: -1, y: -1, z: -1 })), { x: 0, y: 0, z: 0 });
  });

  it("splits a period into X = round(sqrt(period/1000) × 15) and Y = period − X", () => {
    assert.deepEqual(waveForPeriod(10, 20), { x: 2, y: 8, z: 20 }); // 100 Hz: 1.5 rounds to 2
    assert.deepEqual(waveForPeriod(100, 12), { x: 5, y: 95, z: 12 }); // 10 Hz: 4.74
    assert.deepEqual(waveForPeriod(20, 12), { x: 2, y: 18, z: 12 }); // 50 Hz: 2.12
    assert.deepEqual(waveForPeriod(1000, 12), { x: 15, y: 985, z: 12 });
    // periods outside 10..1000 are clamped
    assert.deepEqual(waveForPeriod(5, 12), waveForPeriod(10, 12));
    assert.deepEqual(waveForPeriod(4000, 12), waveForPeriod(1000, 12));
    for (const p of [10, 33, 100, 333, 999, 1000]) {
      const w = waveForPeriod(p, 12);
      assert.equal(w.x + w.y, p);
      assert.ok(w.x >= 1 && w.x <= 31);
    }
  });

  it("has a valid silent waveform (zero pulse width)", () => {
    assert.equal(SILENT_WAVE.z, 0);
    assert.equal(SILENT_WAVE.x + SILENT_WAVE.y, 100);
  });
});

describe("Coyote 2.0 levels", () => {
  it("reads max power from 1507 bytes 1–2 (11 bits)", () => {
    // step 7, max 1400 = 0x0578
    assert.equal(parseMaxPower([7, 0x78, 0x05]), 1400);
    // max 2000 = 0x07d0, upper bits beyond 11 ignored
    assert.equal(parseMaxPower([7, 0xd0, 0xf7]), 2000);
  });

  it("falls back to 1400 when 1507 is missing or implausible", () => {
    assert.equal(parseMaxPower(undefined), DEFAULT_MAX_POWER);
    assert.equal(parseMaxPower([7, 0x05]), DEFAULT_MAX_POWER);
    assert.equal(parseMaxPower([7, 100, 0]), DEFAULT_MAX_POWER);
    assert.equal(parseMaxPower([7, 0, 0]), DEFAULT_MAX_POWER);
  });

  it("maps level 0..200 to round(level / 200 × maxPower), never above 2047", () => {
    assert.equal(levelToRaw(0, 1400), 0);
    assert.equal(levelToRaw(100, 1400), 700);
    assert.equal(levelToRaw(200, 1400), 1400);
    assert.equal(levelToRaw(1, 1400), 7);
    assert.equal(levelToRaw(60, 2000), 600);
    assert.equal(levelToRaw(300, 1400), 1400);
    assert.equal(levelToRaw(200, 5000), 2047);
    assert.equal(levelToRaw(-5, 1400), 0);
  });

  it("finds the highest level at or below a raw value", () => {
    assert.equal(rawToLevelFloor(700, 1400), 100);
    assert.equal(rawToLevelFloor(699, 1400), 99);
    assert.equal(rawToLevelFloor(0, 1400), 0);
    assert.equal(rawToLevelFloor(5000, 1400), 200);
    for (const raw of [1, 13, 333, 1000, 1399]) assert.ok(levelToRaw(rawToLevelFloor(raw, 1400), 1400) <= raw);
  });

  it("parses the battery byte", () => {
    assert.equal(parseBattery([55]), 55);
    assert.equal(parseBattery([250]), 100);
    assert.equal(parseBattery([]), undefined);
  });
});
