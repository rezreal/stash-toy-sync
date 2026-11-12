// Several devices of one kind: instances in the manager, the engine and the binder.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { INSTANCES_KEY } from "../../src/devices/instances.ts";
import { createDeviceManager, type SceneProgramSource } from "../../src/devices/manager.ts";
import { createDriverRegistry, type DriverBaseContext, type DriverContext } from "../../src/devices/registry.ts";
import type { DriveFrame, PlaybackClock, ScriptChannel } from "../../src/devices/types.ts";
import { parseFunscript } from "../../src/funscript/parse.ts";
import { createSceneBinder } from "../../src/mapping/binder.ts";
import { parseSceneMap } from "../../src/mapping/sceneMap.ts";
import { createSceneMapStore } from "../../src/mapping/store.ts";
import { ESTIM_TARGETS } from "../../src/mapping/targets.ts";
import { createVideoClock } from "../../src/player/clock.ts";
import { createSyncEngine } from "../../src/sync/engine.ts";
import { createSettingsStore, DEFAULT_SETTINGS } from "../../src/sync/settings.ts";
import { MemStorage } from "../fakes/bluetooth.ts";
import { FakeClock, flush } from "../fakes/clock.ts";
import { FakeDevice, FakeSelfTimedDevice } from "../fakes/device.ts";

class InstanceDevice extends FakeDevice {
  ctx: DriverContext;
  forgot = 0;
  disposed = 0;
  constructor(ctx: DriverContext) {
    super("coyote-v3", `phys-${ctx.instance.id}`);
    this.ctx = ctx;
  }
  forget(): void {
    this.calls.push("forget");
    this.forgot++;
  }
  dispose(): void {
    this.calls.push("dispose");
    this.disposed++;
  }
  mappingTargets() {
    return ESTIM_TARGETS;
  }
}

function setup(stored?: unknown) {
  const clock = new FakeClock();
  const storage = new MemStorage();
  if (stored !== undefined) storage.setItem(INSTANCES_KEY, JSON.stringify(stored));
  const registry = createDriverRegistry();
  const made: InstanceDevice[] = [];
  const context: DriverBaseContext = { settings: () => DEFAULT_SETTINGS, onSettings: () => () => undefined, timers: clock, now: clock.now };
  registry.register("lovense", () => new FakeDevice("lovense"));
  registry.register("coyote-v3", (ctx) => {
    const d = new InstanceDevice(ctx);
    made.push(d);
    return d;
  }, { label: "Coyote" });
  const manager = createDeviceManager({ context, registry, timers: clock, storage, retryDelaysMs: [1000] });
  const dev = (id: string) => manager.device(id) as InstanceDevice;
  return { clock, storage, registry, manager, made, dev };
}

const frame: DriveFrame = { intensity: 0.5, balance: 0.5, speed: 0.2 };

describe("device instances in the manager", () => {
  it("starts with one instance per registered kind; the first keeps the kind as its id", () => {
    const t = setup();
    assert.deepEqual(t.manager.instances(), [
      { instanceId: "lovense", kind: "lovense", name: "Lovense" },
      { instanceId: "coyote-v3", kind: "coyote-v3", name: "Coyote" },
    ]);
    assert.equal(t.made.length, 1);
    assert.deepEqual(t.made[0]!.ctx.instance.id, "coyote-v3");
    assert.equal(t.made[0]!.ctx.instance.ordinal, 1);
    assert.equal(t.manager.device("coyote-v3"), t.made[0]);
    assert.equal(t.manager.instanceOf(t.made[0]!)?.instanceId, "coyote-v3");
    assert.equal(t.storage.getItem(INSTANCES_KEY), null, "the default list isn't written");
  });

  it("adds instances with the lowest free ordinal and default names, persisted", () => {
    const t = setup();
    const seen: string[][] = [];
    t.manager.onChange((es) => seen.push(es.map((e) => e.instanceId)));
    const two = t.manager.addInstance("coyote-v3")!;
    assert.deepEqual(two, { instanceId: "coyote-v3:2", kind: "coyote-v3", name: "Coyote 2" });
    const three = t.manager.addInstance("coyote-v3", "  Right  ")!;
    assert.deepEqual(three, { instanceId: "coyote-v3:3", kind: "coyote-v3", name: "Right" });
    assert.equal(t.manager.addInstance("tcode"), undefined, "unregistered kind");
    assert.deepEqual(seen.at(-1), ["lovense", "coyote-v3", "coyote-v3:2", "coyote-v3:3"]);
    assert.equal(t.made.length, 3);
    assert.equal(t.made[1]!.ctx.instance.ordinal, 2);
    assert.equal(t.made[1]!.ctx.claims, t.made[0]!.ctx.claims, "one claim registry for the page");
    assert.deepEqual(
      JSON.parse(t.storage.getItem(INSTANCES_KEY)!).map((i: { instanceId: string }) => i.instanceId),
      ["lovense", "coyote-v3", "coyote-v3:2", "coyote-v3:3"],
    );
    // a new page reads the same list back
    const again = createDeviceManager({
      context: { settings: () => DEFAULT_SETTINGS, onSettings: () => () => undefined, timers: t.clock, now: t.clock.now },
      registry: t.registry,
      timers: t.clock,
      storage: t.storage,
    });
    assert.deepEqual(again.instances().map((i) => i.name), ["Lovense", "Coyote", "Coyote 2", "Right"]);
  });

  it("renames instances (live in the driver context) and restores the default for an empty name", () => {
    const t = setup();
    t.manager.addInstance("coyote-v3");
    assert.equal(t.manager.renameInstance("coyote-v3:2", "Left"), true);
    assert.equal(t.manager.instance("coyote-v3:2")?.name, "Left");
    assert.equal(t.made[1]!.ctx.instance.name, "Left");
    assert.deepEqual(t.manager.statuses().find((e) => e.instanceId === "coyote-v3:2")?.name, "Left");
    t.manager.renameInstance("coyote-v3:2", "   ");
    assert.equal(t.manager.instance("coyote-v3:2")?.name, "Coyote 2");
    assert.equal(t.manager.renameInstance("nope", "x"), false);
    assert.match(t.storage.getItem(INSTANCES_KEY)!, /"Coyote 2"/);
  });

  it("removes an extra instance: 0 / disconnect, forget, dispose, claims freed; never the first", async () => {
    const t = setup();
    t.manager.addInstance("coyote-v3");
    const two = t.dev("coyote-v3:2");
    await t.manager.connect("coyote-v3:2");
    two.ctx.claims.claim("BT-2", "coyote-v3:2");
    assert.equal(t.manager.removeInstance("coyote-v3"), false, "the first stays");
    assert.equal(t.manager.removeInstance("coyote-v3:2"), true);
    assert.deepEqual(two.calls, ["connect", "disconnect", "forget", "dispose"]);
    assert.equal(two.ctx.claims.isClaimed("BT-2"), false);
    assert.equal(t.manager.device("coyote-v3:2"), undefined);
    assert.deepEqual(t.manager.instances().map((i) => i.instanceId), ["lovense", "coyote-v3"]);
    assert.doesNotMatch(t.storage.getItem(INSTANCES_KEY)!, /coyote-v3:2/);
    // a dropped link of the removed device isn't retried
    two.setStatus({ connection: "disconnected" });
    t.clock.advance(10_000);
    await flush();
    assert.deepEqual(two.calls, ["connect", "disconnect", "forget", "dispose"]);
    // its ordinal is free again
    assert.equal(t.manager.addInstance("coyote-v3")!.instanceId, "coyote-v3:2");
    assert.notEqual(t.manager.device("coyote-v3:2"), two, "a fresh device");
  });

  it("restores stored instances on start; a kind's first instance exists even when the list lacks it", () => {
    const t = setup([{ instanceId: "coyote-v3:2", kind: "coyote-v3", name: "Right" }]);
    assert.deepEqual(t.manager.instances().map((i) => [i.instanceId, i.name]), [
      ["lovense", "Lovense"],
      ["coyote-v3", "Coyote"],
      ["coyote-v3:2", "Right"],
    ]);
    assert.equal(t.made.length, 2);
  });

  it("connects, disconnects and reports each instance on its own", async () => {
    const t = setup();
    t.manager.addInstance("coyote-v3");
    await t.manager.connect("coyote-v3:2");
    assert.deepEqual(t.dev("coyote-v3").calls, []);
    assert.deepEqual(t.dev("coyote-v3:2").calls, ["connect"]);
    assert.deepEqual(
      t.manager.statuses().map((e) => [e.instanceId, e.name, e.kind, e.id, e.status.connection]),
      [
        ["lovense", "Lovense", "lovense", "lovense-1", "disconnected"],
        ["coyote-v3", "Coyote", "coyote-v3", "phys-coyote-v3", "disconnected"],
        ["coyote-v3:2", "Coyote 2", "coyote-v3", "phys-coyote-v3:2", "connected"],
      ],
    );
    t.manager.disconnect("coyote-v3:2");
    assert.deepEqual(t.dev("coyote-v3:2").calls, ["connect", "disconnect"]);
  });

  it("gives each instance its own frame; stop, nudge and the default frame reach every instance", () => {
    const t = setup();
    t.manager.addInstance("coyote-v3");
    const own: DriveFrame = { intensity: 0.9, balance: 0.1, speed: 0 };
    t.manager.driveAll(frame, new Map([["coyote-v3:2", own]]));
    assert.deepEqual(t.dev("coyote-v3").frames, [frame]);
    assert.deepEqual(t.dev("coyote-v3:2").frames, [own]);
    t.manager.driveAll(null, new Map([["coyote-v3:2", own]]));
    assert.deepEqual(t.dev("coyote-v3:2").frames, [own, null]);
    assert.equal(t.manager.nudgeAll(), 3);
    t.manager.stopAll();
    for (const id of ["coyote-v3", "coyote-v3:2"]) {
      assert.ok(t.dev(id).calls.includes("nudge"));
      assert.ok(t.dev(id).calls.includes("stopNow"));
    }
    t.manager.disconnectAll();
    assert.ok(t.dev("coyote-v3:2").calls.includes("disconnect"));
  });

  it("resumeAll() lets extra instances claim their own device before the first instance looks by name", async () => {
    const t = setup();
    t.manager.addInstance("coyote-v3");
    const extra = t.dev("coyote-v3:2");
    extra.resume = () => {
      extra.calls.push("resume");
      return new Promise<void>(() => undefined); // still connecting
    };
    const done = t.manager.resumeAll();
    await flush();
    assert.deepEqual(extra.calls, ["resume"]);
    assert.deepEqual(t.dev("coyote-v3").calls, [], "the first instance waits");
    t.clock.advance(1000);
    await flush();
    assert.deepEqual(t.dev("coyote-v3").calls, ["resume"], "at most a second");
    void done;
  });

  it("resumeAll() resumes every instance", async () => {
    const t = setup();
    t.manager.addInstance("coyote-v3");
    await t.manager.resumeAll();
    assert.deepEqual(t.dev("coyote-v3").calls, ["resume"]);
    assert.deepEqual(t.dev("coyote-v3:2").calls, ["resume"]);
  });
});

describe("programs per instance", () => {
  const clock: PlaybackClock = { scriptMs: () => 0, playing: () => false, onChange: () => () => undefined };
  const channels: ScriptChannel[] = [{ id: "stroke", actions: [{ at: 0, pos: 0 }] }];

  it("hands each self-timed instance its own mapping and options", () => {
    const t = new FakeClock();
    const registry = createDriverRegistry();
    registry.register("tcode", () => new FakeSelfTimedDevice("tcode"));
    const manager = createDeviceManager({
      context: { settings: () => DEFAULT_SETTINGS, onSettings: () => () => undefined, timers: t, now: t.now },
      registry,
      timers: t,
      storage: new MemStorage(),
    });
    manager.addInstance("tcode");
    const one = manager.device("tcode") as FakeSelfTimedDevice;
    const two = manager.device("tcode:2") as FakeSelfTimedDevice;
    const source: SceneProgramSource = {
      sceneId: "7",
      clock,
      channels,
      mapping: (d) => (d === one ? { stroke: { target: "L0" } } : { stroke: { target: "R2" } }),
      options: (id) => (id === "tcode:2" ? { generate: "strong" } : undefined),
      gain: () => 1,
    };
    manager.setScene(source);
    assert.deepEqual(one.programs.at(-1)!.mapping, { stroke: { target: "L0" } });
    assert.equal(one.programs.at(-1)!.options, undefined);
    assert.deepEqual(two.programs.at(-1)!.mapping, { stroke: { target: "R2" } });
    assert.deepEqual(two.programs.at(-1)!.options, { generate: "strong" });
    assert.deepEqual(manager.program("tcode:2")?.mapping, { stroke: { target: "R2" } });
  });
});

describe("scene mapping per instance", () => {
  const a = (at: number, pos: number) => ({ at, pos });
  const flat = (pos: number) => ({ actions: [a(0, pos), a(60_000, pos)] });

  function rig() {
    const t = new FakeClock();
    const settings = createSettingsStore({ ...DEFAULT_SETTINGS, mode: "position" });
    const registry = createDriverRegistry();
    registry.register("coyote-v3", (ctx) => new InstanceDevice(ctx));
    const manager = createDeviceManager({
      context: { settings: () => settings.get(), onSettings: (cb) => settings.onChange(cb), timers: t, now: t.now },
      registry,
      timers: t,
      storage: new MemStorage(),
    });
    manager.addInstance("coyote-v3");
    const engine = createSyncEngine({ output: { drive: (f, k) => manager.driveAll(f, k) }, now: t.now, timers: t });
    engine.setSettings(settings.get());
    const store = createSceneMapStore({ saveField: async () => undefined });
    const clock = createVideoClock({ root: () => null });
    const binder = createSceneBinder({ manager, engine, store, settings, clock, gain: () => 1 });
    const script = parseFunscript({ actions: [a(0, 0), a(60_000, 0)], channels: { e1: flat(60), e2: flat(20) } });
    return { t, manager, engine, store, binder, script, one: manager.device("coyote-v3")!, two: manager.device("coyote-v3:2")! };
  }

  it("reads an old map (keyed by kind) for the first instance only; the second keeps its default", () => {
    const r = rig();
    const old = JSON.stringify({ v: 1, offsetMs: 0, devices: { "coyote-v3": { mapping: { e1: { target: "b" } } } } });
    r.store.bind("7", { toysync_map: old });
    r.binder.setScene({ sceneId: "7", script: r.script });
    assert.equal(r.binder.mappingFor(r.one).e1!.target, "b");
    assert.equal(r.binder.mappingFor(r.two).e1!.target, "a", "the driver's default, not the first instance's entry");
  });

  it("writes and drives each instance from its own entry, nothing shared", () => {
    const r = rig();
    r.store.bind("7", {});
    r.binder.setScene({ sceneId: "7", script: r.script });
    r.store.setChannel("coyote-v3:2", "e1", { target: "off" });
    r.store.setChannel("coyote-v3:2", "e2", { target: "a", max: 50 });
    assert.equal(r.binder.mappingFor(r.one).e1!.target, "a");
    assert.equal(r.binder.mappingFor(r.two).e1!.target, "off");
    assert.equal(r.binder.mappingFor(r.two).e2!.target, "a");
    r.engine.tick({ playing: true, timeSec: 1 });
    const f1 = r.engine.frameFor("coyote-v3")!;
    const f2 = r.engine.frameFor("coyote-v3:2")!;
    assert.ok(Math.abs(f1.a! - 0.6) < 1e-9, "first: e1 on channel A");
    assert.ok(Math.abs(f2.a! - 0.1) < 1e-9, "second: e2 (20 %) into 0..50 on channel A");
    assert.deepEqual((r.one as InstanceDevice).frames.at(-1), f1);
    assert.deepEqual((r.two as InstanceDevice).frames.at(-1), f2);
    const saved = parseSceneMap(JSON.stringify(r.store.state()!.edit))!;
    assert.deepEqual(Object.keys(saved.devices), ["coyote-v3:2"]);
  });
});
