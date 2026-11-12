import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ScriptChannel, ToyDevice } from "../../src/devices/types.ts";
import { parseFunscript } from "../../src/funscript/parse.ts";
import { findChannel, scriptChannels } from "../../src/mapping/channels.ts";
import { deviceDefaults, deviceMapping, effectiveMapping } from "../../src/mapping/effective.ts";
import { activeMapping, applyChannelMapping, buildFrame, type FrameSources } from "../../src/mapping/frame.ts";
import { emptySceneMap } from "../../src/mapping/sceneMap.ts";
import { driveDefaultMapping, DRIVE_TARGET_IDS, ESTIM_TARGETS, VIBRATOR_TARGETS } from "../../src/mapping/targets.ts";
import { FakeDevice } from "../fakes/device.ts";

const a = (at: number, pos: number) => ({ at, pos });
const ch = (id: string, pos = 50): ScriptChannel => ({ id, actions: [a(0, pos), a(1000, pos)] });

describe("script channels", () => {
  it("lists the stroke (range applied, inverted kept as a flag) and every embedded axis", () => {
    const f = parseFunscript({
      range: 50,
      inverted: true,
      actions: [a(0, 0), a(100, 50)],
      channels: { VOLUME: [a(0, 10)], e1: { actions: [a(0, 20)], inverted: true } },
    });
    const chans = scriptChannels(f);
    assert.deepEqual(chans.map((c) => c.id), ["stroke", "volume", "e1"]);
    assert.deepEqual(chans[0]!.actions, [a(0, 0), a(100, 100)]);
    assert.equal(chans[0]!.inverted, true);
    assert.deepEqual(chans[2]!.actions, [a(0, 80)], "the parser applies embedded axes' inverted");
  });

  it("lists a stroke taken from an L0 axis once", () => {
    const chans = scriptChannels(parseFunscript({ axes: [{ id: "L0", actions: [a(0, 1)] }, { id: "R1", actions: [a(0, 2)] }] }));
    assert.deepEqual(chans.map((c) => c.id), ["stroke", "r1"]);
    assert.deepEqual(scriptChannels(undefined), []);
  });

  it("finds channels by id or T-Code alias", () => {
    const chans = [ch("stroke"), ch("r1"), ch("volume")];
    assert.equal(findChannel(chans, "ROLL")?.id, "r1");
    assert.equal(findChannel(chans, "l0")?.id, "stroke");
    assert.equal(findChannel(chans, "Volume")?.id, "volume");
    assert.equal(findChannel(chans, "pitch"), undefined);
  });
});

describe("built-in default mapping", () => {
  const chans = [ch("stroke"), ch("volume"), ch("alpha"), ch("e1"), ch("e2"), ch("pulse_frequency"), ch("roll")];

  it("auto-detects like the axisMap setting and puts the stroke on auto", () => {
    assert.deepEqual(driveDefaultMapping(chans, "", DRIVE_TARGET_IDS), {
      volume: { target: "intensity" },
      alpha: { target: "balance" },
      pulse_frequency: { target: "speed" },
      e1: { target: "a" },
      e2: { target: "b" },
      stroke: { target: "auto" },
    });
  });

  it("follows an explicit axisMap instead", () => {
    assert.deepEqual(driveDefaultMapping(chans, "roll=a, volume=bogus", DRIVE_TARGET_IDS), {
      roll: { target: "a" },
      stroke: { target: "auto" },
    });
  });

  it("gives a vibrator the intensity part", () => {
    const vib = VIBRATOR_TARGETS.map((t) => t.id);
    assert.deepEqual(driveDefaultMapping([ch("stroke")], "", vib), { stroke: { target: "intensity" } });
    assert.deepEqual(driveDefaultMapping(chans, "", vib), { volume: { target: "intensity" } });
    assert.deepEqual(driveDefaultMapping([ch("e1"), ch("e2")], "", vib), { e1: { target: "intensity" } });
  });
});

describe("effective mapping", () => {
  const chans = [ch("stroke"), ch("e1"), ch("roll")];
  const defaults = driveDefaultMapping(chans, "", ESTIM_TARGETS.map((t) => t.id));

  it("merges saved entries over the defaults per channel", () => {
    const m = effectiveMapping({ channels: chans, defaults, saved: { e1: { max: 40 }, roll: { target: "b", invert: true }, gone: { target: "a" } } });
    assert.deepEqual(m, {
      stroke: { target: "auto", invert: false, min: 0, max: 100 },
      e1: { target: "a", invert: false, min: 0, max: 40 },
      roll: { target: "b", invert: true, min: 0, max: 100 },
    });
    assert.deepEqual(Object.keys(activeMapping({ ...m, roll: { target: "off" } })), ["stroke", "e1"]);
  });

  it("uses the device's own default, else built-in (DriveFrame) or nothing (self-timed)", () => {
    const coyote = new FakeDevice("coyote-v3");
    assert.deepEqual(deviceDefaults(coyote, chans, ""), { e1: { target: "a" }, stroke: { target: "auto" } });
    const own = Object.assign(new FakeDevice("lovense"), { defaultMapping: () => ({ roll: { target: "intensity" } }) });
    assert.deepEqual(deviceDefaults(own, chans, ""), { roll: { target: "intensity" } });
    const timed = Object.assign(new FakeDevice("tcode"), { selfTimed: true as const }) as unknown as ToyDevice;
    assert.deepEqual(deviceDefaults(timed, chans, ""), {});
    const map = emptySceneMap();
    map.devices.tcode = { mapping: { roll: { target: "R1" } } };
    assert.deepEqual(activeMapping(deviceMapping(timed, chans, map, "")), { roll: { target: "R1", invert: false, min: 0, max: 100 } });
  });
});

describe("frames from a mapping", () => {
  const levels: Record<string, number> = { e1: 0.6, e2: 0.8, alpha: 0.25, freq: 0.1, vol: 0.4 };
  const src = (stroke?: FrameSources["stroke"]): FrameSources => ({ stroke, level: (id) => levels[id] });

  it("lerps and inverts channel values", () => {
    assert.equal(applyChannelMapping(0.5, {}), 0.5);
    assert.equal(applyChannelMapping(0.25, { invert: true }), 0.75);
    assert.ok(Math.abs(applyChannelMapping(0.5, { min: 20, max: 80 }) - 0.5) < 1e-9);
    assert.ok(Math.abs(applyChannelMapping(1, { min: 20, max: 80 }) - 0.8) < 1e-9);
    assert.ok(Math.abs(applyChannelMapping(0, { min: 80, max: 20 }) - 0.8) < 1e-9, "a reversed window flips");
  });

  it("auto follows the stroke for intensity, balance and speed unless mapped", () => {
    const stroke = { intensity: 0.7, balance: 0.3, speed: 0.9 };
    const f = buildFrame({ stroke: { target: "auto" } }, src(stroke), 0, 1);
    assert.deepEqual(f, { intensity: 0.7, balance: 0.3, speed: 0.9, gain: 1 });
    const g = buildFrame({ stroke: { target: "auto" }, alpha: { target: "balance" }, e1: { target: "a" } }, src(stroke), 0, 1);
    assert.deepEqual(g, { intensity: 0.7, balance: 0.25, speed: 0.9, gain: 1, a: 0.6 });
  });

  it("without auto, unmapped parts are neutral; intensity falls back to max(a, b)", () => {
    const f = buildFrame({ e1: { target: "a" }, e2: { target: "b" } }, src(), 0, 1);
    assert.deepEqual(f, { intensity: 0.8, balance: 0.5, speed: 0, gain: 1, a: 0.6, b: 0.8 });
    const s = buildFrame({ stroke: { target: "intensity", max: 50 } }, src({ intensity: 1, balance: 0.2, speed: 1 }), 0, 1);
    assert.deepEqual(s, { intensity: 0.5, balance: 0.5, speed: 0, gain: 1 });
  });

  it("applies pulses and gain to intensity, a and b only", () => {
    const f = buildFrame({ vol: { target: "intensity" }, e1: { target: "a" }, freq: { target: "speed" } }, src(), 1, 0.5);
    assert.deepEqual(f, { intensity: 0.5, balance: 0.5, speed: 0.1, gain: 0.5, a: 0.5 });
  });

  it("treats a channel outside its actions as 0 on a / b / intensity", () => {
    const f = buildFrame({ nope: { target: "a" }, gone: { target: "intensity" } }, src(), 0, 1);
    assert.equal(f.a, 0);
    assert.equal(f.intensity, 0);
  });
});
