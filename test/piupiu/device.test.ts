// The PiuPiu driver against Toy Sync's contract: its mapping target and
// default mapping, mapped invert / range, seek, stop, closing scenes, the
// Test sweep and TCode Player detection. Uses the shared fake Web Bluetooth.
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createPiupiuDevice, DEVICE_KEY, PIUPIU, SQUIRT_TARGET, type PiupiuDevice } from "../../src/piupiu/device.ts";
import type { IntervalTimers } from "../../src/tcode/engine.ts";
import { FakeBluetooth, FakeCharacteristic, FakeDevice, FakeService, MemStorage, props } from "../fakes/bluetooth.ts";
import { FakeClock, flush } from "../fakes/clock.ts";
import { fakeProgram, FakeVideo } from "../fakes/playback.ts";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function launcher(id = "piu") {
  const tx = new FakeCharacteristic(String(PIUPIU.tx), props({ write: true }));
  const dev = new FakeDevice(id, "Hismith Piupiu", [new FakeService(String(PIUPIU.service), [tx])]);
  return { tx, dev };
}

const made: PiupiuDevice[] = [];
afterEach(() => {
  for (const d of made.splice(0)) {
    d.disconnect();
    d.setProgram(null);
    d.dispose();
  }
});

function make(opts: { oldPlugin?: boolean; timers?: IntervalTimers; storage?: MemStorage } = {}) {
  const l = launcher();
  const bt = new FakeBluetooth(l.dev);
  const storage = opts.storage ?? new MemStorage();
  const device = createPiupiuDevice(undefined, {
    bluetooth: bt,
    storage,
    oldPluginPresent: () => !!opts.oldPlugin,
    log: { warn() {}, info() {} },
    ...(opts.timers ? { timers: opts.timers } : {}),
  });
  made.push(device);
  return { device, bt, storage, ...l };
}

const LUBE_LOW_THEN_HIGH = {
  actions: [{ at: 0, pos: 50 }],
  channels: { lube: [{ at: 0, pos: 30 }, { at: 100000, pos: 30 }] },
};

describe("mapping", () => {
  it("has one target and maps the lube / A2 channel to it by default", () => {
    const { device } = make();
    assert.deepEqual(device.mappingTargets().map((t) => t.id), [SQUIRT_TARGET]);
    const acts = [{ at: 0, pos: 0 }];
    assert.deepEqual(device.defaultMapping(["stroke", "lube", "a2", "roll"].map((id) => ({ id, actions: acts }))), {
      lube: { target: "squirt" },
      a2: { target: "squirt" },
    });
  });

  it("applies the mapping's invert and range: an inverted low lube channel fires", async () => {
    const { device, tx } = make();
    await device.connect();
    const video = new FakeVideo();
    device.setProgram(fakeProgram({ clock: video, script: LUBE_LOW_THEN_HIGH, mapping: { lube: { target: "squirt", invert: true } } }));
    video.play();
    await wait(60);
    assert.equal(device.active(), true);
    assert.ok(tx.writes.length >= 1);
    assert.deepEqual([...tx.writes[0]!.cmd].map((c) => c.charCodeAt(0)), [...PIUPIU.squirt]);
    device.setProgram(fakeProgram({ clock: video, script: LUBE_LOW_THEN_HIGH, mapping: { lube: { target: "squirt", invert: true, min: 0, max: 60 } } }));
    await wait(60);
    assert.equal(device.active(), false, "70 lerped into 0..60 is 42: below half");
  });
});

describe("playback", () => {
  const HIGH = { actions: [{ at: 0, pos: 0 }], channels: { lube: [{ at: 0, pos: 100 }, { at: 100000, pos: 100 }] } };

  it("stops on seek and picks up again at the new position", async () => {
    const { device } = make();
    await device.connect();
    const video = new FakeVideo();
    device.setProgram(fakeProgram({ clock: video, script: HIGH, device }));
    video.play();
    await wait(40);
    assert.equal(device.active(), true);
    let stopped = false;
    const off = device.onStatus((s) => {
      if (s.output?.a === 0) stopped = true;
    });
    video.seek(5);
    off();
    assert.ok(stopped, "stopped on the seek");
    await wait(40);
    assert.equal(device.active(), true);
  });

  it("stops when the scene closes or on stopNow, and stopNow holds until play", async () => {
    const { device, tx } = make();
    await device.connect();
    const video = new FakeVideo();
    device.setProgram(fakeProgram({ clock: video, script: HIGH, device }));
    video.play();
    await wait(40);
    device.stopNow();
    assert.equal(device.active(), false);
    const n = tx.writes.length;
    await wait(300);
    assert.equal(tx.writes.length, n, "stays quiet while still playing");
    video.play();
    await wait(40);
    assert.equal(device.active(), true);
    device.setProgram(null);
    assert.equal(device.active(), false);
    assert.equal(video.subscribers, 0);
  });

  it("reports firing as its output and drive() does nothing", async () => {
    const { device } = make();
    await device.connect();
    assert.deepEqual(device.status().output, { a: 0 });
    device.squirt(true);
    assert.deepEqual(device.status().output, { a: 1 });
    device.squirt(false);
    device.drive({ intensity: 1, balance: 0, speed: 1 });
    assert.equal(device.active(), false);
    assert.equal(device.nudge(), false);
  });
});

class FakeIntervals extends FakeClock implements IntervalTimers {
  setInterval(fn: () => void, ms: number): unknown {
    const h = { id: undefined as unknown };
    const run = () => {
      h.id = this.setTimeout(run, ms);
      fn();
    };
    h.id = this.setTimeout(run, ms);
    return h;
  }
  clearInterval(h: unknown): void {
    this.clearTimeout((h as { id: unknown }).id);
  }
}

describe("testChannel", () => {
  it("fires during the high part of TCode Player's Test sweep only", async () => {
    const clock = new FakeIntervals();
    const { device } = make({ timers: clock });
    await device.connect();
    device.setProgram(fakeProgram({ clock: new FakeVideo(), script: LUBE_LOW_THEN_HIGH, device }));
    device.testChannel("lube");
    const seen: boolean[] = [];
    for (let t = 0; t < 3400; t += 50) {
      seen.push(device.active());
      clock.advance(50);
      await flush();
    }
    assert.equal(seen[0], false, "low first");
    assert.equal(seen[(750 + 400) / 50], true, "fires while high");
    assert.equal(seen[(750 + 950 + 400) / 50], false, "low again");
    assert.equal(device.active(), false);
  });
});

describe("connection", () => {
  it("remembers the launcher and stays off while TCode Player is active", async () => {
    const storage = new MemStorage();
    const first = make({ storage });
    await first.device.connect();
    assert.equal(storage.getItem(DEVICE_KEY), "piu");
    first.device.disconnect();
    const second = make({ storage, oldPlugin: true });
    second.bt.granted.push(second.dev);
    storage.setItem(DEVICE_KEY, "piu");
    await second.device.resume();
    assert.equal(second.dev.gatt.connects, 0);
    assert.match(second.device.status().message!, /TCode Player/);
  });

  it("says when there is no Web Bluetooth", async () => {
    const device = createPiupiuDevice(undefined, { bluetooth: undefined, storage: null, log: { warn() {}, info() {} } });
    made.push(device);
    await device.connect();
    assert.equal(device.status().connection, "error");
    assert.match(device.status().message!, /Web Bluetooth/);
  });
});
