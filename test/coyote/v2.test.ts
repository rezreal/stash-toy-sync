import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { DriveFrame } from "../../src/devices/types.ts";
import type { CoyoteDevice } from "../../src/coyote/device.ts";
import {
  SILENT_WAVE,
  V2_BATTERY_SERVICE,
  V2_SERVICE,
  V2_STRENGTH,
  V2_WAVE_A,
  V2_WAVE_B,
} from "../../src/coyote/protocol-v2.ts";
import { createCoyoteV2, MSG_V2_NOT_CHOSEN, MSG_V2_WRONG_DEVICE } from "../../src/coyote/v2.ts";
import { domError, FakeBluetooth, FakeDevice, FakeService, MemStorage } from "../fakes/bluetooth.ts";
import { FakeClock, flush } from "../fakes/clock.ts";
import { fakeContext } from "../fakes/context.ts";
import { CAL, fakeCoyote2, type FakeCoyote2Options } from "./fakes.ts";

const FULL: DriveFrame = { intensity: 1, balance: 0.5, speed: 0 };

async function run(clock: FakeClock, ms: number): Promise<void> {
  const end = clock.t + ms;
  while (clock.t < end) {
    await flush(); // writes queued at this instant go out before time moves on
    clock.advance(Math.min(10, end - clock.t));
    await flush();
  }
}

async function driveFor(d: CoyoteDevice, clock: FakeClock, frame: DriveFrame | null, ms: number): Promise<void> {
  const end = clock.t + ms;
  while (clock.t < end) {
    d.drive(frame);
    await run(clock, Math.min(50, end - clock.t));
  }
}

function setup(o: FakeCoyote2Options = {}) {
  const f = fakeContext();
  const coyote = fakeCoyote2(o);
  for (const ch of [coyote.strength, coyote.waveA, coyote.waveB]) ch.clock = f.clock;
  const bt = new FakeBluetooth(coyote.dev);
  const d = createCoyoteV2(f.ctx, { bluetooth: bt, storage: new MemStorage(), worker: null, pageEvents: null });
  return { ...f, coyote, bt, d };
}

async function ready(o: FakeCoyote2Options = {}) {
  const s = setup(o);
  await s.d.connect();
  await flush();
  s.d.setCalibration(CAL);
  await run(s.clock, 400);
  return s;
}

const raw = (bytes: number[] | undefined) => bytes && Array.from(bytes);

describe("Coyote 2.0 connect", () => {
  it("asks for D-LAB devices with the pulse and battery services", async () => {
    const s = setup();
    await s.d.connect();
    assert.deepEqual(s.bt.requests[0], { filters: [{ namePrefix: "D-LAB" }], optionalServices: [V2_SERVICE, V2_BATTERY_SERVICE] });
    assert.equal(s.d.kind, "coyote-v2");
    assert.equal(s.d.id, "c2");
  });

  it("writes strength 0 and silent waveforms first, reads the battery, then goes quiet", async () => {
    const s = setup();
    await s.d.connect();
    await flush();
    const log = s.coyote.counter.log;
    const firstWrite = log.findIndex((u) => !u.startsWith("read:"));
    assert.deepEqual(log.slice(firstWrite, firstWrite + 3), [V2_STRENGTH, V2_WAVE_A, V2_WAVE_B]);
    assert.deepEqual(s.coyote.strengths()[0], { a: 0, b: 0, t: 0 });
    assert.equal(s.coyote.waves("a")[0]!.z, 0);
    assert.equal(s.coyote.waves("b")[0]!.z, 0);
    await run(s.clock, 1000);
    assert.equal(s.coyote.strengths().length, 1, "strength is written only when it changes");
    assert.deepEqual(s.coyote.waves("a").map((w) => w.t), [0, 100, 200, 300]);
    const st = s.d.status();
    assert.equal(st.device, "Coyote 2.0");
    assert.equal(st.battery, 64);
    assert.equal(st.needsCalibration, true);
  });

  it("explains a cancelled picker and a wrong device", async () => {
    const f = fakeContext();
    const d = createCoyoteV2(f.ctx, { bluetooth: new FakeBluetooth(domError("NotFoundError")), storage: null, worker: null, pageEvents: null });
    await d.connect();
    assert.equal(d.status().message, MSG_V2_NOT_CHOSEN);
    const other = new FakeDevice("x", "D-LAB something", [new FakeService(V2_BATTERY_SERVICE, [])]);
    const d2 = createCoyoteV2(f.ctx, { bluetooth: new FakeBluetooth(other), storage: null, worker: null, pageEvents: null });
    await d2.connect();
    assert.equal(d2.status().connection, "error");
    assert.equal(d2.status().message, MSG_V2_WRONG_DEVICE);
  });
});

describe("Coyote 2.0 drive", () => {
  it("packs strength (A << 11 | B) little-endian from level × maxPower / 200 (1400 by default)", async () => {
    const s = await ready();
    await driveFor(s.d, s.clock, FULL, 450);
    // A 60 -> 420, B 50 -> 350: 420 * 2048 + 350 = 0x0d215e
    assert.deepEqual(raw(s.coyote.strength.packets().at(-1)), [0x5e, 0x21, 0x0d]);
    assert.equal(s.coyote.strengths().length, 2, "one zero, one change");
    assert.deepEqual(s.coyote.state, { a: 420, b: 350, echo: true });
    assert.deepEqual(s.d.status().output, { a: 0.3, b: 0.25 });
  });

  it("uses the max power read from 1507", async () => {
    const s = await ready({ config: [7, 0xd0, 0x07] }); // 2000
    assert.equal(s.coyote.config.reads, 1);
    await driveFor(s.d, s.clock, FULL, 200);
    assert.deepEqual(s.coyote.state, { a: 600, b: 500, echo: true });
  });

  it("sends each channel's waveform every 100 ms on its own characteristic (A 1506, B 1505)", async () => {
    const s = await ready();
    const t0 = s.clock.t;
    await driveFor(s.d, s.clock, { intensity: 0, balance: 0.5, speed: 0, a: 1, b: 0 }, 450);
    const a = s.coyote.waves("a").filter((w) => w.t >= t0);
    const b = s.coyote.waves("b").filter((w) => w.t >= t0);
    assert.deepEqual(a.map((w) => w.t - t0), [0, 100, 200, 300, 400]);
    // 10 Hz: X 5, Y 95, Z 12 = 0x060be5
    assert.deepEqual(a.map(({ x, y, z }) => ({ x, y, z })), Array(5).fill({ x: 5, y: 95, z: 12 }));
    assert.deepEqual(raw(s.coyote.waveA.packets().at(-1)), [0xe5, 0x0b, 0x06]);
    assert.ok(b.every((w) => w.z === 0));
    assert.equal(s.coyote.waveA.uuid, V2_WAVE_A);
    assert.equal(s.coyote.waveB.uuid, V2_WAVE_B);
    assert.deepEqual(s.coyote.state, { a: 420, b: 0, echo: true });
  });

  it("goes silent on null and when drive() stops (watchdog)", async () => {
    const s = await ready();
    await driveFor(s.d, s.clock, FULL, 250);
    await driveFor(s.d, s.clock, null, 800);
    assert.equal(s.coyote.state.a, 0);
    assert.deepEqual(s.coyote.waves("a").at(-1)!.z, 0);
    const n = s.coyote.waveA.writes.length;
    await run(s.clock, 500);
    assert.equal(s.coyote.waveA.writes.length, n, "packets stopped");

    const t0 = s.clock.t;
    s.d.drive(FULL);
    await run(s.clock, 1000);
    const ws = s.coyote.waves("a").filter((w) => w.t >= t0);
    assert.deepEqual(ws.filter((w) => w.z === 12).map((w) => w.t - t0), [0, 100, 200, 300]);
    assert.equal(s.coyote.state.a, 0);
  });

  it("adopts a wheel turned down as the ceiling, ignoring echoes of its own writes", async () => {
    const s = await ready();
    await driveFor(s.d, s.clock, FULL, 250);
    assert.equal(s.d.status().message, undefined, "echoes are not wheel turns");
    s.coyote.wheel(350, 350);
    await flush();
    assert.match(s.d.status().message ?? "", /A ≤ 50/);
    await driveFor(s.d, s.clock, FULL, 500);
    assert.ok(s.coyote.strengths().every((w) => w.a <= 420));
    assert.equal(s.coyote.state.a, 350);
    assert.equal(s.d.status().output?.a, 50 / 200);
  });

  it("never has two GATT operations in flight", async () => {
    const s = await ready();
    s.coyote.waveA.manual = true;
    const t0 = s.clock.t;
    await driveFor(s.d, s.clock, FULL, 350);
    assert.equal(s.coyote.waveA.waiting, 1);
    assert.equal(s.coyote.waves("b").filter((w) => w.t >= t0).length, 0, "B waits behind A");
    s.coyote.waveA.manual = false;
    s.coyote.waveA.release();
    await driveFor(s.d, s.clock, FULL, 300);
    assert.equal(s.coyote.counter.max, 1);
  });
});

describe("Coyote 2.0 nudge, test, stop", () => {
  it("nudges with Z 20 at 100 Hz, three bursts at 100 ms resolution", async () => {
    const s = await ready();
    assert.equal(s.d.nudge(), true);
    const t0 = s.clock.t;
    await run(s.clock, 1000);
    const ws = s.coyote.waves("a").filter((w) => w.t >= t0);
    const on = ws.slice(0, 7).map((w) => w.z === 20);
    assert.deepEqual(on, [true, false, false, true, false, true, true]);
    assert.deepEqual({ x: ws[0]!.x, y: ws[0]!.y }, { x: 2, y: 8 });
    // nudge levels 80 / 70 -> 560 / 490
    assert.deepEqual(s.coyote.strengths().find((w) => w.t === t0), { a: 560, b: 490, t: t0 });
    assert.equal(s.coyote.state.a, 0);
  });

  it("tests at the middle level, 50 Hz", async () => {
    const s = await ready();
    const t0 = s.clock.t;
    s.d.test();
    await flush();
    assert.deepEqual(s.coyote.strengths().at(-1), { a: 280, b: 210, t: t0 });
    assert.deepEqual(s.coyote.waves("a").at(-1)!.x + s.coyote.waves("a").at(-1)!.y, 20);
  });

  it("disconnect() writes strength 0 and silence (in that order), then closes", async () => {
    const s = await ready();
    await driveFor(s.d, s.clock, FULL, 250);
    const from = s.coyote.counter.log.length;
    s.d.disconnect();
    await flush();
    assert.deepEqual(s.coyote.counter.log.slice(from, from + 3), [V2_STRENGTH, V2_WAVE_A, V2_WAVE_B]);
    assert.equal(s.coyote.state.a, 0);
    assert.deepEqual(s.coyote.waves("a").at(-1)!.z, SILENT_WAVE.z);
    assert.equal(s.coyote.dev.gatt.connected, false);
    await run(s.clock, 6000);
    assert.equal(s.coyote.dev.gatt.connected, false);
  });

  it("re-writes strength 0 first after a reconnect", async () => {
    const s = await ready();
    await driveFor(s.d, s.clock, FULL, 250);
    s.coyote.dev.gatt.drop();
    const before = s.coyote.strengths().length;
    await driveFor(s.d, s.clock, FULL, 900);
    const after = s.coyote.strengths().slice(before);
    assert.deepEqual({ a: after[0]!.a, b: after[0]!.b }, { a: 0, b: 0 });
    assert.equal(s.coyote.state.a, 420);
  });
});
