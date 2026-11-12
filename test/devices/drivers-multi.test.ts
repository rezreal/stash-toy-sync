// Two instances of one driver kind: each remembers and reconnects its own
// device, never one the other holds, and a picked device that is already
// connected as the other instance is refused. Fakes only.
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { calibrationKey } from "../../src/devices/calibration.ts";
import { createClaimRegistry } from "../../src/devices/claims.ts";
import type { InstanceInfo } from "../../src/devices/instances.ts";
import { createCoyoteV3 } from "../../src/coyote/v3.ts";
import { DEVICE_KEY as LOVENSE_KEY } from "../../src/lovense/device.ts";
import { createLovenseToy, type LovenseToy } from "../../src/lovense/toy.ts";
import { createPiupiuDevice, DEVICE_KEY as PIUPIU_KEY, LEGACY_DEVICE_KEY, PIUPIU, type PiupiuDevice } from "../../src/piupiu/device.ts";
import { createTcodeDevice, type TcodeDevice } from "../../src/tcode/device.ts";
import { LEGACY_PORT_KEY, PORT_KEY, portId } from "../../src/tcode/engine.ts";
import { createMemoryProfileStore, createSharedProfileStore, PROFILE_KEY, PROFILES_KEY } from "../../src/tcode/profileStore.ts";
import type { SerialLike, SerialPortLike } from "../../src/tcode/serial.d.ts";
import { FakeBluetooth, FakeCharacteristic, FakeDevice, FakeService, fakeToy, MemStorage, props } from "../fakes/bluetooth.ts";
import { FakeClock, flush } from "../fakes/clock.ts";
import { fakeContext } from "../fakes/context.ts";
import { CAL, fakeCoyote3 } from "../coyote/fakes.ts";

const names: Record<string, string> = {};
function instances(kind: string, labels: [string, string]) {
  const claims = createClaimRegistry((id) => names[id]);
  const one: InstanceInfo = { id: kind, name: labels[0], ordinal: 1 };
  const two: InstanceInfo = { id: `${kind}:2`, name: labels[1], ordinal: 2 };
  names[one.id] = labels[0];
  names[two.id] = labels[1];
  return { claims, one, two };
}

describe("Lovense: two instances", () => {
  function rig() {
    const clock = new FakeClock();
    const a = fakeToy({ id: "toy-A", name: "LVS-A" });
    const b = fakeToy({ id: "toy-B", name: "LVS-B" });
    const bt = new FakeBluetooth(a.dev);
    bt.granted = [a.dev, b.dev];
    const storage = new MemStorage();
    const { claims, one, two } = instances("lovense", ["Left", "Right"]);
    const make = (instance: InstanceInfo) =>
      createLovenseToy(fakeContext({}, clock, { instance, claims }).ctx, {
        deviceOptions: { bluetooth: bt, storage, timers: clock, now: clock.now, reconnectDelaysMs: [500] },
      });
    return { clock, a, b, bt, storage, claims, make, one, two };
  }

  it("keeps the first instance on the old key (upgrade) and the second on its own", async () => {
    const r = rig();
    r.storage.setItem(LOVENSE_KEY, "toy-A");
    const first = r.make(r.one);
    const second = r.make(r.two);
    assert.equal(first.id, "toy-A", "remembered from before instances");
    assert.equal(second.id, "lovense:2", "nothing remembered yet");
    await Promise.all([first.resume!(), second.resume!()]);
    await flush();
    assert.equal(first.status().connection, "connected");
    assert.equal(second.status().connection, "disconnected", "the second never grabs a toy by name");
    assert.equal(r.b.dev.gatt.connects, 0);
    assert.equal(r.bt.requests.length, 0, "no picker on resume");

    // the second picks toy B: remembered under its own key, the old key untouched
    r.bt.requestResult = r.b.dev;
    await second.connect();
    await flush();
    assert.equal(second.status().connection, "connected");
    assert.equal(r.storage.getItem("lovense.device.lovense:2"), "toy-B");
    assert.equal(r.storage.getItem(LOVENSE_KEY), "toy-A");
  });

  it("resumes each instance's own toy, and never one the other holds", async () => {
    const r = rig();
    r.storage.setItem(LOVENSE_KEY, "toy-A");
    r.storage.setItem("lovense.device.lovense:2", "toy-B");
    const first = r.make(r.one);
    const second = r.make(r.two);
    await Promise.all([second.resume!(), first.resume!()]);
    await flush();
    assert.equal(first.status().connection, "connected");
    assert.equal(second.status().connection, "connected");
    assert.equal(r.claims.holder("toy-A"), "lovense");
    assert.equal(r.claims.holder("toy-B"), "lovense:2");

    // both remember A: the second leaves it alone
    const r2 = rig();
    r2.storage.setItem(LOVENSE_KEY, "toy-A");
    r2.storage.setItem("lovense.device.lovense:2", "toy-A");
    const x = r2.make(r2.one);
    const y = r2.make(r2.two);
    await x.resume!();
    await y.resume!();
    await flush();
    assert.equal(x.status().connection, "connected");
    assert.equal(y.status().connection, "disconnected");
    assert.equal(r2.a.dev.gatt.connects, 1);
  });

  it("refuses a picked toy that is connected as the other instance, and frees it on disconnect", async () => {
    const r = rig();
    const first = r.make(r.one);
    const second = r.make(r.two);
    await first.connect();
    await flush();
    assert.equal(first.status().connection, "connected");
    await second.connect(); // the picker returns toy A again
    await flush();
    assert.equal(second.status().connection, "error");
    assert.match(second.status().message!, /^Already connected as "Left"/);
    assert.equal(r.a.dev.gatt.connected, true, "the first keeps its link");
    assert.equal(first.status().connection, "connected");

    first.disconnect();
    await flush();
    r.clock.advance(1000);
    await flush();
    assert.equal(r.claims.isClaimed("toy-A"), false);
    await second.connect();
    await flush();
    assert.equal(second.status().connection, "connected");
    assert.equal(r.claims.holder("toy-A"), "lovense:2");
    // the first still knows toy A, but neither reuses nor closes it
    first.disconnect();
    await flush();
    r.clock.advance(1000);
    await flush();
    assert.equal(r.a.dev.gatt.connected, true);
    assert.equal(second.status().connection, "connected");
  });

  it("forgets its remembered toy and releases its claim on dispose", async () => {
    const r = rig();
    r.bt.requestResult = r.b.dev;
    const second: LovenseToy = r.make(r.two);
    await second.connect();
    await flush();
    assert.equal(r.storage.getItem("lovense.device.lovense:2"), "toy-B");
    second.disconnect();
    second.forget!();
    second.dispose!();
    await flush();
    r.clock.advance(1000);
    await flush();
    assert.equal(r.storage.getItem("lovense.device.lovense:2"), null);
    assert.equal(r.claims.isClaimed("toy-B"), false);
  });
});

describe("Coyote 3.0: two instances", () => {
  function rig() {
    const clock = new FakeClock();
    const c1 = fakeCoyote3({ id: "c3-A" });
    const c2 = fakeCoyote3({ id: "c3-B" });
    const bt = new FakeBluetooth(c1.dev);
    bt.granted = [c1.dev, c2.dev];
    const storage = new MemStorage();
    const { claims, one, two } = instances("coyote-v3", ["Coyote 1", "Coyote 2"]);
    const made: ReturnType<typeof createCoyoteV3>[] = [];
    const make = (instance: InstanceInfo) => {
      const d = createCoyoteV3(fakeContext({}, clock, { instance, claims }).ctx, { bluetooth: bt, storage, worker: null, pageEvents: null });
      made.push(d);
      return d;
    };
    return { clock, c1, c2, bt, storage, claims, make, one, two, made };
  }

  it("resumes each instance's own device: the first from the old key, the second from its own", async () => {
    const r = rig();
    r.storage.setItem("toysync.coyote-v3.device", "c3-A");
    r.storage.setItem("toysync.coyote-v3.device.coyote-v3:2", "c3-B");
    const first = r.make(r.one);
    const second = r.make(r.two);
    await Promise.all([second.resume(), first.resume()]);
    await flush();
    assert.equal(first.status().connection, "connected");
    assert.equal(second.status().connection, "connected");
    assert.equal(first.id, "c3-A");
    assert.equal(second.id, "c3-B");
    // calibration stays per physical device
    second.setCalibration(CAL);
    assert.ok(r.storage.getItem(calibrationKey("coyote-v3", "c3-B")));
    assert.equal(r.storage.getItem(calibrationKey("coyote-v3", "c3-A")), null);
    for (const d of r.made) d.dispose();
  });

  it("an extra instance with nothing remembered doesn't grab a granted Coyote; neither takes one the other holds", async () => {
    const r = rig();
    r.storage.setItem("toysync.coyote-v3.device", "c3-A");
    const first = r.make(r.one);
    const second = r.make(r.two);
    assert.equal(second.id, "coyote-v3:2");
    await first.resume();
    await second.resume();
    await flush();
    assert.equal(first.status().connection, "connected");
    assert.equal(second.status().connection, "disconnected");
    assert.equal(r.c2.dev.gatt.connects, 0);
    // remembered by both: still only the first has it
    r.storage.setItem("toysync.coyote-v3.device.coyote-v3:2", "c3-A");
    await second.resume();
    await flush();
    assert.equal(second.status().connection, "disconnected");
    assert.equal(r.c1.dev.gatt.connects, 1);
    for (const d of r.made) d.dispose();
  });

  it("refuses a picked Coyote connected as the other instance", async () => {
    const r = rig();
    const first = r.make(r.one);
    const second = r.make(r.two);
    await first.connect();
    await flush();
    await second.connect();
    await flush();
    assert.equal(second.status().connection, "error");
    assert.match(second.status().message!, /^Already connected as "Coyote 1"/);
    assert.equal(first.status().connection, "connected");
    assert.equal(r.c1.dev.gatt.connected, true);
    // the second picks the other one
    r.bt.requestResult = r.c2.dev;
    await second.connect();
    await flush();
    assert.equal(second.status().connection, "connected");
    assert.equal(r.storage.getItem("toysync.coyote-v3.device.coyote-v3:2"), "c3-B");
    assert.equal(r.storage.getItem("toysync.coyote-v3.device"), "c3-A");
    second.forget!();
    assert.equal(r.storage.getItem("toysync.coyote-v3.device.coyote-v3:2"), null);
    for (const d of r.made) d.dispose();
    await flush();
    assert.equal(r.claims.isClaimed("c3-A") || r.claims.isClaimed("c3-B"), false, "dispose releases");
  });
});

// --- TCode -----------------------------------------------------------------------------

class Port implements SerialPortLike {
  readable: ReadableStream<Uint8Array> | null = null;
  writable: WritableStream<Uint8Array> | null = null;
  opened = 0;
  getInfo() {
    return { usbVendorId: 0x10c4, usbProductId: 0xea60 };
  }
  async open() {
    this.opened++;
    this.readable = new ReadableStream();
    this.writable = new WritableStream<Uint8Array>();
  }
  async close() {
    this.readable = null;
    this.writable = null;
  }
}

describe("TCode: two instances", () => {
  const made: TcodeDevice[] = [];
  afterEach(async () => {
    for (const d of made.splice(0)) {
      await d.engine._cleanup(null);
      d.dispose();
    }
  });

  function rig() {
    const p1 = new Port();
    const p2 = new Port();
    let picked: SerialPortLike = p1;
    const serial: SerialLike = { getPorts: async () => [p1, p2], requestPort: async () => picked, addEventListener() {} };
    const storage = new MemStorage();
    const { claims, one, two } = instances("tcode", ["Stroker", "Second stroker"]);
    const make = (instance: InstanceInfo) => {
      const d = createTcodeDevice(fakeContext({}, new FakeClock(), { instance, claims }).ctx, {
        engine: { serial, secure: true, storage },
        store: createMemoryProfileStore(),
        log: { warn() {}, info() {} },
      });
      made.push(d);
      return d;
    };
    return { p1, p2, serial, storage, claims, make, one, two, pick: (p: SerialPortLike) => (picked = p) };
  }

  it("remembers the port per instance; only the first reads TCode Player's key", async () => {
    const r = rig();
    r.storage.setItem(LEGACY_PORT_KEY, portId(r.p1));
    const first = r.make(r.one);
    const second = r.make(r.two);
    await second.engine.autoConnect();
    assert.equal(second.status().connection, "disconnected", "TCode Player's port isn't the second's");
    await first.engine.autoConnect();
    assert.equal(first.status().connection, "connected");
    assert.equal(r.storage.getItem(PORT_KEY), portId(r.p1));
    r.pick(r.p2);
    await second.connect();
    assert.equal(second.status().connection, "connected");
    assert.equal(r.storage.getItem(`${PORT_KEY}.tcode:2`), portId(r.p2));
    second.forget!();
    assert.equal(r.storage.getItem(`${PORT_KEY}.tcode:2`), null);
    assert.equal(r.storage.getItem(PORT_KEY), portId(r.p1));
  });

  it("refuses a picked port connected as the other instance; auto-connect takes the free one", async () => {
    const r = rig();
    const first = r.make(r.one);
    const second = r.make(r.two);
    await first.connect(); // p1
    assert.equal(first.status().connection, "connected");
    await second.connect(); // the picker returns p1 again
    assert.equal(second.status().connection, "error");
    assert.match(second.status().message!, /^Already connected as "Stroker"/);
    assert.equal(r.p1.opened, 1);
    // both boards report the same USB ids: auto-connect skips the held port and takes the other
    r.storage.setItem(`${PORT_KEY}.tcode:2`, portId(r.p1));
    await second.engine.autoConnect();
    assert.equal(second.status().connection, "connected");
    assert.equal(r.p2.opened, 1);
    // closing releases the claim
    await first.engine._cleanup(null);
    r.pick(r.p1);
    const third = r.make({ id: "tcode:3", name: "Third", ordinal: 3 });
    await third.connect();
    assert.equal(third.status().connection, "connected");
  });

  it("keeps a profile per instance: the second in tcodeProfiles, without TCode Player's", async () => {
    const plugins: Record<string, Record<string, unknown>> = {
      toysync: { mode: "speed", [PROFILE_KEY]: '{"model":"sr6"}' },
      TCodePlayer: { profile: '{"model":"ssr1"}' },
    };
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
      const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200 });
      if (body.query.includes("configurePlugin")) {
        plugins[body.variables.plugin_id as string] = body.variables.input as Record<string, unknown>;
        return json({ data: { configurePlugin: body.variables.input } });
      }
      const out: Record<string, unknown> = {};
      for (const id of body.variables.include as string[]) if (plugins[id]) out[id] = plugins[id];
      return json({ data: { configuration: { plugins: out } } });
    }) as typeof fetch;
    const o = { fetchImpl, baseUrl: "https://host/", afterWrite: () => undefined };
    const first = createSharedProfileStore(undefined, o);
    const second = createSharedProfileStore("tcode:2", o);
    const third = createSharedProfileStore("tcode:3", o);
    assert.deepEqual(await first.load(), { model: "sr6" });
    assert.equal(await second.load(), undefined, "a new instance starts from the default");
    assert.equal(await second.loadLegacy(), undefined);
    assert.deepEqual(await first.loadLegacy(), { model: "ssr1" });
    await Promise.all([second.save({ model: "osr2" }), third.save({ model: "ssr1" })]);
    assert.deepEqual(JSON.parse(plugins.toysync![PROFILES_KEY] as string), { "tcode:2": { model: "osr2" }, "tcode:3": { model: "ssr1" } });
    assert.equal(plugins.toysync![PROFILE_KEY], '{"model":"sr6"}', "the first instance's profile is untouched");
    assert.equal(plugins.toysync!.mode, "speed");
    assert.deepEqual(await second.load(), { model: "osr2" });
  });
});

// --- PiuPiu ----------------------------------------------------------------------------

describe("PiuPiu: two instances", () => {
  const made: PiupiuDevice[] = [];
  afterEach(() => {
    for (const d of made.splice(0)) {
      d.disconnect();
      d.dispose();
    }
  });

  function launcher(id: string) {
    const tx = new FakeCharacteristic(String(PIUPIU.tx), props({ write: true }));
    return new FakeDevice(id, "Hismith Piupiu", [new FakeService(String(PIUPIU.service), [tx])]);
  }

  function rig() {
    const l1 = launcher("piu-A");
    const l2 = launcher("piu-B");
    const bt = new FakeBluetooth(l1);
    bt.granted = [l1, l2];
    const storage = new MemStorage();
    const { claims, one, two } = instances("piupiu", ["Lube", "Lube 2"]);
    const make = (instance: InstanceInfo) => {
      const d = createPiupiuDevice(fakeContext({}, new FakeClock(), { instance, claims }).ctx, {
        bluetooth: bt,
        storage,
        oldPluginPresent: () => false,
        log: { warn() {}, info() {} },
      });
      made.push(d);
      return d;
    };
    return { l1, l2, bt, storage, claims, make, one, two };
  }

  it("remembers per instance (only the first reads TCode Player's key) and refuses the other's launcher", async () => {
    const r = rig();
    r.storage.setItem(LEGACY_DEVICE_KEY, "piu-A");
    const first = r.make(r.one);
    const second = r.make(r.two);
    await second.resume();
    assert.equal(second.status().connection, "disconnected");
    await first.resume();
    assert.equal(first.status().connection, "connected");
    assert.equal(r.storage.getItem(PIUPIU_KEY), "piu-A");
    await second.connect(); // the picker returns piu-A
    assert.equal(second.status().connection, "error");
    assert.match(second.status().message!, /^Already connected as "Lube"/);
    r.bt.requestResult = r.l2;
    await second.connect();
    assert.equal(second.status().connection, "connected");
    assert.equal(r.storage.getItem(`${PIUPIU_KEY}.piupiu:2`), "piu-B");
    second.forget!();
    assert.equal(r.storage.getItem(`${PIUPIU_KEY}.piupiu:2`), null);
    first.disconnect();
    assert.equal(r.claims.isClaimed("piu-A"), false);
  });
});
