import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createLovenseDevice } from "../../src/lovense/device.ts";
import { createLovenseToy, lovenseLabel, TEST_MS, toDeviceStatus, vibrationLevel } from "../../src/lovense/toy.ts";
import { FakeBluetooth, fakeToy, MemStorage } from "../fakes/bluetooth.ts";
import { flush } from "../fakes/clock.ts";
import { fakeContext } from "../fakes/context.ts";

function setup(settings: Parameters<typeof fakeContext>[0] = {}) {
  const f = fakeContext(settings);
  const toy = fakeToy({ id: "bt-42" });
  toy.tx.clock = f.clock;
  const storage = new MemStorage();
  const device = createLovenseDevice({ bluetooth: new FakeBluetooth(toy.dev), now: f.clock.now, timers: f.clock, storage });
  const t = createLovenseToy(f.ctx, { device });
  /** lets the rate-limited sender write */
  const settle = async () => {
    await flush();
    f.clock.advance(150);
    await flush();
  };
  return { ...f, toy, device, t, settle };
}

describe("vibrationLevel", () => {
  it("is round(20 × intensity × strength)", () => {
    assert.equal(vibrationLevel(1, { strength: 100, minLevel: 0 }), 20);
    assert.equal(vibrationLevel(0.5, { strength: 100, minLevel: 0 }), 10);
    assert.equal(vibrationLevel(1, { strength: 50, minLevel: 0 }), 10);
    assert.equal(vibrationLevel(0.004, { strength: 100, minLevel: 0 }), 0);
    assert.equal(vibrationLevel(2, { strength: 100, minLevel: 0 }), 20);
  });

  it("raises to minLevel, capped by strength × gain", () => {
    assert.equal(vibrationLevel(0.05, { strength: 100, minLevel: 4 }), 4);
    // intensity already contains gain 0.1: cap round(20 × 0.1) = 2
    assert.equal(vibrationLevel(0.05, { strength: 100, minLevel: 4, gain: 0.1 }), 2);
    assert.equal(vibrationLevel(0.5, { strength: 100, minLevel: 4, gain: 0 }), 0);
    assert.equal(vibrationLevel(0.5, { strength: 0, minLevel: 4 }), 0);
    assert.equal(vibrationLevel(0, { strength: 100, minLevel: 4 }), 0);
  });
});

describe("Lovense ToyDevice", () => {
  it("is kind lovense with the Bluetooth id once known", async () => {
    const s = setup();
    assert.equal(s.t.kind, "lovense");
    assert.equal(s.t.id, "lovense");
    assert.equal(s.t.selfReconnects, true);
    await s.t.connect();
    await flush();
    assert.equal(s.t.id, "bt-42");
    const st = s.t.status();
    assert.equal(st.connection, "connected");
    assert.equal(st.device, "LVS-Lush42");
    assert.equal(st.battery, 85);
    assert.deepEqual(st.output, { a: 0 });
  });

  it("drives the level from frame.intensity, Strength as a hard cap", async () => {
    const s = setup({ strength: 50 });
    await s.t.connect();
    await s.settle();
    s.t.drive({ intensity: 1, balance: 0, speed: 1, a: 0, b: 0 });
    await s.settle();
    assert.equal(s.toy.tx.vibrates().at(-1), "Vibrate:10;");
    assert.equal(s.t.level(), 10);
    assert.deepEqual(s.t.status().output, { a: 0.5 });
    s.t.drive(null);
    await s.settle();
    assert.equal(s.toy.tx.vibrates().at(-1), "Vibrate:0;");
  });

  it("applies new settings right away", async () => {
    const s = setup();
    await s.t.connect();
    await s.settle();
    s.t.drive({ intensity: 1, balance: 0.5, speed: 0 });
    await s.settle();
    assert.equal(s.toy.tx.vibrates().at(-1), "Vibrate:20;");
    s.update({ strength: 25 });
    await s.settle();
    assert.equal(s.toy.tx.vibrates().at(-1), "Vibrate:5;");
  });

  it("has no nudge", () => {
    assert.equal(setup().t.nudge(), false);
  });

  it("test() pulses 10 × Strength for a second, then back to the frame", async () => {
    const s = setup({ strength: 60 });
    await s.t.connect();
    await s.settle();
    s.t.test();
    await s.settle();
    assert.equal(s.toy.tx.vibrates().at(-1), "Vibrate:6;");
    s.t.drive({ intensity: 1, balance: 0.5, speed: 0 });
    assert.equal(s.t.level(), 6, "the test pulse wins while it lasts");
    s.clock.advance(TEST_MS);
    await s.settle();
    assert.equal(s.toy.tx.vibrates().at(-1), "Vibrate:12;");
  });

  it("stopNow() outputs 0 and keeps the link; disconnect() sends 0 and closes", async () => {
    const s = setup();
    await s.t.connect();
    await s.settle();
    s.t.drive({ intensity: 1, balance: 0.5, speed: 0 });
    await s.settle();
    s.t.stopNow();
    await s.settle();
    assert.equal(s.toy.tx.vibrates().at(-1), "Vibrate:0;");
    assert.equal(s.t.status().connection, "connected");
    s.t.drive({ intensity: 1, balance: 0.5, speed: 0 });
    await s.settle();
    s.t.disconnect();
    await s.settle();
    assert.equal(s.toy.tx.vibrates().at(-1), "Vibrate:0;");
    assert.equal(s.t.status().connection, "disconnected");
  });

  it("maps the Lovense status", () => {
    assert.deepEqual(toDeviceStatus({ connection: "connected", device: "LVS-A1", model: "Hush", battery: 50, level: 5 }), {
      connection: "connected",
      device: "Hush · LVS-A1",
      battery: 50,
      output: { a: 0.25 },
    });
    assert.deepEqual(toDeviceStatus({ connection: "error", message: "nope" }), { connection: "error", message: "nope" });
    assert.equal(lovenseLabel({ device: "LVS-Lush42", model: "Lush" }), "LVS-Lush42");
    assert.equal(lovenseLabel({}), "Lovense toy");
  });
});

describe("Lovense mapping targets", () => {
  it("offers the vibration level; the default follows the axisMap setting", () => {
    const s = setup({ axisMap: "roll=intensity" });
    assert.deepEqual(s.t.mappingTargets!().map((x) => x.id), ["intensity"]);
    const chans = [{ id: "stroke", actions: [{ at: 0, pos: 0 }] }, { id: "roll", actions: [{ at: 0, pos: 0 }] }];
    assert.deepEqual(s.t.defaultMapping!(chans), { roll: { target: "intensity" } });
    s.update({ axisMap: "" });
    assert.deepEqual(s.t.defaultMapping!(chans), { stroke: { target: "intensity" } });
  });
});
