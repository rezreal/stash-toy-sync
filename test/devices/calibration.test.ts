import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  calibrationKey,
  isCalibratable,
  levelFor,
  loadCalibration,
  saveCalibration,
  validateCalibration,
  validateChannel,
} from "../../src/devices/calibration.ts";
import type { Calibration, ChannelCalibration } from "../../src/devices/types.ts";
import { MemStorage } from "../fakes/bluetooth.ts";
import { FakeDevice } from "../fakes/device.ts";

const RANGE = { min: 0, max: 200 };
const ch = (firstFelt: number, comfortMax: number, nudge: number, hardMax: number): ChannelCalibration => ({
  firstFelt,
  comfortMax,
  nudge,
  hardMax,
});

describe("validateCalibration", () => {
  it("accepts a well-ordered calibration", () => {
    assert.deepEqual(validateCalibration({ a: ch(10, 40, 60, 60), updatedAt: "x" }, RANGE), []);
    assert.deepEqual(validateCalibration({ a: ch(10, 40, 60, 80), b: ch(5, 30, 31, 200), updatedAt: "x" }, RANGE), []);
  });

  it("requires firstFelt < comfortMax < nudge <= hardMax", () => {
    assert.equal(validateChannel(ch(40, 40, 60, 60), RANGE).length, 1);
    assert.match(validateChannel(ch(40, 40, 60, 60), RANGE)[0]!, /Comfort max/);
    assert.match(validateChannel(ch(10, 60, 60, 80), RANGE)[0]!, /Nudge/);
    assert.match(validateChannel(ch(10, 40, 60, 59), RANGE)[0]!, /Hard max/);
    assert.equal(validateChannel(ch(50, 40, 30, 20), RANGE).length, 3);
  });

  it("keeps every level within the device range", () => {
    assert.match(validateChannel(ch(10, 40, 60, 201), RANGE)[0]!, /outside the device range/);
    assert.match(validateChannel(ch(-1, 40, 60, 80), RANGE)[0]!, /First felt/);
  });

  it("labels channels and needs channel A", () => {
    const p = validateCalibration({ a: ch(10, 40, 60, 80), b: ch(10, 5, 60, 80), updatedAt: "" }, RANGE);
    assert.equal(p.length, 1);
    assert.match(p[0]!, /^Channel B:/);
    assert.deepEqual(validateCalibration(undefined, RANGE), ["Not calibrated."]);
    assert.match(validateCalibration({ updatedAt: "" } as unknown as Calibration, RANGE)[0]!, /Channel A/);
    assert.match(validateChannel({ firstFelt: 1 } as unknown as ChannelCalibration, RANGE)[0]!, /missing/);
  });
});

describe("levelFor", () => {
  const c = ch(20, 60, 80, 90);
  it("is 0 at or below 0.005", () => {
    assert.equal(levelFor(0, c), 0);
    assert.equal(levelFor(0.005, c), 0);
    assert.equal(levelFor(-1, c), 0);
    assert.equal(levelFor(Number.NaN, c), 0);
  });
  it("maps intensity onto [firstFelt, comfortMax]", () => {
    assert.equal(levelFor(0.006, c), 20);
    assert.equal(levelFor(0.5, c), 40);
    assert.equal(levelFor(1, c), 60);
    assert.equal(levelFor(5, c), 60, "intensity above 1 is clamped");
  });
  it("never exceeds hardMax", () => {
    assert.equal(levelFor(1, ch(20, 100, 120, 70)), 70);
  });
});

describe("calibration storage", () => {
  const cal: Calibration = { a: ch(10, 40, 60, 80), b: ch(5, 30, 50, 50), updatedAt: "2026-11-12T10:00:00.000Z" };

  it("stores per kind and id", () => {
    const s = new MemStorage();
    assert.equal(calibrationKey("coyote-v3", "abc"), "toysync.calibration.coyote-v3.abc");
    assert.equal(saveCalibration("coyote-v3", "abc", cal, s), true);
    assert.deepEqual(loadCalibration("coyote-v3", "abc", s), cal);
    assert.equal(loadCalibration("coyote-v3", "other", s), undefined);
    assert.equal(loadCalibration("coyote-v2", "abc", s), undefined);
    assert.equal(saveCalibration("coyote-v3", "abc", undefined, s), true);
    assert.equal(loadCalibration("coyote-v3", "abc", s), undefined);
  });

  it("ignores malformed data and failing storage", () => {
    const s = new MemStorage();
    s.setItem(calibrationKey("coyote-v3", "x"), "{not json");
    assert.equal(loadCalibration("coyote-v3", "x", s), undefined);
    s.setItem(calibrationKey("coyote-v3", "x"), JSON.stringify({ a: { firstFelt: 1 } }));
    assert.equal(loadCalibration("coyote-v3", "x", s), undefined);
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    assert.equal(loadCalibration("coyote-v3", "x", broken), undefined);
    assert.equal(saveCalibration("coyote-v3", "x", cal, broken), false);
    assert.equal(saveCalibration("coyote-v3", "x", cal, undefined), false);
  });
});

describe("isCalibratable", () => {
  it("tells e-stim style devices apart", () => {
    assert.equal(isCalibratable(new FakeDevice()), true);
    const plain = { kind: "lovense", id: "x", connect: async () => undefined } as unknown as FakeDevice;
    assert.equal(isCalibratable(plain), false);
    assert.equal(isCalibratable(undefined), false);
  });
});
