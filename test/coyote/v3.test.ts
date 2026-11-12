import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { calibrationKey } from "../../src/devices/calibration.ts";
import { DRIVERS } from "../../src/devices/registry.ts";
import type { DriveFrame } from "../../src/devices/types.ts";
import type { CoyoteDevice } from "../../src/coyote/device.ts";
import { MSG_INSECURE, MSG_NO_BLUETOOTH } from "../../src/coyote/link.ts";
import { SILENT_V3_WAVE, V3_BATTERY_SERVICE, V3_SERVICE, V3_WRITE } from "../../src/coyote/protocol-v3.ts";
import { createCoyoteV3, MSG_V3_NOT_CHOSEN, MSG_V3_UPDATE_MODE, MSG_V3_WRONG_DEVICE } from "../../src/coyote/v3.ts";
import "../../src/coyote/register.ts";
import { domError, FakeBluetooth, FakeTarget, MemStorage, props } from "../fakes/bluetooth.ts";
import { FakeClock, flush } from "../fakes/clock.ts";
import { fakeContext } from "../fakes/context.ts";
import { CAL, fakeCoyote3, type FakeCoyote3Options } from "./fakes.ts";

const FULL: DriveFrame = { intensity: 1, balance: 0.5, speed: 0 };
const ALL = [100, 100, 100, 100];

/** advances the clock in 10 ms steps, letting acks and writes settle in between */
async function run(clock: FakeClock, ms: number): Promise<void> {
  const end = clock.t + ms;
  while (clock.t < end) {
    await flush(); // writes queued at this instant go out before time moves on
    clock.advance(Math.min(10, end - clock.t));
    await flush();
  }
}

/** drive(frame) every 50 ms, like the manager */
async function driveFor(d: CoyoteDevice, clock: FakeClock, frame: DriveFrame | null, ms: number): Promise<void> {
  const end = clock.t + ms;
  while (clock.t < end) {
    d.drive(frame);
    await run(clock, Math.min(50, end - clock.t));
  }
}

function setup(o: { coyote?: FakeCoyote3Options; page?: FakeTarget; storage?: MemStorage; bt?: FakeBluetooth } = {}) {
  const f = fakeContext();
  const coyote = fakeCoyote3(o.coyote);
  coyote.tx.clock = f.clock;
  const bt = o.bt ?? new FakeBluetooth(coyote.dev);
  const storage = o.storage ?? new MemStorage();
  const d = createCoyoteV3(f.ctx, { bluetooth: bt, storage, worker: null, pageEvents: o.page ?? null });
  const b0sFrom = (t: number) => coyote.b0s().filter((p) => p.t >= t);
  return { ...f, coyote, bt, storage, d, b0sFrom };
}

/** connected, calibrated and quiet again (t = 400) */
async function ready(o: Parameters<typeof setup>[0] = {}) {
  const s = setup(o);
  await s.d.connect();
  await flush();
  s.d.setCalibration(CAL);
  await run(s.clock, 400);
  return s;
}

describe("Coyote 3.0 connect", () => {
  it("asks for 47L12 or the pulse service, with the battery service", async () => {
    const s = setup();
    await s.d.connect();
    assert.deepEqual(s.bt.requests[0], {
      filters: [{ namePrefix: "47L12" }, { services: [V3_SERVICE] }],
      optionalServices: [V3_SERVICE, V3_BATTERY_SERVICE],
    });
    assert.equal(s.d.kind, "coyote-v3");
    assert.equal(s.d.id, "c3");
    assert.equal(s.storage.getItem("toysync.coyote-v3.device"), "c3");
    assert.deepEqual(s.d.channels, ["a", "b"]);
    assert.deepEqual(s.d.levelRange(), { min: 0, max: 200 });
    assert.equal(s.d.selfReconnects, true);
  });

  it("sends BF first, then a B0 that zeroes both channels, then stops after 300 ms of silence", async () => {
    const s = setup();
    await s.d.connect();
    await flush();
    const packets = s.coyote.tx.packets();
    assert.deepEqual(packets[0], [0xbf, 200, 200, 160, 160, 0, 0]);
    const first = s.coyote.b0s()[0]!;
    assert.equal(first.seq, 1);
    assert.equal(first.modeA, 3);
    assert.equal(first.modeB, 3);
    assert.equal(first.strengthA, 0);
    assert.equal(first.strengthB, 0);
    assert.deepEqual(first.a, SILENT_V3_WAVE);
    assert.deepEqual(first.b, SILENT_V3_WAVE);
    await run(s.clock, 1000);
    assert.deepEqual(s.coyote.b0s().map((p) => p.t), [0, 100, 200, 300]);
    assert.ok(s.coyote.b0s().slice(1).every((p) => p.seq === 0 && p.modeA === 0 && p.modeB === 0));
    const st = s.d.status();
    assert.equal(st.connection, "connected");
    assert.equal(st.device, "Coyote 3.0");
    assert.equal(st.battery, 77);
    assert.equal(st.needsCalibration, true);
    assert.deepEqual(st.output, { a: 0, b: 0 });
  });

  it("explains a cancelled picker with the privacy-mode tip", async () => {
    const s = setup({ bt: new FakeBluetooth(domError("NotFoundError", "User cancelled the requestDevice() chooser.")) });
    await s.d.connect();
    assert.equal(s.d.status().connection, "error");
    assert.equal(s.d.status().message, MSG_V3_NOT_CHOSEN);
    assert.match(MSG_V3_NOT_CHOSEN, /privacy mode/);
    assert.match(MSG_V3_NOT_CHOSEN, /both wheels/);
  });

  it("reports update mode and wrong devices", async () => {
    const dfu = setup({ coyote: { name: "47L121000_O3", noPulseService: true } });
    await dfu.d.connect();
    assert.equal(dfu.d.status().connection, "error");
    assert.equal(dfu.d.status().message, MSG_V3_UPDATE_MODE);
    const wrong = setup({ coyote: { name: "Something", noPulseService: true } });
    await wrong.d.connect();
    assert.equal(wrong.d.status().message, MSG_V3_WRONG_DEVICE);
  });

  it("says when Web Bluetooth is missing or the page is insecure", async () => {
    const f = fakeContext();
    const d = createCoyoteV3(f.ctx, { storage: null, worker: null, pageEvents: null });
    await d.connect();
    assert.equal(d.status().message, MSG_NO_BLUETOOTH);
    const d2 = createCoyoteV3(f.ctx, { storage: null, worker: null, pageEvents: null, secureContext: false });
    await d2.connect();
    assert.equal(d2.status().message, MSG_INSECURE);
  });

  it("resumes a device granted earlier without a picker, also an unnamed one (privacy mode)", async () => {
    const storage = new MemStorage();
    const first = setup({ coyote: { name: null, id: "anon" }, storage });
    await first.d.connect();
    await flush();
    assert.equal(first.bt.requests.length, 1);
    first.d.disconnect();
    await run(first.clock, 600);
    const f = fakeContext();
    const d = createCoyoteV3(f.ctx, { bluetooth: first.bt, storage, worker: null, pageEvents: null });
    assert.equal(d.id, "anon");
    await d.resume();
    await flush();
    assert.equal(d.status().connection, "connected");
    assert.equal(first.bt.requests.length, 1);

    // nothing granted: quietly stays disconnected
    const empty = new FakeBluetooth(domError("NotFoundError"));
    const d3 = createCoyoteV3(f.ctx, { bluetooth: empty, storage: new MemStorage(), worker: null, pageEvents: null });
    await d3.resume();
    assert.equal(d3.status().connection, "disconnected");
    assert.equal(empty.requests.length, 0);
  });
});

describe("Coyote 3.0 calibration", () => {
  it("stores per device and re-sends BF with the hardMax limits right away", async () => {
    const s = setup();
    await s.d.connect();
    await run(s.clock, 400);
    assert.equal(s.d.calibration(), undefined);
    const t = s.clock.t;
    s.d.setCalibration(CAL);
    await flush();
    assert.deepEqual(s.coyote.bfs().at(-1), [0xbf, 100, 90, 160, 160, 0, 0]);
    assert.equal(s.coyote.tx.writes.at(-2)!.t, t);
    assert.deepEqual(s.d.calibration(), CAL);
    assert.ok(s.storage.getItem(calibrationKey("coyote-v3", "c3")));
    assert.equal(s.d.status().needsCalibration, undefined);
  });

  it("rejects an invalid calibration with a message", async () => {
    const s = await ready();
    s.d.setCalibration({ a: { firstFelt: 50, comfortMax: 40, nudge: 80, hardMax: 100 }, updatedAt: "" });
    assert.deepEqual(s.d.calibration(), CAL);
    assert.match(s.d.status().message ?? "", /Calibration not saved/);
  });

  it("outputs nothing without a calibration", async () => {
    const s = setup();
    await s.d.connect();
    await run(s.clock, 400);
    await driveFor(s.d, s.clock, FULL, 500);
    assert.ok(s.coyote.b0s().every((p) => p.strengthA === 0 && p.strengthB === 0 && p.a.intensity.every((i) => i === 0)));
    assert.equal(s.d.nudge(), false);
    s.d.test();
    await run(s.clock, 200);
    assert.equal(s.coyote.state.a, 0);
  });
});

describe("Coyote 3.0 drive", () => {
  it("streams a B0 every 100 ms: the strength absolute once, then keep", async () => {
    const s = await ready();
    const t0 = s.clock.t;
    await driveFor(s.d, s.clock, FULL, 450);
    const ps = s.b0sFrom(t0);
    assert.deepEqual(ps.map((p) => p.t - t0), [0, 100, 200, 300, 400]);
    assert.equal(ps[0]!.modeA, 3);
    assert.equal(ps[0]!.modeB, 3);
    assert.notEqual(ps[0]!.seq, 0);
    assert.equal(ps[0]!.strengthA, 60);
    assert.equal(ps[0]!.strengthB, 50);
    assert.deepEqual(ps[0]!.a, { freq: [100, 100, 100, 100], intensity: ALL });
    for (const p of ps.slice(1)) {
      assert.equal(p.seq, 0);
      assert.equal(p.modeA, 0);
      assert.equal(p.modeB, 0);
      assert.deepEqual(p.a.intensity, ALL);
    }
    assert.equal(s.coyote.state.a, 60);
    assert.equal(s.coyote.state.b, 50);
    assert.deepEqual(s.d.status().output, { a: 0.3, b: 0.25 });
  });

  it("uses the speed settings for the frequency", async () => {
    const s = await ready();
    const t0 = s.clock.t;
    await driveFor(s.d, s.clock, { intensity: 1, balance: 0.5, speed: 1 }, 200);
    assert.deepEqual(s.b0sFrom(t0)[0]!.a.freq, [10, 10, 10, 10]); // 100 Hz -> 10 ms
  });

  it("holds strength changes until the B1 answer, and retries after 500 ms", async () => {
    const s = await ready();
    await driveFor(s.d, s.clock, FULL, 250);
    s.coyote.state.ack = false;
    const t0 = s.clock.t + 50; // the next packet
    await driveFor(s.d, s.clock, { intensity: 0.5, balance: 0.5, speed: 0 }, 400);
    await driveFor(s.d, s.clock, { intensity: 0.25, balance: 0.5, speed: 0 }, 300);
    const ps = s.b0sFrom(t0);
    const sets = ps.filter((p) => p.seq !== 0);
    // 0.5 -> A 40, B 30; held (no answer), retried after 500 ms with the wanted levels by then
    assert.equal(sets[0]!.t, t0);
    assert.equal(sets[0]!.strengthA, 40);
    assert.equal(sets[0]!.strengthB, 30);
    assert.equal(sets[1]!.t, t0 + 500);
    assert.notEqual(sets[1]!.seq, sets[0]!.seq);
    assert.equal(sets[1]!.strengthA, 30);
    assert.equal(sets[1]!.strengthB, 20);
    assert.equal(sets.length, 2);
    // while the device may still be at 60, the waveform is scaled down to the wanted 40 / 60
    assert.deepEqual(ps[1]!.a.intensity, [67, 67, 67, 67]);
  });

  it("adopts a wheel turned down as the channel's ceiling until reconnect", async () => {
    const s = await ready();
    await driveFor(s.d, s.clock, FULL, 300);
    s.coyote.wheel(30, 50);
    await flush();
    assert.match(s.d.status().message ?? "", /A ≤ 30/);
    const t0 = s.clock.t;
    await driveFor(s.d, s.clock, FULL, 500);
    assert.ok(s.b0sFrom(t0).every((p) => p.modeA !== 3 || p.strengthA <= 30));
    assert.equal(s.coyote.state.a, 30);
    assert.equal(s.d.status().output?.a, 30 / 200);

    s.coyote.dev.gatt.drop();
    await driveFor(s.d, s.clock, FULL, 1200);
    assert.equal(s.d.status().connection, "connected");
    assert.equal(s.d.status().message, undefined);
    assert.equal(s.coyote.state.a, 60);
  });

  it("goes silent on null: strength 0 and silent waveforms, then the packets stop", async () => {
    const s = await ready();
    await driveFor(s.d, s.clock, FULL, 250);
    const t0 = s.clock.t;
    await driveFor(s.d, s.clock, null, 1000);
    const ps = s.b0sFrom(t0);
    assert.deepEqual(ps[0]!.a, SILENT_V3_WAVE);
    assert.deepEqual(ps[0]!.b, SILENT_V3_WAVE);
    assert.equal(ps[0]!.modeA, 3);
    assert.equal(ps[0]!.strengthA, 0);
    assert.equal(ps[0]!.strengthB, 0);
    assert.equal(s.coyote.state.a, 0);
    assert.equal(s.coyote.state.b, 0);
    assert.ok(ps.length >= 3 && ps.length <= 5, `${ps.length} silent packets`);
    assert.ok(ps.at(-1)!.t - t0 < 500);
  });

  it("goes silent when drive() stops being called (watchdog)", async () => {
    const s = await ready();
    const t0 = s.clock.t;
    s.d.drive(FULL);
    await run(s.clock, 1200);
    const ps = s.b0sFrom(t0);
    assert.deepEqual(ps.filter((p) => p.a.intensity[0] === 100).map((p) => p.t - t0), [0, 100, 200, 300]);
    const silent = ps.filter((p) => p.t - t0 >= 400);
    assert.ok(silent.length >= 3);
    assert.ok(silent.every((p) => p.a.intensity.every((i) => i === 0)));
    assert.equal(s.coyote.state.a, 0);
    assert.ok(ps.at(-1)!.t - t0 <= 800);
  });

  it("stopNow() silences in the same instant and keeps the connection", async () => {
    const s = await ready();
    await driveFor(s.d, s.clock, FULL, 250);
    const t0 = s.clock.t;
    s.d.stopNow();
    const p = s.b0sFrom(t0)[0]!;
    assert.equal(p.t, t0);
    assert.deepEqual(p.a, SILENT_V3_WAVE);
    await run(s.clock, 600);
    assert.equal(s.coyote.state.a, 0);
    assert.equal(s.d.status().connection, "connected");
  });

  it("never has two GATT operations in flight and skips packets while one is pending", async () => {
    const s = await ready();
    s.coyote.tx.manual = true;
    const t0 = s.clock.t;
    await driveFor(s.d, s.clock, FULL, 350);
    assert.equal(s.coyote.tx.waiting, 1);
    assert.equal(s.b0sFrom(t0).length, 1);
    s.coyote.tx.release();
    await flush();
    // the skipped packet goes out as soon as the queue drains
    assert.equal(s.b0sFrom(t0).length, 2);
    for (let i = 0; i < 10; i++) {
      await driveFor(s.d, s.clock, FULL, 50);
      while (s.coyote.tx.waiting > 0) s.coyote.tx.release();
      await flush();
    }
    assert.equal(s.coyote.counter.max, 1);
  });
});

describe("Coyote 3.0 nudge, test, probe", () => {
  it("nudges 3 × 120 ms at the nudge levels, 100 Hz, in 25 ms slots", async () => {
    const s = await ready();
    assert.equal(s.d.nudge(), true);
    const t0 = s.clock.t;
    await run(s.clock, 350);
    assert.equal(s.d.nudge(), true, "a nudge in progress isn't restarted");
    await run(s.clock, 800);
    const ps = s.b0sFrom(t0);
    assert.equal(ps[0]!.strengthA, 80);
    assert.equal(ps[0]!.strengthB, 70);
    assert.equal(ps[0]!.modeA, 3);
    assert.deepEqual(ps[0]!.a.freq, [10, 10, 10, 10]);
    const pattern = ps.slice(0, 7).map((p) => p.a.intensity);
    assert.deepEqual(pattern, [ALL, [100, 0, 0, 0], [0, 0, 0, 100], ALL, [0, 0, 0, 0], [0, 0, 100, 100], [100, 100, 100, 0]]);
    assert.deepEqual(ps.slice(0, 7).map((p) => p.t - t0), [0, 100, 200, 300, 400, 500, 600]);
    assert.ok(ps.slice(7).every((p) => p.a.intensity.every((i) => i === 0)));
    assert.equal(s.coyote.state.a, 0);
  });

  it("returns to the frame after a nudge and never exceeds hardMax", async () => {
    const s = await ready();
    await driveFor(s.d, s.clock, FULL, 200);
    s.d.nudge();
    const t0 = s.clock.t;
    await driveFor(s.d, s.clock, FULL, 1000);
    const ps = s.b0sFrom(t0);
    assert.ok(ps.every((p) => p.strengthA <= 100 && p.strengthB <= 90));
    assert.equal(s.coyote.state.a, 60);
    assert.deepEqual(ps.at(-1)!.a.freq, [100, 100, 100, 100]);
  });

  it("refuses to nudge when not connected", () => {
    const s = setup();
    s.d.setCalibration(CAL);
    assert.equal(s.d.nudge(), false);
  });

  it("tests 1 s at the middle of [firstFelt, comfortMax], 50 Hz", async () => {
    const s = await ready();
    const t0 = s.clock.t;
    s.d.test();
    await run(s.clock, 1500);
    const ps = s.b0sFrom(t0);
    assert.equal(ps[0]!.strengthA, 40);
    assert.equal(ps[0]!.strengthB, 30);
    assert.deepEqual(ps[0]!.a.freq, [20, 20, 20, 20]);
    assert.deepEqual(ps.filter((p) => p.a.intensity[0] === 100).map((p) => p.t - t0), [0, 100, 200, 300, 400, 500, 600, 700, 800, 900]);
    assert.equal(s.coyote.state.a, 0);
  });

  it("probes one channel while held, lifting that channel's limit, and stops at once on release", async () => {
    const s = await ready();
    const t0 = s.clock.t;
    for (let i = 1; i <= 8; i++) {
      s.d.probe("b", i * 15, "steady", true);
      await run(s.clock, 50);
    }
    assert.deepEqual(s.coyote.bfs().at(-1), [0xbf, 100, 200, 160, 160, 0, 0]);
    const ps = s.b0sFrom(t0);
    assert.ok(ps.every((p) => p.a.intensity.every((i) => i === 0)));
    assert.ok(ps.some((p) => p.b.intensity[0] === 100));
    assert.deepEqual(ps[0]!.b.freq, [20, 20, 20, 20]);
    assert.ok(s.coyote.state.b > 90, "a probe may go above the stored hardMax");
    assert.equal(s.coyote.state.a, 0);
    const t1 = s.clock.t;
    s.d.probe("b", 0, "steady", false);
    await flush(); // queued right behind the BF that restores the limits
    const off = s.coyote.b0s().at(-1)!;
    assert.equal(off.t, t1);
    assert.deepEqual(off.b, SILENT_V3_WAVE);
    assert.deepEqual(s.coyote.bfs().at(-1), [0xbf, 100, 90, 160, 160, 0, 0]);
    await run(s.clock, 600);
    assert.equal(s.coyote.state.b, 0);
  });

  it("repeats the burst pattern and stops a probe that isn't called any more", async () => {
    const s = setup();
    await s.d.connect();
    await run(s.clock, 400);
    const t0 = s.clock.t;
    s.d.probe("a", 50, "burst", true);
    await run(s.clock, 1000);
    const ps = s.b0sFrom(t0);
    assert.equal(ps[0]!.strengthA, 50, "uncalibrated probes work: that is how calibration starts");
    assert.deepEqual(ps[0]!.a.freq, [10, 10, 10, 10]);
    assert.deepEqual(ps.slice(0, 4).map((p) => p.a.intensity), [ALL, [100, 0, 0, 0], [0, 0, 0, 100], ALL]);
    assert.ok(ps.filter((p) => p.t - t0 >= 400).every((p) => p.a.intensity.every((i) => i === 0)));
    assert.equal(s.coyote.state.a, 0);
  });
});

describe("Coyote 3.0 reconnect and teardown", () => {
  it("re-sends BF and a zero B0 first on every reconnect", async () => {
    const s = await ready();
    await driveFor(s.d, s.clock, FULL, 300);
    s.coyote.dev.gatt.drop();
    await flush();
    assert.equal(s.d.status().connection, "connecting");
    const before = s.coyote.tx.writes.length;
    await driveFor(s.d, s.clock, FULL, 800);
    const after = s.coyote.tx.packets().slice(before);
    assert.deepEqual(after[0], [0xbf, 100, 90, 160, 160, 0, 0]);
    assert.equal(after[1]![0], 0xb0);
    assert.equal(after[1]![1]! & 0x0f, 0x0f, "both channels absolute");
    assert.equal(after[1]![2], 0);
    assert.equal(after[1]![3], 0);
    assert.equal(s.coyote.state.a, 60);
    assert.equal(s.d.status().connection, "connected");
  });

  it("disconnect() sends silence first, then closes and stays closed", async () => {
    const s = await ready();
    await driveFor(s.d, s.clock, FULL, 300);
    s.d.disconnect();
    await flush();
    const last = s.coyote.b0s().at(-1)!;
    assert.equal(last.strengthA, 0);
    assert.equal(last.modeA, 3);
    assert.deepEqual(last.a, SILENT_V3_WAVE);
    assert.equal(s.coyote.state.a, 0);
    assert.equal(s.coyote.dev.gatt.connected, false);
    assert.equal(s.d.status().connection, "disconnected");
    await run(s.clock, 6000);
    assert.equal(s.coyote.dev.gatt.connected, false);
  });

  it("sends silence on pagehide", async () => {
    const page = new FakeTarget();
    const s = await ready({ page });
    await driveFor(s.d, s.clock, FULL, 300);
    page.dispatch("pagehide");
    await flush();
    assert.equal(s.coyote.state.a, 0);
    assert.equal(s.coyote.b0s().at(-1)!.strengthA, 0);
    s.d.dispose();
    assert.equal(page.count("pagehide"), 0);
  });

  it("dispose() silences and stops the clock", async () => {
    const s = await ready();
    await driveFor(s.d, s.clock, FULL, 300);
    s.d.dispose();
    await run(s.clock, 100);
    assert.equal(s.coyote.state.a, 0);
    const n = s.coyote.tx.writes.length;
    await run(s.clock, 1000);
    assert.equal(s.coyote.tx.writes.length, n);
    assert.equal(s.clock.pending, 0);
  });

  it("polls the battery every 60 s when it can't notify", async () => {
    const s = setup();
    (s.coyote.bat as { properties: unknown }).properties = props({ read: true });
    await s.d.connect();
    await run(s.clock, 400);
    assert.equal(s.coyote.bat.reads, 1);
    s.coyote.bat.readBytes = [12];
    s.clock.advance(60_000);
    await flush();
    assert.equal(s.coyote.bat.reads, 2);
    assert.equal(s.d.status().battery, 12);
  });

  it("follows battery notifications", async () => {
    const s = await ready();
    assert.equal(s.coyote.bat.notifying, true);
    s.coyote.bat.notifyBytes([33]);
    assert.equal(s.d.status().battery, 33);
  });

  it("writes B0 without response", async () => {
    const s = await ready();
    assert.ok(s.coyote.tx.writes.every((w) => w.how === "withoutResponse"));
    assert.equal(s.coyote.tx.uuid, V3_WRITE);
  });
});

describe("Coyote registration", () => {
  it("registers both kinds", () => {
    assert.equal(DRIVERS.get("coyote-v3")?.info.label, "DG-LAB Coyote 3.0");
    assert.equal(DRIVERS.get("coyote-v2")?.info.label, "DG-LAB Coyote 2.0");
    assert.equal(DRIVERS.get("coyote-v3")?.info.description, "E-stim, two channels");
    const f = fakeContext();
    const d = DRIVERS.get("coyote-v3")!.factory(f.ctx);
    assert.equal(d.kind, "coyote-v3");
    assert.equal(d.status().connection, "disconnected");
    d.dispose?.();
  });
});
