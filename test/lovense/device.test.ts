import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createLovenseDevice,
  DEVICE_KEY,
  MSG_INSECURE,
  MSG_NEEDS_CLICK,
  MSG_NO_ADAPTER,
  MSG_NO_BLUETOOTH,
  MSG_NO_SERVICE,
  MSG_NOT_CHOSEN,
  MSG_PERMISSION_DENIED,
  MSG_PICK_AGAIN,
  MSG_POLICY,
  pickKnownDevice,
  WRITE_TIMEOUT_MS,
  type LovenseStatus,
} from "../../src/lovense/device.ts";
import { LOVENSE_SERVICES } from "../../src/lovense/protocol.ts";
import {
  domError,
  FakeBluetooth,
  FakeCharacteristic,
  FakeDevice,
  FakeService,
  fakeToy,
  MemStorage,
  props,
} from "../fakes/bluetooth.ts";
import { FakeClock, flush } from "../fakes/clock.ts";

function setup(opts: { getDevices?: boolean; namePrefix?: string } = {}) {
  const clock = new FakeClock();
  const toy = fakeToy();
  toy.tx.clock = clock;
  const bt = new FakeBluetooth(toy.dev, opts.getDevices ?? true);
  const storage = new MemStorage();
  const dev = createLovenseDevice({
    bluetooth: bt,
    now: clock.now,
    timers: clock,
    storage,
    reconnectDelaysMs: [500, 1000, 5000],
    ...(opts.namePrefix ? { namePrefix: opts.namePrefix } : {}),
  });
  const statuses: LovenseStatus[] = [];
  dev.onStatus((s) => statuses.push(s));
  return { clock, toy, bt, storage, dev, statuses };
}

describe("createLovenseDevice: connect", () => {
  it("picks the toy, finds TX/RX, reads type and battery, starts at 0", async () => {
    const { bt, toy, dev, storage, statuses } = setup();
    await dev.connect();
    await flush();
    assert.equal(bt.requests.length, 1);
    assert.deepEqual(bt.requests[0]!.filters, [{ namePrefix: "LVS-" }, { namePrefix: "LOVE-" }]);
    assert.equal(bt.requests[0]!.optionalServices?.length, LOVENSE_SERVICES.length);
    assert.ok(toy.rx.notifying);
    assert.equal(storage.getItem(DEVICE_KEY), "toy-1");
    const st = dev.status();
    assert.equal(st.connection, "connected");
    assert.equal(st.device, "LVS-Lush42");
    assert.equal(st.model, "Lush");
    assert.equal(st.battery, 85);
    assert.equal(st.level, 0);
    assert.deepEqual(
      toy.tx.writes.map((w) => w.cmd),
      ["Vibrate:0;", "DeviceType;", "Battery;"],
    );
    assert.ok(toy.tx.writes.every((w) => w.how === "withoutResponse"));
    assert.deepEqual(
      statuses.map((s) => s.connection).filter((c, i, a) => a[i - 1] !== c),
      ["connecting", "connected"],
    );
  });

  it("adds the custom name prefix to the picker filters", async () => {
    const { bt, dev } = setup({ namePrefix: "MyToy" });
    await dev.connect();
    assert.deepEqual(bt.requests[0]!.filters?.at(-1), { namePrefix: "MyToy" });
  });

  it("writes with response when the characteristic has no write-without-response", async () => {
    const clock = new FakeClock();
    const tx = new FakeCharacteristic("0000fff2-0000-1000-8000-00805f9b34fb", props({ write: true }));
    const rx = new FakeCharacteristic("0000fff1-0000-1000-8000-00805f9b34fb", props({ notify: true }));
    const d = new FakeDevice("old", "LOVE-01", [new FakeService("0000fff0-0000-1000-8000-00805f9b34fb", [rx, tx])]);
    const dev = createLovenseDevice({ bluetooth: new FakeBluetooth(d), now: clock.now, timers: clock, storage: null });
    await dev.connect();
    await flush();
    assert.equal(dev.status().connection, "connected");
    assert.ok(tx.writes.length > 0);
    assert.ok(tx.writes.every((w) => w.how === "withResponse"));
    assert.equal(rx.writes.length, 0);
  });

  it("serializes level writes with battery polls, rate-limited", async () => {
    const { clock, toy, dev } = setup();
    await dev.connect();
    await flush();
    toy.tx.manual = true;
    clock.advance(59_990);
    dev.setLevel(5);
    await flush();
    dev.setLevel(9);
    clock.advance(20); // the battery poll is due while the write is in flight
    await flush();
    assert.equal(toy.tx.waiting, 1);
    assert.equal(toy.tx.maxInFlight, 1);
    for (let i = 0; i < 5 && toy.tx.waiting > 0; i++) {
      toy.tx.release();
      await flush();
      clock.advance(100);
      await flush();
    }
    assert.equal(toy.tx.maxInFlight, 1);
    const cmds = toy.tx.writes.map((w) => w.cmd).slice(3);
    assert.deepEqual(cmds.filter((c) => c.startsWith("Vibrate")), ["Vibrate:5;", "Vibrate:9;"]);
    assert.ok(cmds.includes("Battery;"));
  });

  it("polls the battery every minute while connected", async () => {
    const { clock, toy, dev } = setup();
    await dev.connect();
    await flush();
    toy.battery = 60;
    clock.advance(60_000);
    await flush();
    assert.equal(dev.status().battery, 60);
    const polls = () => toy.tx.writes.filter((w) => w.cmd === "Battery;").length;
    assert.equal(polls(), 2);
    clock.advance(60_000);
    await flush();
    assert.equal(polls(), 3);
    await dev.disconnect();
    clock.advance(180_000);
    await flush();
    assert.equal(polls(), 3);
  });

  it("emits a status when the sent level changes", async () => {
    const { clock, dev, statuses } = setup();
    await dev.connect();
    await flush();
    clock.advance(200);
    dev.setLevel(12);
    await flush();
    assert.equal(statuses.at(-1)!.level, 12);
    assert.equal(dev.status().level, 12);
  });

  it("parses replies split over notifications", async () => {
    const { toy, dev } = setup();
    toy.tx.onWrite = undefined;
    await dev.connect();
    await flush();
    toy.rx.notifyText("W:0");
    toy.rx.notifyText("5:AABBCCDDEEFF;4");
    toy.rx.notifyText("2;");
    assert.equal(dev.status().model, "Domi");
    assert.equal(dev.status().battery, 42);
  });

  it("reuses a granted device without the picker (silent resume)", async () => {
    const { bt, toy, dev, storage } = setup();
    bt.granted = [toy.dev];
    storage.setItem(DEVICE_KEY, "toy-1");
    await dev.resume();
    assert.equal(bt.requests.length, 0);
    assert.equal(dev.status().connection, "connected");
  });

  it("resume() does nothing without a granted toy and never opens the picker", async () => {
    const { bt, dev, statuses } = setup();
    await dev.resume();
    assert.equal(bt.requests.length, 0);
    assert.equal(dev.status().connection, "disconnected");
    assert.equal(statuses.length, 0);
    const noGetDevices = setup({ getDevices: false });
    await noGetDevices.dev.resume();
    assert.equal(noGetDevices.bt.requests.length, 0);
    assert.equal(noGetDevices.dev.status().connection, "disconnected");
  });

  it("resume() gives a quiet hint when the granted toy is off, without retrying", async () => {
    const { clock, bt, toy, dev } = setup();
    bt.granted = [toy.dev];
    toy.dev.gatt.connectError = domError("NetworkError", "Connection attempt failed.");
    await dev.resume();
    assert.equal(dev.status().connection, "disconnected");
    assert.match(dev.status().message ?? "", /“LVS-Lush42” isn't reachable.*click Connect/);
    clock.advance(10_000);
    await flush();
    assert.equal(toy.dev.gatt.connects, 1);
  });

  it("finds a granted toy by name when none is remembered", () => {
    const a = { id: "a", name: "HR strap" };
    const b = { id: "b", name: "LVS-Hush7" };
    assert.equal(pickKnownDevice([a, b], undefined, undefined), b);
    assert.equal(pickKnownDevice([a, b], "a", undefined), a);
    assert.equal(pickKnownDevice([a], undefined, undefined), undefined);
    assert.equal(pickKnownDevice([a], undefined, "HR"), a);
  });

  it("works without getDevices (feature-detected)", async () => {
    const { bt, dev } = setup({ getDevices: false });
    await dev.connect();
    assert.equal(bt.requests.length, 1);
    assert.equal(dev.status().connection, "connected");
  });

  it("asks to pick again when the granted device lacks our services", async () => {
    const { bt, toy, dev, storage } = setup();
    bt.granted = [toy.dev];
    toy.dev.gatt.allowed = new Set();
    await dev.connect();
    assert.equal(dev.status().connection, "error");
    assert.equal(dev.status().message, MSG_PICK_AGAIN);
    assert.equal(storage.getItem(DEVICE_KEY), null);
    await dev.connect();
    assert.equal(bt.requests.length, 1);
    assert.equal(dev.status().connection, "connected");
  });

  it("says when no Lovense service is found", async () => {
    const clock = new FakeClock();
    const other = new FakeDevice("x", "LVS-Odd", [
      new FakeService("5a300001-0024-4bd4-bbd5-a6920e4c5653", [new FakeCharacteristic("5a300003-0024-4bd4-bbd5-a6920e4c5653", props({ notify: true }))]),
    ]);
    const dev = createLovenseDevice({ bluetooth: new FakeBluetooth(other), now: clock.now, timers: clock, storage: null });
    await dev.connect();
    assert.equal(dev.status().connection, "error");
    assert.equal(dev.status().message, MSG_NO_SERVICE);
    assert.equal(other.gatt.connected, false);

    const none = new FakeDevice("y", "LVS-None", [new FakeService("0000180f-0000-1000-8000-00805f9b34fb", [])]);
    const bt = new FakeBluetooth(none);
    const dev2 = createLovenseDevice({ bluetooth: bt, now: clock.now, timers: clock, storage: null });
    await dev2.connect();
    // the battery service isn't in optionalServices, so the browser exposes nothing
    assert.equal(dev2.status().message, MSG_NO_SERVICE);
  });

  it("never rejects and explains picker failures", async () => {
    const cases: [Error, string][] = [
      [domError("SecurityError", "Must be handling a user gesture to show a permission request."), MSG_NEEDS_CLICK],
      [domError("NotFoundError", "User cancelled the requestDevice() chooser."), MSG_NOT_CHOSEN],
      [domError("NotFoundError", "Bluetooth adapter not available."), MSG_NO_ADAPTER],
      [domError("NotAllowedError", "Bluetooth permission has been blocked."), MSG_PERMISSION_DENIED],
      [domError("SecurityError", 'Access to the feature "bluetooth" is disallowed by permissions policy.'), MSG_POLICY],
    ];
    for (const [err, msg] of cases) {
      const t = setup();
      t.bt.requestResult = err;
      await t.dev.connect();
      assert.equal(t.dev.status().connection, "error");
      assert.equal(t.dev.status().message, msg, err.message);
    }
    assert.match(MSG_NOT_CHOSEN, /Lovense Remote/);
  });

  it("explains a missing Web Bluetooth and insecure pages", async () => {
    const a = createLovenseDevice({ bluetooth: undefined, storage: null, secureContext: true });
    await a.connect();
    assert.equal(a.status().message, MSG_NO_BLUETOOTH);
    const b = createLovenseDevice({ storage: null, secureContext: false });
    await b.connect();
    assert.equal(b.status().message, MSG_INSECURE);
    const c = createLovenseDevice({ storage: null, secureContext: false });
    await c.resume();
    assert.equal(c.status().connection, "disconnected");
    assert.equal(c.status().message, undefined);
  });
});

describe("createLovenseDevice: reconnect and disconnect", () => {
  it("reconnects with backoff after the link drops, while wanted, and restores the level", async () => {
    const { clock, toy, dev } = setup();
    await dev.connect();
    await flush();
    clock.advance(200);
    dev.setLevel(8);
    await flush();
    toy.dev.gatt.connectError = domError("NetworkError", "Connection failed for unknown reason.");
    toy.dev.gatt.drop();
    assert.equal(dev.status().connection, "connecting");
    assert.match(dev.status().message ?? "", /Reconnecting/);
    assert.equal(dev.status().level, undefined);
    clock.advance(500);
    await flush();
    assert.equal(toy.dev.gatt.connects, 2);
    assert.match(dev.status().message ?? "", /attempt 2 in 1 s/);
    clock.advance(1000);
    await flush();
    assert.equal(toy.dev.gatt.connects, 3);
    assert.match(dev.status().message ?? "", /attempt 3 in 5 s/);
    toy.dev.gatt.connectError = undefined;
    clock.advance(5000);
    await flush();
    assert.equal(toy.dev.gatt.connects, 4);
    assert.equal(dev.status().connection, "connected");
    // the wanted level is sent again on the new link
    assert.equal(toy.tx.vibrates().at(-1), "Vibrate:8;");
    // backoff restarts after a successful reconnect
    toy.dev.gatt.drop();
    clock.advance(500);
    await flush();
    assert.equal(dev.status().connection, "connected");
  });

  it("keeps waiting for a picked toy that is switched off", async () => {
    const { clock, toy, dev } = setup();
    toy.dev.gatt.connectError = domError("NetworkError", "Connection attempt failed.");
    await dev.connect();
    assert.equal(dev.status().connection, "connecting");
    assert.match(dev.status().message ?? "", /Waiting for “LVS-Lush42”: turn it on/);
    toy.dev.gatt.connectError = undefined;
    clock.advance(500);
    await flush();
    assert.equal(dev.status().connection, "connected");
  });

  it("disconnect() sends Vibrate:0, closes GATT and stops retrying", async () => {
    const { clock, toy, dev, statuses } = setup();
    await dev.connect();
    await flush();
    clock.advance(200);
    dev.setLevel(14);
    await flush();
    await dev.disconnect();
    assert.equal(toy.tx.vibrates().at(-1), "Vibrate:0;");
    assert.equal(toy.dev.gatt.connected, false);
    assert.equal(toy.rx.notifying, false);
    assert.equal(toy.rx.count("characteristicvaluechanged"), 0);
    assert.equal(dev.status().connection, "disconnected");
    assert.equal(statuses.at(-1)!.connection, "disconnected");
    assert.equal(clock.pending, 0);
  });

  it("disconnect() during reconnect attempts stops them", async () => {
    const { clock, toy, dev } = setup();
    await dev.connect();
    toy.dev.gatt.connectError = domError("NetworkError");
    toy.dev.gatt.drop();
    await dev.disconnect();
    assert.equal(dev.status().connection, "disconnected");
    clock.advance(20_000);
    await flush();
    assert.equal(toy.dev.gatt.connects, 1);
  });

  it("disconnect() doesn't hang on a write that never finishes", async () => {
    const { clock, toy, dev } = setup();
    await dev.connect();
    await flush();
    toy.tx.manual = true;
    clock.advance(200);
    dev.setLevel(10);
    await flush();
    const p = dev.disconnect();
    clock.advance(1000);
    await flush();
    await p;
    assert.equal(toy.dev.gatt.connected, false);
  });

  it("relinks after repeated failed writes", async () => {
    const { clock, toy, dev } = setup();
    await dev.connect();
    await flush();
    toy.tx.writeError = domError("NetworkError", "GATT operation failed for unknown reason.");
    for (let i = 1; i <= 3; i++) {
      clock.advance(150);
      dev.setLevel(i);
      await flush();
    }
    assert.equal(dev.status().connection, "connecting");
    assert.match(dev.status().message ?? "", /Writing to the toy failed.*Reconnecting/);
    toy.tx.writeError = undefined;
    clock.advance(500);
    await flush();
    assert.equal(dev.status().connection, "connected");
    assert.equal(toy.dev.gatt.connects, 2);
  });

  it("times out a hung write", async () => {
    const { clock, toy, dev } = setup();
    await dev.connect();
    await flush();
    toy.tx.manual = true;
    clock.advance(200);
    dev.setLevel(3);
    await flush();
    clock.advance(WRITE_TIMEOUT_MS);
    await flush();
    // the sender retries after the timeout: a second write was attempted
    clock.advance(200);
    await flush();
    assert.ok(toy.tx.writes.filter((w) => w.cmd === "Vibrate:3;").length >= 2);
  });

  it("stopNow() writes Vibrate:0 immediately", async () => {
    const { clock, toy, dev } = setup();
    await dev.connect();
    await flush();
    clock.advance(200);
    dev.setLevel(9);
    await flush();
    const n = toy.tx.writes.length;
    dev.stopNow();
    assert.equal(toy.tx.writes.length, n + 1);
    assert.equal(toy.tx.writes.at(-1)!.cmd, "Vibrate:0;");
  });
});
