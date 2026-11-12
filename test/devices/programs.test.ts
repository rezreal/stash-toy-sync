// Self-timed devices: programs instead of frames; per-kind frames for the others.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createDeviceManager, type SceneProgramSource } from "../../src/devices/manager.ts";
import { createDriverRegistry, type DriverContext } from "../../src/devices/registry.ts";
import type { DriveFrame, PlaybackClock, ScriptChannel } from "../../src/devices/types.ts";
import { DEFAULT_SETTINGS } from "../../src/sync/settings.ts";
import { FakeClock } from "../fakes/clock.ts";
import { FakeDevice, FakeSelfTimedDevice } from "../fakes/device.ts";

const clock: PlaybackClock = { scriptMs: () => 0, playing: () => false, onChange: () => () => undefined };
const channels: ScriptChannel[] = [{ id: "stroke", actions: [{ at: 0, pos: 0 }] }, { id: "roll", actions: [{ at: 0, pos: 50 }] }];

function setup() {
  const t = new FakeClock();
  const registry = createDriverRegistry();
  const context: DriverContext = { settings: () => DEFAULT_SETTINGS, onSettings: () => () => undefined, timers: t, now: t.now };
  registry.register("lovense", () => new FakeDevice("lovense"));
  registry.register("tcode", () => new FakeSelfTimedDevice("tcode"));
  const manager = createDeviceManager({ context, registry, timers: t });
  return { manager, lovense: manager.device("lovense") as FakeDevice, tcode: manager.device("tcode") as FakeSelfTimedDevice, registry };
}

function source(mapping: Record<string, { target: string }>, extra: Partial<SceneProgramSource> = {}): SceneProgramSource {
  return { sceneId: "7", clock, channels, mapping: () => mapping, options: () => undefined, gain: () => 0.5, ...extra };
}

describe("self-timed devices", () => {
  it("never get frames; DriveFrame devices get their kind's frame or the default", () => {
    const t = setup();
    const def: DriveFrame = { intensity: 0.2, balance: 0.5, speed: 0 };
    const own: DriveFrame = { intensity: 0.9, balance: 0.5, speed: 0 };
    t.manager.driveAll(def, new Map([["lovense", own]]));
    t.manager.driveAll(def);
    t.manager.driveAll(null, new Map([["lovense", own]]));
    assert.deepEqual(t.lovense.frames, [own, def, null]);
    assert.deepEqual(t.tcode.frames, []);
  });

  it("get the program when a scene opens, again only when it changes, null when it closes", () => {
    const t = setup();
    assert.equal(t.tcode.programs.length, 0, "nothing before a scene");
    t.manager.setScene(source({ stroke: { target: "L0" }, roll: { target: "off" } }));
    assert.equal(t.tcode.programs.length, 1);
    const p = t.tcode.programs[0]!;
    assert.equal(p.sceneId, "7");
    assert.equal(p.clock, clock);
    assert.equal(p.channels, channels);
    assert.deepEqual(p.mapping, { stroke: { target: "L0" } }, "off channels are left out");
    assert.equal(p.gain(), 0.5);
    t.manager.setScene(source({ stroke: { target: "L0" }, roll: { target: "off" } }));
    assert.equal(t.tcode.programs.length, 1, "unchanged: not sent again");
    t.manager.setScene(source({ stroke: { target: "L0" }, roll: { target: "R1" } }));
    assert.equal(t.tcode.programs.length, 2);
    assert.deepEqual(t.tcode.programs[1]!.mapping, { stroke: { target: "L0" }, roll: { target: "R1" } });
    t.manager.setScene(source({ stroke: { target: "L0" } }, { options: () => ({ generate: "gentle" }) }));
    assert.deepEqual(t.tcode.programs[2]!.options, { generate: "gentle" });
    t.manager.setScene(source({}, { channels: [] }));
    assert.equal(t.tcode.programs[3], null, "a scene without a script");
    t.manager.setScene(null);
    assert.equal(t.tcode.programs.length, 4, "already null");
    assert.equal(t.manager.program("tcode"), null);
  });

  it("gives a device created later the open scene's program; keeps programs of DriveFrame devices for previews", () => {
    const t = setup();
    t.manager.setScene(source({ stroke: { target: "intensity" } }));
    assert.deepEqual(t.manager.program("lovense")?.mapping, { stroke: { target: "intensity" } });
    t.registry.register("piupiu", () => new FakeSelfTimedDevice("piupiu"));
    const late = t.manager.device("piupiu") as FakeSelfTimedDevice;
    assert.equal(late.programs.length, 1);
    assert.equal(late.programs[0]!.sceneId, "7");
  });

  it("still stops, nudges and tests self-timed devices", () => {
    const t = setup();
    t.manager.stopAll();
    t.manager.nudgeAll();
    assert.deepEqual(t.tcode.calls, ["stopNow", "nudge"]);
  });
});
