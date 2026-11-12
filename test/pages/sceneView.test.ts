import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TCODE_PLAYER_NOTICE, tcodePlayerPresent } from "../../src/coexist.ts";
import { ESTIM_TARGETS } from "../../src/mapping/targets.ts";
import {
  channelLabel,
  groupTargets,
  mappingSummary,
  navDot,
  navTitle,
  readPercent,
  sourceText,
  targetLabel,
  targetsFor,
} from "../../src/scene/view.ts";
import { FakeDevice, FakeSelfTimedDevice } from "../fakes/device.ts";

describe("scene tab view", () => {
  it("groups targets in first-seen order", () => {
    const g = groupTargets([
      { id: "L0", label: "Stroke", group: "Linear" },
      { id: "R0", label: "Twist", group: "Rotation" },
      { id: "L1", label: "Surge", group: "Linear" },
      { id: "x", label: "X" },
    ]);
    assert.deepEqual(g.map((x) => [x.label, x.targets.map((t) => t.id)]), [
      ["Linear", ["L0", "L1"]],
      ["Rotation", ["R0"]],
      [undefined, ["x"]],
    ]);
  });

  it("picks a device's targets, or every frame part for DriveFrame devices that name none", () => {
    assert.equal(targetsFor(new FakeDevice("coyote-v3")), ESTIM_TARGETS);
    assert.deepEqual(targetsFor(new FakeSelfTimedDevice("tcode")), []);
    assert.deepEqual(targetsFor(undefined), []);
  });

  it("labels targets, channels and mappings", () => {
    assert.equal(targetLabel("off", ESTIM_TARGETS), "Off");
    assert.equal(targetLabel("a", ESTIM_TARGETS), "Channel A");
    assert.equal(targetLabel("L9", ESTIM_TARGETS), "L9 (unknown)");
    assert.equal(channelLabel("stroke"), "stroke (main)");
    assert.equal(mappingSummary({ target: "a", invert: true, min: 10, max: 90 }, ESTIM_TARGETS), "Channel A, inverted, 10–90");
    assert.equal(mappingSummary({ target: "off" }, ESTIM_TARGETS), "off");
    assert.match(sourceText("tcode", true), /tcode_map.*Unsaved/);
  });

  it("reads percent fields", () => {
    assert.equal(readPercent("42"), 42);
    assert.equal(readPercent("150"), 100);
    assert.equal(readPercent("-3"), 0);
    assert.equal(readPercent("12,6"), 13);
    assert.equal(readPercent(""), undefined);
    assert.equal(readPercent("x"), undefined);
  });

  it("colours the navbar dot", () => {
    assert.equal(navDot([{ connection: "disconnected" }]), "off");
    assert.equal(navDot([{ connection: "connected", output: { a: 0 } }]), "connected");
    assert.equal(navDot([{ connection: "connected", output: { a: 0, b: 0.4 } }]), "live");
    assert.equal(navTitle("live", 2), "Toy Sync: 2 devices connected, outputting");
  });
});

describe("TCode Player detection", () => {
  it("sees its global or its DOM", () => {
    assert.equal(tcodePlayerPresent({ TCodePlayer: {} }), true);
    assert.equal(tcodePlayerPresent({ document: { querySelector: (s: string) => (s.includes(".tcp-nav") ? {} : null) } }), true);
    assert.equal(tcodePlayerPresent({ document: { querySelector: () => null } }), false);
    assert.match(TCODE_PLAYER_NOTICE, /Settings › Plugins/);
  });
});
