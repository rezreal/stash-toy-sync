import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createDeviceManager } from "../src/devices/manager.ts";
import { createDriverRegistry } from "../src/devices/registry.ts";
import {
  createStatusBroadcaster,
  installHook,
  LEGACY_STATUS_EVENT,
  LEVEL_EVENT_MIN_MS,
  NUDGE_EVENT,
  NUDGE_RESULT_EVENT,
  readNudgeDetail,
  stableLovenseKey,
  STATUS_EVENT,
  type HookWindow,
  type NudgeResultDetail,
  type ToySyncStatus,
} from "../src/hook.ts";
import { parseFunscript } from "../src/funscript/parse.ts";
import { createLovenseDevice, type LovenseStatus } from "../src/lovense/device.ts";
import { createLovenseToy } from "../src/lovense/toy.ts";
import { createSyncEngine, STOP_HOLD_MS } from "../src/sync/engine.ts";
import { createGainCombiner, GAIN_EVENT, LEGACY_GAIN_EVENT } from "../src/sync/gain.ts";
import { createNudgeLimiter } from "../src/sync/nudge.ts";
import { DEFAULT_SETTINGS } from "../src/sync/settings.ts";
import { FakeBluetooth, fakeToy, MemStorage } from "./fakes/bluetooth.ts";
import { FakeClock, flush } from "./fakes/clock.ts";
import { fakeContext } from "./fakes/context.ts";
import { FakeDevice } from "./fakes/device.ts";

function captured<T>(target: EventTarget, event: string) {
  const events: T[] = [];
  target.addEventListener(event, (e) => events.push((e as CustomEvent<T>).detail));
  return events;
}

function legacyBroadcaster(target: EventTarget, clock: FakeClock) {
  return createStatusBroadcaster<LovenseStatus>(target, { event: LEGACY_STATUS_EVENT, stable: stableLovenseKey, timers: clock, now: clock.now });
}

describe("status broadcaster", () => {
  it("dispatches status changes right away", () => {
    const clock = new FakeClock();
    const target = new EventTarget();
    const events = captured<LovenseStatus>(target, LEGACY_STATUS_EVENT);
    const b = legacyBroadcaster(target, clock);
    b.push({ connection: "connecting" });
    b.push({ connection: "connected", device: "LVS-Lush42", level: 0 });
    b.push({ connection: "connected", device: "LVS-Lush42", level: 0, battery: 80 });
    assert.deepEqual(
      events.map((e) => e.connection),
      ["connecting", "connected", "connected"],
    );
    assert.equal(events.at(-1)!.battery, 80);
  });

  it("throttles level-only changes to 5 per second, keeping the latest", () => {
    const clock = new FakeClock();
    const target = new EventTarget();
    const events = captured<LovenseStatus>(target, LEGACY_STATUS_EVENT);
    const b = legacyBroadcaster(target, clock);
    b.push({ connection: "connected", level: 0 });
    for (let i = 1; i <= 20; i++) {
      clock.advance(50);
      b.push({ connection: "connected", level: i });
    }
    clock.advance(LEVEL_EVENT_MIN_MS);
    // 1 s of changes every 50 ms -> about 5 events plus the first
    assert.ok(events.length <= 7, `${events.length} events`);
    assert.equal(events.at(-1)!.level, 20, "the last level is always delivered");
    for (let i = 2; i < events.length; i++) assert.notEqual(events[i]!.level, events[i - 1]!.level);
  });

  it("a non-level change flushes immediately", () => {
    const clock = new FakeClock();
    const target = new EventTarget();
    const events = captured<LovenseStatus>(target, LEGACY_STATUS_EVENT);
    const b = legacyBroadcaster(target, clock);
    b.push({ connection: "connected", level: 0 });
    clock.advance(10);
    b.push({ connection: "connected", level: 5 });
    assert.equal(events.length, 1);
    b.push({ connection: "disconnected" });
    assert.equal(events.length, 2);
    assert.equal(events.at(-1)!.connection, "disconnected");
    clock.advance(1000);
    assert.equal(events.length, 2, "the pending level event was superseded");
  });
});

/** a hook on a fake window with fake devices and a real engine */
function hookRig(opts: { sceneOpen?: boolean } = {}) {
  const clock = new FakeClock();
  const registry = createDriverRegistry();
  const coyote = new FakeDevice("coyote-v3", "c-1");
  const other = new FakeDevice("coyote-v2", "c-2");
  other.canNudge = false;
  registry.register("coyote-v3", () => coyote);
  registry.register("coyote-v2", () => other);
  const { ctx } = fakeContext({}, clock);
  const manager = createDeviceManager({ context: ctx, registry, timers: clock });
  const gains = createGainCombiner();
  const engine = createSyncEngine({ output: { drive: (f) => manager.driveAll(f) }, gain: () => gains.gain(), now: clock.now, timers: clock });
  gains.onChange(() => engine.refresh());
  const nudges = createNudgeLimiter(clock.now);
  let sceneOpen = opts.sceneOpen ?? true;
  const win = new EventTarget() as HookWindow;
  const statuses = captured<ToySyncStatus>(win, STATUS_EVENT);
  const results = captured<NudgeResultDetail>(win, NUDGE_RESULT_EVENT);
  const uninstall = installHook(win, { manager, engine, gains, nudges, sceneOpen: () => sceneOpen, timers: clock, now: clock.now });
  const nudge = (detail: unknown = { source: "skilltree", reason: "missed" }) =>
    win.dispatchEvent(new CustomEvent(NUDGE_EVENT, { detail }));
  const info = console.info;
  return {
    clock, coyote, other, manager, gains, engine, nudges, win, statuses, results, uninstall, nudge,
    setScene: (v: boolean) => (sceneOpen = v),
    quiet: () => {
      console.info = () => undefined;
      return () => (console.info = info);
    },
  };
}

describe("hook contract v2", () => {
  it("exposes window.stashToySync version 2 with status() and connect(kind)", async () => {
    const r = hookRig();
    const api = r.win.stashToySync!;
    assert.equal(api.version, 2);
    assert.equal(r.win.stashLovense, undefined, "no legacy alias without the Lovense driver");
    assert.deepEqual(
      api.status().devices.map((d) => [d.kind, d.id, d.status.connection]),
      [
        ["coyote-v3", "c-1", "disconnected"],
        ["coyote-v2", "c-2", "disconnected"],
      ],
    );
    assert.equal(api.status().frame, null);
    assert.equal(api.status().gain, 1);
    api.connect("coyote-v3");
    await flush();
    assert.deepEqual(r.coyote.calls, ["connect"]);
    assert.equal(r.statuses.at(-1)!.devices[0]!.status.connection, "connected");
    r.uninstall();
    assert.equal(r.win.stashToySync, undefined);
  });

  it("lists every instance with its id and name; connect() takes a kind or an instance id", async () => {
    const clock = new FakeClock();
    const registry = createDriverRegistry();
    const made: FakeDevice[] = [];
    registry.register("coyote-v3", (ctx) => {
      const d = new FakeDevice("coyote-v3", `phys-${ctx.instance.id}`);
      made.push(d);
      return d;
    }, { label: "Coyote" });
    const manager = createDeviceManager({ context: fakeContext({}, clock).ctx, registry, timers: clock, storage: new MemStorage() });
    manager.addInstance("coyote-v3", "Right");
    const engine = createSyncEngine({ output: { drive: (f) => manager.driveAll(f) }, now: clock.now, timers: clock });
    const win = new EventTarget() as HookWindow;
    const statuses = captured<ToySyncStatus>(win, STATUS_EVENT);
    const uninstall = installHook(win, {
      manager,
      engine,
      gains: createGainCombiner(),
      nudges: createNudgeLimiter(clock.now),
      sceneOpen: () => true,
      timers: clock,
      now: clock.now,
    });
    const api = win.stashToySync!;
    assert.deepEqual(
      api.status().devices.map((d) => [d.instanceId, d.name, d.kind, d.id]),
      [
        ["coyote-v3", "Coyote", "coyote-v3", "phys-coyote-v3"],
        ["coyote-v3:2", "Right", "coyote-v3", "phys-coyote-v3:2"],
      ],
    );
    api.connect("coyote-v3:2");
    await flush();
    assert.deepEqual(made[1]!.calls, ["connect"]);
    assert.deepEqual(made[0]!.calls, []);
    api.connect("coyote-v3");
    await flush();
    assert.deepEqual(made[0]!.calls, ["connect"]);
    manager.renameInstance("coyote-v3:2", "Left");
    assert.equal(statuses.at(-1)!.devices[1]!.name, "Left", "a rename is a status change");
    uninstall();
  });

  it("takes gain from toysync:gain and the legacy lovense:gain, as a product of sources", () => {
    const r = hookRig();
    r.win.dispatchEvent(new CustomEvent(GAIN_EVENT, { detail: { source: "skilltree", gain: 0.5 } }));
    r.win.dispatchEvent(new CustomEvent(LEGACY_GAIN_EVENT, { detail: { source: "old", gain: 0.5 } }));
    assert.equal(r.gains.gain(), 0.25);
    assert.equal(r.statuses.at(-1)!.gain, 0.25);
    r.win.dispatchEvent(new CustomEvent(GAIN_EVENT, { detail: { source: "old", gain: null } }));
    assert.equal(r.gains.gain(), 0.5);
    r.uninstall();
    r.win.dispatchEvent(new CustomEvent(GAIN_EVENT, { detail: { source: "skilltree", gain: 1 } }));
    assert.equal(r.gains.gain(), 0.5);
  });

  it("forwards a nudge to every device and answers with the result", () => {
    const r = hookRig();
    r.nudge();
    assert.deepEqual(r.results, [{ source: "skilltree", reason: "missed", accepted: true, devices: 1 }]);
    assert.deepEqual(r.coyote.calls, ["nudge"]);
    assert.deepEqual(r.other.calls, ["nudge"], "asked, but it has no nudge");
  });

  it("drops nudges inside the cooldown, over the minute cap, and without a scene", () => {
    const r = hookRig();
    const restore = r.quiet();
    try {
      r.nudge();
      r.clock.advance(3999);
      r.nudge();
      assert.equal(r.results.at(-1)!.dropped, "cooldown");
      // a request every 4 s for 56 s more: the rolling minute caps them at 6
      for (let i = 0; i < 14; i++) {
        r.clock.advance(4000);
        r.nudge();
      }
      assert.equal(r.results.filter((x) => x.accepted).length, 6);
      assert.ok(r.results.some((x) => x.dropped === "rate"));
      r.setScene(false);
      r.clock.advance(120_000);
      r.nudge();
      assert.equal(r.results.at(-1)!.dropped, "no-scene");
      r.nudge({ reason: "no source" });
      assert.equal(r.results.at(-1)!.dropped, "invalid");
      assert.equal(r.coyote.calls.filter((c) => c === "nudge").length, r.results.filter((x) => x.accepted).length);
    } finally {
      restore();
    }
  });

  it("emits toysync:status with the frame, output-only changes throttled to 5/s", () => {
    const r = hookRig();
    r.engine.setSettings({ ...DEFAULT_SETTINGS, mode: "position" });
    r.engine.setScript(parseFunscript({ actions: [{ at: 0, pos: 100 }, { at: 60_000, pos: 0 }] }));
    const before = r.statuses.length;
    for (let i = 0; i <= 20; i++) {
      r.engine.tick({ playing: true, timeSec: 1 + i * 0.05 });
      r.clock.advance(50);
    }
    r.clock.advance(LEVEL_EVENT_MIN_MS);
    const n = r.statuses.length - before;
    assert.ok(n >= 2 && n <= 8, `${n} events for 1 s of playback`);
    const last = r.statuses.at(-1)!;
    assert.ok(last.frame && last.frame.intensity > 0);
    assert.deepEqual(r.win.stashToySync!.status().frame, r.engine.frame());
    r.engine.stop();
    assert.equal(r.statuses.at(-1)!.frame, null, "silence is reported right away");
  });

  it("reads nudge requests leniently", () => {
    assert.deepEqual(readNudgeDetail({ source: " st ", reason: 5 }), { source: "st", reason: "" });
    assert.equal(readNudgeDetail({ source: "" }), undefined);
    assert.equal(readNudgeDetail(null), undefined);
    assert.equal(readNudgeDetail("skilltree"), undefined);
  });
});

describe("legacy Lovense contract", () => {
  it("keeps window.stashLovense (version 1) and lovense:status for one version", async () => {
    const clock = new FakeClock();
    const toy = fakeToy();
    const device = createLovenseDevice({ bluetooth: new FakeBluetooth(toy.dev), now: clock.now, timers: clock, storage: new MemStorage() });
    const lovense = createLovenseToy(fakeContext({}, clock).ctx, { device });
    const registry = createDriverRegistry();
    registry.register("lovense", () => lovense);
    const manager = createDeviceManager({ context: fakeContext({}, clock).ctx, registry, timers: clock });
    const engine = createSyncEngine({ output: { drive: (f) => manager.driveAll(f) }, now: clock.now, timers: clock });
    const win = new EventTarget() as HookWindow;
    const legacy = captured<LovenseStatus>(win, LEGACY_STATUS_EVENT);
    const uninstall = installHook(win, {
      manager,
      engine,
      gains: createGainCombiner(),
      nudges: createNudgeLimiter(clock.now),
      sceneOpen: () => true,
      legacy: { status: () => lovense.legacyStatus(), onStatus: (cb) => lovense.onLegacyStatus(cb), connect: () => void manager.connect("lovense") },
      timers: clock,
      now: clock.now,
    });
    const old = win.stashLovense!;
    assert.equal(old.version, 1);
    assert.equal(old.deprecated, true);
    old.connect();
    await flush();
    assert.equal(old.status().connection, "connected");
    assert.equal(legacy.at(-1)!.connection, "connected");
    assert.equal(legacy.at(-1)!.model, "Lush");
    assert.equal(win.stashToySync!.status().devices[0]!.status.connection, "connected");
    uninstall();
    assert.equal(win.stashLovense, undefined);
  });
});

describe("end to end: script -> engine -> device", () => {
  function rig() {
    const clock = new FakeClock();
    const toy = fakeToy();
    toy.tx.clock = clock;
    const device = createLovenseDevice({ bluetooth: new FakeBluetooth(toy.dev), now: clock.now, timers: clock, storage: null });
    const lovense = createLovenseToy(fakeContext({}, clock).ctx, { device });
    const gains = createGainCombiner();
    const engine = createSyncEngine({ output: lovense, gain: () => gains.gain(), now: clock.now, timers: clock });
    gains.onChange(() => engine.refresh());
    engine.setSettings({ ...DEFAULT_SETTINGS, mode: "position" });
    // deepest the whole minute: full level while playing
    engine.setScript(parseFunscript({ actions: [{ at: 0, pos: 0 }, { at: 60_000, pos: 0 }] }));
    const tick = async (playing: boolean, timeSec: number) => {
      engine.tick({ playing, timeSec });
      await flush();
      clock.advance(50);
      await flush();
    };
    return { clock, toy, device, gains, engine, tick };
  }

  it("plays, then a quick pause/resume still sends Vibrate:0", async () => {
    const r = rig();
    await r.device.connect();
    await flush();
    r.clock.advance(200);
    let t = 1;
    for (let i = 0; i < 4; i++) await r.tick(true, (t += 0.05));
    assert.equal(r.toy.tx.vibrates().at(-1), "Vibrate:20;");
    await r.tick(false, t);
    for (let i = 0; i < 6; i++) await r.tick(true, (t += 0.05));
    const v = r.toy.tx.vibrates();
    assert.deepEqual(v.slice(-2), ["Vibrate:0;", "Vibrate:20;"]);
    assert.ok(STOP_HOLD_MS > 100);
  });

  it("gain 0 from another plugin sends 0 right away; removing it restores", async () => {
    const r = rig();
    await r.device.connect();
    await flush();
    r.clock.advance(200);
    let t = 1;
    for (let i = 0; i < 4; i++) await r.tick(true, (t += 0.05));
    r.gains.set("skilltree", 0);
    await flush();
    r.clock.advance(100);
    await flush();
    assert.equal(r.toy.tx.vibrates().at(-1), "Vibrate:0;");
    r.gains.set("skilltree", null);
    for (let i = 0; i < 4; i++) await r.tick(true, (t += 0.05));
    assert.equal(r.toy.tx.vibrates().at(-1), "Vibrate:20;");
  });

  it("never writes more than one level per 100 ms", async () => {
    const r = rig();
    r.engine.setSettings({ ...DEFAULT_SETTINGS, mode: "speed", speedFull: 1500 });
    const actions = [];
    for (let at = 0; at <= 60_000; at += 70) actions.push({ at, pos: (at / 70) % 2 ? 100 : (at * 7) % 100 });
    r.engine.setScript(parseFunscript({ actions }));
    await r.device.connect();
    await flush();
    let t = 0;
    for (let i = 0; i < 100; i++) await r.tick(true, (t += 0.05));
    const times = r.toy.tx.writes.filter((w) => w.cmd.startsWith("Vibrate")).map((w) => w.t!);
    assert.ok(times.length > 5, `${times.length} writes`);
    for (let i = 1; i < times.length; i++) assert.ok(times[i]! - times[i - 1]! >= 100, `writes at ${times[i - 1]} and ${times[i]}`);
  });
});
