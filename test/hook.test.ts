import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createStatusBroadcaster, installHook, LEVEL_EVENT_MIN_MS, STATUS_EVENT, type StashLovenseApi } from "../src/hook.ts";
import { parseFunscript } from "../src/funscript/parse.ts";
import { createLovenseDevice, type LovenseStatus } from "../src/lovense/device.ts";
import { createSyncEngine, STOP_HOLD_MS } from "../src/sync/engine.ts";
import { createGainCombiner, GAIN_EVENT } from "../src/sync/gain.ts";
import { DEFAULT_SETTINGS } from "../src/sync/settings.ts";
import { FakeBluetooth, fakeToy, MemStorage } from "./fakes/bluetooth.ts";
import { FakeClock, flush } from "./fakes/clock.ts";

function captured(target: EventTarget) {
  const events: LovenseStatus[] = [];
  target.addEventListener(STATUS_EVENT, (e) => events.push((e as CustomEvent<LovenseStatus>).detail));
  return events;
}

describe("status broadcaster", () => {
  it("dispatches status changes right away", () => {
    const clock = new FakeClock();
    const target = new EventTarget();
    const events = captured(target);
    const b = createStatusBroadcaster(target, { timers: clock, now: clock.now });
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
    const events = captured(target);
    const b = createStatusBroadcaster(target, { timers: clock, now: clock.now });
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
    const events = captured(target);
    const b = createStatusBroadcaster(target, { timers: clock, now: clock.now });
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

describe("installHook", () => {
  it("exposes window.stashToySync (and the stashLovense alias), gain events and status events", async () => {
    const clock = new FakeClock();
    const toy = fakeToy();
    const device = createLovenseDevice({ bluetooth: new FakeBluetooth(toy.dev), now: clock.now, timers: clock, storage: new MemStorage() });
    const gains = createGainCombiner();
    const win = new EventTarget() as EventTarget & { stashToySync?: StashLovenseApi; stashLovense?: StashLovenseApi };
    const events = captured(win);
    const uninstall = installHook(win, { device, gains, timers: clock, now: clock.now });
    const api = win.stashToySync!;
    assert.equal(win.stashLovense, api, "deprecated alias");
    assert.equal(api.version, 1);
    assert.equal(api.status().connection, "disconnected");
    api.connect();
    await flush();
    assert.equal(api.status().connection, "connected");
    assert.equal(events.at(-1)!.connection, "connected");
    assert.equal(events.at(-1)!.model, "Lush");

    win.dispatchEvent(new CustomEvent(GAIN_EVENT, { detail: { source: "skilltree", gain: 0.25 } }));
    assert.equal(gains.gain(), 0.25);

    uninstall();
    assert.equal(win.stashToySync, undefined);
    assert.equal(win.stashLovense, undefined);
    win.dispatchEvent(new CustomEvent(GAIN_EVENT, { detail: { source: "skilltree", gain: 1 } }));
    assert.equal(gains.gain(), 0.25);
  });
});

describe("end to end: script -> engine -> device", () => {
  function rig() {
    const clock = new FakeClock();
    const toy = fakeToy();
    toy.tx.clock = clock;
    const device = createLovenseDevice({ bluetooth: new FakeBluetooth(toy.dev), now: clock.now, timers: clock, storage: null });
    const gains = createGainCombiner();
    const engine = createSyncEngine({ output: device, gain: () => gains.gain(), now: clock.now, timers: clock });
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
