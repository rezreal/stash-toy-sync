// The open scene's mapping applied end to end: real engine, manager and store, fake devices.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createDeviceManager } from "../../src/devices/manager.ts";
import { createDriverRegistry, type DriverContext } from "../../src/devices/registry.ts";
import type { PlaybackEvent } from "../../src/devices/types.ts";
import { parseFunscript } from "../../src/funscript/parse.ts";
import { createSceneBinder } from "../../src/mapping/binder.ts";
import { createSceneMapStore } from "../../src/mapping/store.ts";
import { ESTIM_TARGETS, VIBRATOR_TARGETS } from "../../src/mapping/targets.ts";
import { createVideoClock } from "../../src/player/clock.ts";
import { createSyncEngine } from "../../src/sync/engine.ts";
import { createSettingsStore, DEFAULT_SETTINGS } from "../../src/sync/settings.ts";
import { FakeClock } from "../fakes/clock.ts";
import { FakeDevice, FakeSelfTimedDevice } from "../fakes/device.ts";

const a = (at: number, pos: number) => ({ at, pos });
const flat = (pos: number) => ({ actions: [a(0, pos), a(60_000, pos)] });

function setup() {
  const t = new FakeClock();
  const settings = createSettingsStore({ ...DEFAULT_SETTINGS, mode: "position" });
  const context: DriverContext = { settings: () => settings.get(), onSettings: (cb) => settings.onChange(cb), timers: t, now: t.now };
  const registry = createDriverRegistry();
  registry.register("lovense", () => Object.assign(new FakeDevice("lovense"), { mappingTargets: () => VIBRATOR_TARGETS }));
  registry.register("coyote-v3", () => Object.assign(new FakeDevice("coyote-v3"), { mappingTargets: () => ESTIM_TARGETS }));
  registry.register("tcode", () =>
    Object.assign(new FakeSelfTimedDevice("tcode"), { defaultMapping: () => ({ stroke: { target: "L0" } }) }),
  );
  const manager = createDeviceManager({ context, registry, timers: t });
  const engine = createSyncEngine({ output: { drive: (f, k) => manager.driveAll(f, k) }, now: t.now, timers: t });
  engine.setSettings(settings.get());
  const store = createSceneMapStore({ saveField: async () => undefined });
  const clock = createVideoClock({ root: () => null });
  const events: PlaybackEvent[] = [];
  clock.onChange((e) => events.push(e));
  const binder = createSceneBinder({ manager, engine, store, settings, clock, gain: () => 1 });
  const dev = <T extends FakeDevice>(k: "lovense" | "coyote-v3" | "tcode") => manager.device(k) as T;
  return { t, manager, engine, store, clock, binder, events, dev };
}

const script = () =>
  parseFunscript({ actions: [a(0, 0), a(60_000, 0)], channels: { e1: flat(60), roll: flat(30) } });

describe("scene binder", () => {
  it("sends self-timed devices their program and DriveFrame devices their own frames", () => {
    const s = setup();
    s.store.bind("7", {});
    s.binder.setScene({ sceneId: "7", script: script() });
    const tcode = s.dev<FakeSelfTimedDevice>("tcode");
    assert.equal(tcode.programs.length, 1);
    assert.deepEqual(tcode.programs[0]!.mapping, { stroke: { target: "L0", invert: false, min: 0, max: 100 } });
    assert.deepEqual(s.events, ["scene"]);

    s.engine.tick({ playing: true, timeSec: 5 });
    const lov = s.dev("lovense").frames.at(-1)!;
    const coy = s.dev("coyote-v3").frames.at(-1)!;
    assert.equal(lov.a, undefined, "a vibrator's mapping has no channel A");
    assert.equal(coy.a, 0.6, "e1 -> a from auto-detection");
    assert.equal(coy.intensity, 1, "stroke on auto: depth 1 in position mode");
    assert.deepEqual(tcode.frames, []);
  });

  it("applies live edits right away, offsets to engine and clock", () => {
    const s = setup();
    s.store.bind("7", {});
    s.binder.setScene({ sceneId: "7", script: script() });
    s.store.setChannel("tcode", "roll", { target: "R1", invert: true });
    const tcode = s.dev<FakeSelfTimedDevice>("tcode");
    assert.equal(tcode.programs.length, 2);
    assert.deepEqual(tcode.programs[1]!.mapping.roll, { target: "R1", invert: true, min: 0, max: 100 });
    s.store.setChannel("lovense", "roll", { target: "intensity" });
    s.store.setChannel("lovense", "stroke", { target: "off" });
    s.engine.tick({ playing: true, timeSec: 5 });
    assert.ok(Math.abs(s.dev("lovense").frames.at(-1)!.intensity - 0.3) < 1e-9);
    assert.deepEqual(s.binder.mappingFor(s.dev("lovense")).stroke, { target: "off", invert: false, min: 0, max: 100 });
    s.store.setOffset(250);
    assert.equal(s.clock.offsetMs(), 250);
    assert.deepEqual(s.events, ["scene", "seek"]);
    assert.equal(tcode.programs.length, 2, "an offset alone doesn't change the program");
  });

  it("clears programs when the scene closes or has no script", () => {
    const s = setup();
    s.binder.setScene({ sceneId: "7", script: script() });
    s.binder.setScene({ sceneId: "7", script: undefined });
    const tcode = s.dev<FakeSelfTimedDevice>("tcode");
    assert.equal(tcode.programs.at(-1), null);
    s.binder.setScene({ sceneId: "8", script: script() });
    assert.equal(tcode.programs.at(-1)!.sceneId, "8");
    s.binder.setScene(undefined);
    assert.equal(tcode.programs.at(-1), null);
    assert.equal(s.engine.hasScript(), false);
  });

  it("keeps the old behaviour without a saved mapping (default frame = per-kind frame)", () => {
    const s = setup();
    s.binder.setScene({ sceneId: "7", script: script() });
    s.engine.tick({ playing: true, timeSec: 5 });
    const def = s.engine.frame()!;
    assert.deepEqual(s.dev("coyote-v3").frames.at(-1), def);
    assert.equal(s.dev("lovense").frames.at(-1)!.intensity, def.intensity);
  });
});
