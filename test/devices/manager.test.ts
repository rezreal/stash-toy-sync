import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createDeviceManager } from "../../src/devices/manager.ts";
import { createDriverRegistry, type DriverBaseContext } from "../../src/devices/registry.ts";
import type { DeviceKind, DriveFrame } from "../../src/devices/types.ts";
import { DEFAULT_SETTINGS } from "../../src/sync/settings.ts";
import { FakeClock, flush } from "../fakes/clock.ts";
import { FakeDevice } from "../fakes/device.ts";

function setup(kinds: DeviceKind[] = ["lovense", "coyote-v3"]) {
  const clock = new FakeClock();
  const registry = createDriverRegistry();
  const made: FakeDevice[] = [];
  const context: DriverBaseContext = { settings: () => DEFAULT_SETTINGS, onSettings: () => () => undefined, timers: clock, now: clock.now };
  for (const k of kinds) {
    registry.register(k, () => {
      const d = new FakeDevice(k);
      made.push(d);
      return d;
    });
  }
  const manager = createDeviceManager({ context, registry, timers: clock, retryDelaysMs: [1000, 3000] });
  const dev = (k: DeviceKind) => manager.device(k) as FakeDevice;
  return { clock, registry, manager, made, dev };
}

const frame: DriveFrame = { intensity: 0.5, balance: 0.5, speed: 0.2 };

describe("device manager", () => {
  it("creates one device per registered kind", () => {
    const t = setup();
    assert.deepEqual(t.manager.kinds(), ["lovense", "coyote-v3"]);
    assert.equal(t.made.length, 2);
    assert.equal(t.manager.device("lovense"), t.manager.device("lovense"));
    assert.equal(t.manager.device("coyote-v2"), undefined);
    assert.deepEqual(
      t.manager.statuses().map((e) => [e.kind, e.id, e.status.connection]),
      [
        ["lovense", "lovense-1", "disconnected"],
        ["coyote-v3", "coyote-v3-1", "disconnected"],
      ],
    );
  });

  it("creates late-registered drivers on first use", () => {
    const t = setup(["lovense"]);
    t.registry.register("coyote-v2", () => new FakeDevice("coyote-v2"));
    assert.equal(t.manager.device("coyote-v2")?.kind, "coyote-v2");
    assert.equal(t.manager.devices().length, 2);
  });

  it("fans frames, nudges and stops out to every device", () => {
    const t = setup();
    t.manager.driveAll(frame);
    t.manager.driveAll(null);
    assert.deepEqual(t.dev("lovense").frames, [frame, null]);
    assert.deepEqual(t.dev("coyote-v3").frames, [frame, null]);
    t.dev("lovense").canNudge = false;
    assert.equal(t.manager.nudgeAll(), 1);
    assert.ok(t.dev("lovense").calls.includes("nudge"));
    t.manager.stopAll();
    assert.ok(t.dev("lovense").calls.includes("stopNow"));
    assert.ok(t.dev("coyote-v3").calls.includes("stopNow"));
  });

  it("keeps going when one driver throws", () => {
    const t = setup();
    t.dev("lovense").throwOnDrive = true;
    const err = console.error;
    console.error = () => undefined;
    try {
      t.manager.driveAll(frame);
    } finally {
      console.error = err;
    }
    assert.deepEqual(t.dev("coyote-v3").frames, [frame]);
  });

  it("connects and disconnects one kind and reports changes", async () => {
    const t = setup();
    const seen: string[] = [];
    t.manager.onChange((entries) => seen.push(entries.map((e) => e.status.connection).join(",")));
    await t.manager.connect("coyote-v3");
    assert.deepEqual(t.dev("coyote-v3").calls, ["connect"]);
    assert.equal(seen.at(-1), "disconnected,connected");
    t.manager.disconnect("coyote-v3");
    assert.equal(seen.at(-1), "disconnected,disconnected");
  });

  it("resumeAll() silently resumes every device", async () => {
    const t = setup();
    t.dev("lovense").resumeResult = "disconnected";
    await t.manager.resumeAll();
    assert.deepEqual(t.dev("lovense").calls, ["resume"]);
    assert.deepEqual(t.dev("coyote-v3").calls, ["resume"]);
    assert.equal(t.dev("coyote-v3").status().connection, "connected");
  });

  it("retries a dropped link with resume(), backing off, until it is back", async () => {
    const t = setup();
    const d = t.dev("coyote-v3");
    await t.manager.connect("coyote-v3");
    d.resumeResult = "error";
    d.setStatus({ connection: "disconnected", message: "link lost" });
    t.clock.advance(999);
    assert.deepEqual(d.calls, ["connect"]);
    t.clock.advance(1);
    await flush();
    assert.deepEqual(d.calls, ["connect", "resume"]);
    t.clock.advance(2999);
    await flush();
    assert.equal(d.calls.length, 2);
    d.resumeResult = "connected";
    t.clock.advance(1);
    await flush();
    assert.deepEqual(d.calls, ["connect", "resume", "resume"]);
    assert.equal(d.status().connection, "connected");
    t.clock.advance(60_000);
    await flush();
    assert.equal(d.calls.length, 3, "no retries once connected");
    assert.equal(t.clock.pending, 0);
  });

  it("doesn't retry after disconnect(), never-connected devices or self-reconnecting drivers", async () => {
    const t = setup();
    const d = t.dev("coyote-v3");
    await t.manager.connect("coyote-v3");
    t.manager.disconnect("coyote-v3");
    t.clock.advance(10_000);
    await flush();
    assert.deepEqual(d.calls, ["connect", "disconnect"]);

    const l = t.dev("lovense");
    l.setStatus({ connection: "error", message: "picker cancelled" });
    t.clock.advance(10_000);
    assert.deepEqual(l.calls, [], "never connected: the user has to click");

    l.selfReconnects = true;
    await t.manager.connect("lovense");
    l.setStatus({ connection: "disconnected" });
    t.clock.advance(10_000);
    await flush();
    assert.deepEqual(l.calls, ["connect"]);
  });

  it("dispose() stops retries and listeners", async () => {
    const t = setup();
    const d = t.dev("coyote-v3");
    await t.manager.connect("coyote-v3");
    d.setStatus({ connection: "disconnected" });
    t.manager.dispose();
    t.clock.advance(10_000);
    await flush();
    assert.deepEqual(d.calls, ["connect"]);
  });
});
