import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { DeviceEntry } from "../../src/devices/manager.ts";
import { calibrationSummary, connectionText, instanceGroups, mappingRows, settingsRows } from "../../src/pages/devicesView.ts";
import { DEFAULT_SETTINGS } from "../../src/sync/settings.ts";

describe("devices page view", () => {
  it("summarises calibrations", () => {
    assert.equal(calibrationSummary(undefined), "Not calibrated");
    assert.equal(
      calibrationSummary({ a: { firstFelt: 1, comfortMax: 2, nudge: 3, hardMax: 4 }, b: { firstFelt: 5, comfortMax: 6, nudge: 7, hardMax: 7 }, updatedAt: "" }),
      "A: 1–2, nudge 3, hard max 4 · B: 5–6, nudge 7, hard max 7",
    );
  });

  it("groups device instances by kind, in registration order", () => {
    const e = (instanceId: string, kind: DeviceEntry["kind"]): DeviceEntry => ({ instanceId, name: instanceId, kind, id: instanceId, status: { connection: "disconnected" } });
    const groups = instanceGroups(["lovense", "coyote-v3", "tcode"], [e("coyote-v3", "coyote-v3"), e("lovense", "lovense"), e("coyote-v3:2", "coyote-v3")]);
    assert.deepEqual(
      groups.map((g) => [g.kind, g.entries.map((x) => x.instanceId)]),
      [
        ["lovense", ["lovense"]],
        ["coyote-v3", ["coyote-v3", "coyote-v3:2"]],
        ["tcode", []],
      ],
    );
  });

  it("describes connections", () => {
    assert.equal(connectionText({ connection: "connected" }), "Connected");
    assert.equal(connectionText({ connection: "disconnected" }), "Not connected");
  });

  it("explains where each part of the frame comes from", () => {
    const rows = mappingRows(
      { stroke: true, targets: { intensity: "stroke", balance: "alpha", speed: "stroke", a: "e1", b: undefined }, problems: [] },
      "speed",
    );
    assert.deepEqual(
      rows.map((r) => r.source),
      ["stroke speed (speed mode)", "axis “alpha”", "stroke speed", "axis “e1”", "— (intensity × balance)"],
    );
    const noStroke = mappingRows({ stroke: false, targets: { intensity: undefined, balance: undefined, speed: undefined, a: "e1", b: "e2" }, problems: [] }, "position");
    assert.equal(noStroke[0]!.source, "strongest of channel A / B");
  });

  it("lists the settings", () => {
    const rows = new Map(settingsRows({ ...DEFAULT_SETTINGS, nudgesPerMinute: 0 }));
    assert.equal(rows.get("Nudges"), "off");
    assert.equal(rows.get("Axis mapping"), "auto-detect");
    assert.equal(rows.get("E-stim frequency range"), "10–100 Hz");
  });
});
