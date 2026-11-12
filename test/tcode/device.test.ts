// The TCode driver against Toy Sync's contract: program and clock, the scene
// mapping, stop / pause / scene changes, actions, profile migration and the
// TCode Player detection. A mounted 3D preview (a fake emulator) is the
// virtual device, as in TCode Player.
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { tcodePlayerPresent } from "../../src/tcode/coexist.ts";
import { defaultProfile, normalizeProfile } from "../../src/tcode/core.ts";
import { createTcodeDevice, type TcodeDevice } from "../../src/tcode/device.ts";
import type { IntervalTimers } from "../../src/tcode/engine.ts";
import { createMemoryProfileStore, type TcodeProfileStore } from "../../src/tcode/profileStore.ts";
import { FakeClock, flush } from "../fakes/clock.ts";
import { fakeProgram, FakeVideo, scriptChannels } from "../fakes/playback.ts";

const quiet = { warn() {}, info() {} };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const made: TcodeDevice[] = [];
afterEach(() => {
  for (const d of made.splice(0)) {
    d.setProgram(null);
    d.dispose();
  }
});

function make(opts: { store?: TcodeProfileStore; timers?: IntervalTimers } = {}) {
  const device = createTcodeDevice(undefined, {
    engine: { serial: undefined, secure: true, storage: null, oldPluginPresent: () => false, ...(opts.timers ? { timers: opts.timers } : {}) },
    store: opts.store ?? createMemoryProfileStore(),
    log: quiet,
  });
  made.push(device);
  const lines: string[] = [];
  const emu = { write: (l: string) => lines.push(l.trim()) };
  return { device, engine: device.engine, lines, emu };
}

const STROKE_HIGH = { actions: [{ at: 0, pos: 100 }, { at: 60000, pos: 100 }] };

describe("mapping targets and default mapping", () => {
  it("offers the preset's active axes, grouped", async () => {
    const { device } = make();
    await device.ready();
    const targets = device.mappingTargets();
    assert.deepEqual(targets.map((t) => t.id), ["L0", "R0", "R1", "R2", "V0", "V1", "A0", "A1", "A2"]);
    assert.deepEqual(targets[0], { id: "L0", label: "L0 Stroke", group: "Linear" });
    assert.equal(targets.find((t) => t.id === "R1")!.group, "Rotation");
    assert.equal(targets.find((t) => t.id === "A2")!.label, "A2 Lube");
    assert.equal(targets.find((t) => t.id === "A2")!.group, "Auxiliary");
  });

  it("maps stroke to L0 and known names / TCode ids to their axes, active axes only", async () => {
    const { device } = make();
    await device.ready();
    const acts = [{ at: 0, pos: 0 }];
    const chs = ["stroke", "roll", "r2", "surge", "snap", "lube"].map((id) => ({ id, actions: acts }));
    assert.deepEqual(device.defaultMapping(chs), { stroke: { target: "L0" }, roll: { target: "R1" }, r2: { target: "R2" }, lube: { target: "A2" } });
    await device.saveProfile({ ...device.profile(), model: "sr6" });
    assert.deepEqual(device.defaultMapping(chs).surge, { target: "L1" });
  });
});

describe("playback", () => {
  it("ramps in, then follows the mapped channel with invert and range applied", async () => {
    const { device, engine, lines, emu } = make();
    await device.ready();
    engine.addEmulator(emu);
    const video = new FakeVideo({ advancing: true });
    device.setProgram(fakeProgram({ clock: video, script: STROKE_HIGH, mapping: { stroke: { target: "L0", invert: true, min: 20, max: 80 } } }));
    video.play();
    await wait(80);
    assert.equal(lines[0], "L02000I400", "first command ramps over rampMs to the inverted, ranged value");
    assert.equal(engine.state.playing, true);
  });

  it("sends nothing for channels the scene mapping leaves out", async () => {
    const { device, engine, lines, emu } = make();
    await device.ready();
    engine.addEmulator(emu);
    const video = new FakeVideo({ advancing: true });
    device.setProgram(fakeProgram({ clock: video, script: STROKE_HIGH, mapping: {} }));
    video.play();
    await wait(60);
    assert.deepEqual(lines, []);
  });

  it("stops on pause, homes when the profile says so, and ramps again on play", async () => {
    const { device, engine, lines, emu } = make();
    await device.ready();
    await device.saveProfile({ ...device.profile(), homeOnPause: true });
    engine.addEmulator(emu);
    const video = new FakeVideo({ advancing: true });
    device.setProgram(fakeProgram({ clock: video, script: STROKE_HIGH, device }));
    video.play();
    await wait(50);
    video.pause();
    assert.equal(lines.at(-1), "L05000I800", "home on pause");
    const n = lines.length;
    await wait(60);
    assert.equal(lines.length, n, "no frames while paused");
    video.play();
    await wait(450); // the first ramp's hold runs out first (as in TCode Player)
    assert.match(lines[n]!, /^L09999I400$/);
  });

  it("goes home and lets go of the clock when the scene closes", async () => {
    const { device, engine, lines, emu } = make();
    await device.ready();
    engine.addEmulator(emu);
    const video = new FakeVideo({ advancing: true });
    device.setProgram(fakeProgram({ clock: video, script: STROKE_HIGH, device }));
    assert.equal(video.subscribers, 1);
    video.play();
    await wait(40);
    device.setProgram(null);
    assert.equal(lines.at(-1), "L05000I800");
    assert.equal(video.subscribers, 0);
    assert.deepEqual(engine.state.channels, []);
  });

  it("stopNow homes and stays quiet until playback starts again", async () => {
    const { device, engine, lines, emu } = make();
    await device.ready();
    engine.addEmulator(emu);
    const video = new FakeVideo({ advancing: true });
    device.setProgram(fakeProgram({ clock: video, script: STROKE_HIGH, device }));
    video.play();
    await wait(40);
    device.stopNow();
    assert.equal(lines.at(-1), "L05000I600");
    const n = lines.length;
    await wait(300);
    assert.equal(lines.length, n);
    video.play();
    await wait(450);
    assert.ok(lines.length > n);
  });

  it("drive() does nothing and there is no nudge", async () => {
    const { device, lines, engine, emu } = make();
    engine.addEmulator(emu);
    device.drive({ intensity: 1, balance: 0.5, speed: 1 });
    assert.deepEqual(lines, []);
    assert.equal(device.nudge(), false);
    assert.equal(device.selfTimed, true);
  });

  it("fills in missing axes at the scene's generate level", async () => {
    const { device, engine } = make();
    await device.ready();
    const video = new FakeVideo();
    const script = { actions: Array.from({ length: 20 }, (_, i) => ({ at: i * 500, pos: i % 2 ? 100 : 0 })) };
    device.setProgram(fakeProgram({ clock: video, script, device, options: { generate: "medium" } }));
    assert.deepEqual(engine.state.channels.map((c) => c.name), ["stroke", "pitch", "roll", "twist"]);
    assert.deepEqual(engine.state.mapping.map((m) => m.axis), ["L0", "R2", "R1", "R0"]);
    device.setProgram(fakeProgram({ clock: video, script, device }));
    assert.deepEqual(engine.state.channels.map((c) => c.name), ["stroke"], "absent = the profile's level (off)");
  });
});

describe("actions", () => {
  it("Home and Motion on/off", async () => {
    const { device, engine, lines, emu } = make();
    await device.ready();
    engine.addEmulator(emu);
    const acts = device.actions();
    assert.deepEqual(acts.map((a) => a.label), ["Home", "Motion off"]);
    acts[0]!.run();
    assert.equal(lines.at(-1), "L05000I800");
    acts[1]!.run();
    assert.equal(engine.state.outputEnabled, false);
    assert.equal(lines.at(-1), "L05000I600");
    assert.equal(device.actions()[1]!.label, "Motion on");
  });
});

/** a FakeClock with intervals, for the multi-second Test sweep */
class FakeIntervals extends FakeClock implements IntervalTimers {
  setInterval(fn: () => void, ms: number): unknown {
    const h = { id: undefined as unknown };
    const run = () => {
      h.id = this.setTimeout(run, ms);
      fn();
    };
    h.id = this.setTimeout(run, ms);
    return h;
  }
  clearInterval(h: unknown): void {
    this.clearTimeout((h as { id: unknown }).id);
  }
}

describe("testChannel", () => {
  it("sweeps the channel's axis through its mapped range, then back to the middle", async () => {
    const clock = new FakeIntervals();
    const { device, engine, lines, emu } = make({ timers: clock });
    await device.ready();
    engine.addEmulator(emu);
    device.setProgram(fakeProgram({ clock: new FakeVideo(), script: { actions: STROKE_HIGH.actions, axes: [{ id: "roll", actions: STROKE_HIGH.actions }] }, mapping: { roll: { target: "R1", min: 20, max: 60 } } }));
    device.testChannel("roll");
    for (let i = 0; i < 40; i++) {
      clock.advance(100);
      await flush();
    }
    assert.deepEqual(lines, ["R12000I700", "R15999I900", "R12000I900", "R14000I700"]);
    assert.equal(engine.state.testing, false);
  });
});

describe("profile", () => {
  it("takes over TCode Player's profile once when there is none yet", async () => {
    const legacy = { ...defaultProfile(), model: "sr6", rateHz: 90 };
    const store = createMemoryProfileStore({ legacy });
    const { device } = make({ store });
    await device.ready();
    assert.equal(device.profile().model, "sr6");
    assert.equal(device.profile().rateHz, 90);
    assert.equal(store.saved.length, 1, "stored under tcodeProfile");
    const again = make({ store });
    await again.device.ready();
    assert.equal(store.saved.length, 1, "not migrated twice");
    assert.equal(again.device.profile().model, "sr6");
  });

  it("prefers its own profile, and saves normalized profiles", async () => {
    const store = createMemoryProfileStore({ profile: { model: "ssr1" }, legacy: { model: "sr6" } });
    const { device } = make({ store });
    await device.ready();
    assert.equal(device.profile().model, "ssr1");
    await device.saveProfile({ ...device.profile(), rateHz: 999 });
    assert.equal(device.profile().rateHz, 200);
    assert.deepEqual(store.saved.at(-1), normalizeProfile({ ...device.profile() }));
  });

  it("keeps the defaults when the profile can't be loaded", async () => {
    const store: TcodeProfileStore = {
      load: async () => {
        throw new Error("offline");
      },
      save: async () => assert.fail("must not save"),
      loadLegacy: async () => ({ model: "sr6" }),
    };
    const { device, engine } = make({ store });
    await device.ready();
    assert.equal(device.profile().model, "osr2");
    assert.equal(engine.state.profileLoaded, true);
  });
});

describe("TCode Player detection", () => {
  it("sees its global, its menu, its tab or its script", () => {
    const doc = (hit?: string) => ({ querySelector: (sel: string) => (sel === hit ? {} : null) });
    assert.equal(tcodePlayerPresent({ document: doc() }), false);
    assert.equal(tcodePlayerPresent({ TCodePlayer: {}, document: doc() }), true);
    assert.equal(tcodePlayerPresent({ document: doc(".tcp-nav") }), true);
    assert.equal(tcodePlayerPresent({ document: doc(".tcp-panel") }), true);
    assert.equal(tcodePlayerPresent({ document: doc('script[src*="plugin/TCodePlayer/"]') }), true);
  });
});

describe("status", () => {
  it("names the preset and explains a missing Web Serial", () => {
    const insecure = createTcodeDevice(undefined, { engine: { serial: undefined, secure: false, storage: null }, store: createMemoryProfileStore(), log: quiet });
    made.push(insecure);
    assert.equal(insecure.status().device, "OSR2 / OSR2+");
    assert.match(insecure.status().message!, /secure page/);
    assert.ok(scriptChannels({ actions: [] }).length === 0);
  });
});
