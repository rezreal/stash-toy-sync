import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  decodeB0,
  encodeB0,
  encodeBF,
  frequencyByte,
  isDfuName,
  MODE_ABSOLUTE,
  MODE_KEEP,
  parseBattery,
  parseNotify,
  periodForHz,
  SILENT_V3_WAVE,
  V3_BATTERY,
  V3_BATTERY_SERVICE,
  V3_NOTIFY,
  V3_SERVICE,
  V3_WRITE,
} from "../../src/coyote/protocol-v3.ts";

describe("Coyote 3.0 UUIDs", () => {
  it("are the lowercase Bluetooth SIG based UUIDs", () => {
    assert.equal(V3_SERVICE, "0000180c-0000-1000-8000-00805f9b34fb");
    assert.equal(V3_WRITE, "0000150a-0000-1000-8000-00805f9b34fb");
    assert.equal(V3_NOTIFY, "0000150b-0000-1000-8000-00805f9b34fb");
    assert.equal(V3_BATTERY_SERVICE, "0000180a-0000-1000-8000-00805f9b34fb");
    assert.equal(V3_BATTERY, "00001500-0000-1000-8000-00805f9b34fb");
  });
});

describe("frequencyByte", () => {
  it("matches the doc examples", () => {
    assert.equal(frequencyByte(1000), 240);
    assert.equal(frequencyByte(200), 120);
    assert.equal(frequencyByte(110), 102);
    assert.equal(frequencyByte(650), 205);
    assert.equal(frequencyByte(750), 215);
  });

  it("is the period itself for 10..100 ms and uses integer division above", () => {
    assert.equal(frequencyByte(10), 10);
    assert.equal(frequencyByte(20), 20);
    assert.equal(frequencyByte(100), 100);
    assert.equal(frequencyByte(101), 100);
    assert.equal(frequencyByte(104), 100);
    assert.equal(frequencyByte(105), 101);
    assert.equal(frequencyByte(600), 200);
    assert.equal(frequencyByte(601), 200);
    assert.equal(frequencyByte(609), 200);
    assert.equal(frequencyByte(610), 201);
  });

  it("never leaves 10..240", () => {
    assert.equal(frequencyByte(5), 10);
    assert.equal(frequencyByte(1), 10);
    assert.equal(frequencyByte(5000), 240);
    assert.equal(frequencyByte(NaN), 10);
    for (let p = 0; p <= 1200; p += 7) {
      const f = frequencyByte(p);
      assert.ok(f >= 10 && f <= 240, `period ${p} -> ${f}`);
    }
  });

  it("goes with periodForHz", () => {
    assert.equal(periodForHz(100), 10);
    assert.equal(periodForHz(50), 20);
    assert.equal(periodForHz(10), 100);
    assert.equal(periodForHz(1), 1000);
    assert.equal(frequencyByte(periodForHz(200)), 10);
  });
});

describe("B0", () => {
  it("packs header, seq/modes, strengths and 4 + 4 pairs per channel", () => {
    const bytes = encodeB0({
      seq: 5,
      modeA: MODE_ABSOLUTE,
      modeB: MODE_KEEP,
      strengthA: 60,
      strengthB: 0,
      a: { freq: [20, 20, 20, 20], intensity: [100, 0, 50, 100] },
      b: SILENT_V3_WAVE,
    });
    assert.equal(bytes.length, 20);
    assert.deepEqual(Array.from(bytes), [0xb0, 0x5c, 60, 0, 20, 20, 20, 20, 100, 0, 50, 100, 10, 10, 10, 10, 0, 0, 0, 0]);
    const back = decodeB0(bytes)!;
    assert.equal(back.seq, 5);
    assert.equal(back.modeA, MODE_ABSOLUTE);
    assert.equal(back.modeB, MODE_KEEP);
    assert.deepEqual(back.a.intensity, [100, 0, 50, 100]);
  });

  it("clamps every byte into its valid range", () => {
    const bytes = encodeB0({
      seq: 99,
      modeA: 7,
      modeB: -1,
      strengthA: 300,
      strengthB: -4,
      a: { freq: [0, 5, 255, 241], intensity: [101, -1, 200, NaN] },
      b: { freq: [], intensity: [] },
    });
    const p = decodeB0(bytes)!;
    assert.equal(p.seq, 15);
    assert.equal(p.modeA, 3);
    assert.equal(p.modeB, 0);
    assert.equal(p.strengthA, 200);
    assert.equal(p.strengthB, 0);
    assert.deepEqual(p.a.freq, [10, 10, 240, 240]);
    assert.deepEqual(p.a.intensity, [100, 0, 100, 0]);
    assert.deepEqual(p.b, SILENT_V3_WAVE);
  });
});

describe("BF", () => {
  it("is limits, frequency balance 160, intensity balance 0", () => {
    assert.deepEqual(Array.from(encodeBF(100, 90)), [0xbf, 100, 90, 160, 160, 0, 0]);
    assert.deepEqual(Array.from(encodeBF(250, -1)), [0xbf, 200, 0, 160, 160, 0, 0]);
  });
});

describe("notifications", () => {
  it("reads B1 strengths unsigned", () => {
    assert.deepEqual(parseNotify([0xb1, 3, 200, 150]), { type: "b1", seq: 3, a: 200, b: 150 });
    assert.deepEqual(parseNotify(new Int8Array([-79, 0, -56, 10]) as unknown as number[]), { type: "b1", seq: 0, a: 200, b: 10 });
  });

  it("parses BE and passes unknown headers through", () => {
    assert.deepEqual(parseNotify([0xbe, 100, 90, 160, 160, 0, 0]), {
      type: "be",
      limitA: 100,
      limitB: 90,
      freqBalanceA: 160,
      freqBalanceB: 160,
      intensityBalanceA: 0,
      intensityBalanceB: 0,
    });
    assert.deepEqual(parseNotify([0x53, 1]), { type: "unknown", header: 0x53 });
    assert.deepEqual(parseNotify([0xb1, 1]), { type: "unknown", header: 0xb1 });
    assert.equal(parseNotify([]), undefined);
  });

  it("parses the battery byte", () => {
    assert.equal(parseBattery([42]), 42);
    assert.equal(parseBattery([255]), 100);
  });

  it("knows the update-mode name", () => {
    assert.equal(isDfuName("47L121000_O3"), true);
    assert.equal(isDfuName("47L121000"), false);
    assert.equal(isDfuName(undefined), false);
  });
});
