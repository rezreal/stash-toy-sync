// A Coyote that never answers must not leave its status on "connecting", a
// Connect click must replace a stuck attempt, two instances set their links
// up one at a time, and with two granted Coyotes the picker decides (never a
// guess). Fakes only.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createClaimRegistry } from "../../src/devices/claims.ts";
import type { InstanceInfo } from "../../src/devices/instances.ts";
import { createCoyoteV3 } from "../../src/coyote/v3.ts";
import { CONNECT_TIMEOUT_MS, MSG_WAITING_TURN } from "../../src/coyote/link.ts";
import type { BluetoothRemoteGATTServer } from "../../src/lovense/bluetooth.d.ts";
import { FakeBluetooth, MemStorage } from "../fakes/bluetooth.ts";
import { FakeClock, flush } from "../fakes/clock.ts";
import { fakeContext } from "../fakes/context.ts";
import { fakeCoyote3 } from "../coyote/fakes.ts";

function rig(granted: "both" | "one" = "both") {
  const clock = new FakeClock();
  const c1 = fakeCoyote3({ id: "c3-A" });
  const c2 = fakeCoyote3({ id: "c3-B" });
  const bt = new FakeBluetooth(c1.dev);
  bt.granted = granted === "both" ? [c1.dev, c2.dev] : [c1.dev];
  const storage = new MemStorage();
  const claims = createClaimRegistry((id) => (id === "coyote-v3" ? "Coyote 1" : "Coyote 2"));
  const one: InstanceInfo = { id: "coyote-v3", name: "Coyote 1", ordinal: 1 };
  const two: InstanceInfo = { id: "coyote-v3:2", name: "Coyote 2", ordinal: 2 };
  const made: ReturnType<typeof createCoyoteV3>[] = [];
  const make = (instance: InstanceInfo) => {
    const d = createCoyoteV3(fakeContext({}, clock, { instance, claims }).ctx, { bluetooth: bt, storage, worker: null, pageEvents: null });
    made.push(d);
    return d;
  };
  return { clock, c1, c2, bt, storage, claims, one, two, make, made, done: () => made.forEach((d) => d.dispose()) };
}

/** replaces gatt.connect() with one that takes `turns` microtask turns, counting how many run at once */
function slowConnect(servers: { dev: { gatt: BluetoothRemoteGATTServer & { connect(): Promise<BluetoothRemoteGATTServer> } } }[], turns = 12) {
  const probe = { inFlight: 0, max: 0 };
  for (const s of servers) {
    const real = s.dev.gatt.connect.bind(s.dev.gatt);
    s.dev.gatt.connect = async () => {
      probe.inFlight++;
      probe.max = Math.max(probe.max, probe.inFlight);
      for (let i = 0; i < turns; i++) await Promise.resolve();
      probe.inFlight--;
      return real();
    };
  }
  return probe;
}

describe("a Coyote that never answers", () => {
  it("a silent resume gives up after the connect timeout instead of hanging on connecting", async () => {
    const r = rig();
    r.storage.setItem("toysync.coyote-v3.device", "c3-A");
    let aborted = 0;
    r.c1.dev.gatt.connect = () => new Promise(() => undefined);
    r.c1.dev.gatt.disconnect = () => void aborted++;
    const first = r.make(r.one);
    const resumed = first.resume();
    await flush();
    assert.equal(first.status().connection, "connecting");
    r.clock.advance(CONNECT_TIMEOUT_MS);
    await resumed;
    await flush();
    assert.equal(first.status().connection, "disconnected");
    assert.match(first.status().message ?? "", /isn't reachable/);
    assert.equal(aborted, 1, "the pending connect is aborted so the browser lets go of the device");
    assert.equal(r.claims.isClaimed("c3-A"), false, "the claim is given back");
    r.done();
  });

  it("an explicit Connect keeps retrying with a message, never a silent hang", async () => {
    const r = rig("one");
    r.storage.setItem("toysync.coyote-v3.device", "c3-A");
    r.c1.dev.gatt.connect = () => new Promise(() => undefined);
    const first = r.make(r.one);
    void first.connect();
    await flush();
    r.clock.advance(CONNECT_TIMEOUT_MS);
    await flush();
    assert.equal(first.status().connection, "connecting");
    assert.match(first.status().message ?? "", /Waiting for the Coyote.*Trying again/);
    r.done();
  });

  it("a Connect click replaces an attempt stuck in setting up", async () => {
    const r = rig("one");
    r.storage.setItem("toysync.coyote-v3.device", "c3-A");
    const real = r.c1.dev.gatt.connect.bind(r.c1.dev.gatt);
    let calls = 0;
    r.c1.dev.gatt.connect = () => (++calls === 1 ? new Promise(() => undefined) : real());
    const first = r.make(r.one);
    void first.connect();
    await flush();
    assert.equal(first.status().connection, "connecting");
    const again = first.connect();
    await flush();
    await again;
    await flush();
    assert.equal(calls, 2, "a second connect was started");
    assert.equal(first.status().connection, "connected");
    r.done();
  });
});

describe("two Coyotes connecting at once", () => {
  it("set their links up one at a time, and the second says it is waiting", async () => {
    const r = rig();
    r.storage.setItem("toysync.coyote-v3.device", "c3-A");
    r.storage.setItem("toysync.coyote-v3.device.coyote-v3:2", "c3-B");
    const probe = slowConnect([r.c1, r.c2]);
    const first = r.make(r.one);
    const second = r.make(r.two);
    const seen: string[] = [];
    first.onStatus((s) => seen.push(s.message ?? ""));
    second.onStatus((s) => seen.push(s.message ?? ""));
    await Promise.all([second.resume(), first.resume()]);
    await flush();
    assert.equal(probe.max, 1, "never two GATT connects at once");
    assert.equal(first.status().connection, "connected");
    assert.equal(second.status().connection, "connected");
    assert.ok(seen.includes(MSG_WAITING_TURN), "the queued one says it waits for its turn");
    r.done();
  });

  it("a stuck connect doesn't hold the other one up for longer than its timeout", async () => {
    const r = rig();
    r.storage.setItem("toysync.coyote-v3.device", "c3-A");
    r.storage.setItem("toysync.coyote-v3.device.coyote-v3:2", "c3-B");
    r.c2.dev.gatt.connect = () => new Promise(() => undefined);
    const first = r.make(r.one);
    const second = r.make(r.two);
    const both = Promise.all([second.resume(), first.resume()]);
    await flush();
    assert.notEqual(first.status().connection, "connected", "still queued behind the stuck one");
    r.clock.advance(CONNECT_TIMEOUT_MS);
    await both;
    await flush();
    assert.equal(first.status().connection, "connected");
    assert.equal(second.status().connection, "disconnected");
    r.done();
  });
});

describe("picking a Coyote with nothing remembered", () => {
  it("shows the picker when two granted Coyotes match, instead of guessing one", async () => {
    const r = rig("both");
    const first = r.make(r.one);
    await first.connect();
    await flush();
    assert.equal(r.bt.requests.length, 1, "the picker decided");
    assert.equal(first.status().connection, "connected");
    r.done();
  });

  it("still connects without the picker when exactly one granted Coyote matches", async () => {
    const r = rig("one");
    const first = r.make(r.one);
    await first.connect();
    await flush();
    assert.equal(r.bt.requests.length, 0);
    assert.equal(first.status().connection, "connected");
    r.done();
  });

  it("a silent resume with two candidates and nothing remembered takes neither", async () => {
    const r = rig("both");
    const first = r.make(r.one);
    await first.resume();
    await flush();
    assert.equal(first.status().connection, "disconnected");
    assert.equal(r.c1.dev.gatt.connects + r.c2.dev.gatt.connects, 0);
    r.done();
  });
});
