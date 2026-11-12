import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  calibrateHref,
  calibrateSearch,
  calibrateStartHref,
  isCanonical,
  nextStep,
  pageFor,
  parseCalibrateQuery,
  prevStep,
  resolveCalibrateLink,
  type CalibrateChoice,
} from "../../src/pages/links.ts";

const v3: CalibrateChoice = { instanceId: "coyote-v3", channels: ["a", "b"], connected: true };
const v2: CalibrateChoice = { instanceId: "coyote-v2", channels: ["a", "b"], connected: false };
const mono: CalibrateChoice = { instanceId: "coyote-v2", channels: ["a"], connected: true };

describe("calibrate page URL", () => {
  it("parses the query", () => {
    assert.deepEqual(parseCalibrateQuery("?device=coyote-v3&channel=b&step=3"), { device: "coyote-v3", channel: "b", step: "3" });
    assert.deepEqual(parseCalibrateQuery("device=%20coyote-v2%20&step="), { device: "coyote-v2" });
    assert.deepEqual(parseCalibrateQuery(""), {});
  });

  it("resolves a valid link as is", () => {
    const l = resolveCalibrateLink(parseCalibrateQuery("?device=coyote-v3&channel=b&step=review"), [v2, v3]);
    assert.deepEqual(l, { device: "coyote-v3", channel: "b", step: "review" });
    assert.equal(isCanonical("?device=coyote-v3&channel=b&step=review", l!), true);
  });

  it("keeps a named device that isn't connected (the page offers to connect it)", () => {
    assert.deepEqual(resolveCalibrateLink({ device: "coyote-v2", step: "2" }, [v2, v3]), { device: "coyote-v2", channel: "a", step: 2 });
  });

  it("normalises invalid or missing parameters", () => {
    // no device: the first connected one; a bad channel or step: the defaults
    const l = resolveCalibrateLink({ channel: "x", step: "9" }, [v2, v3])!;
    assert.deepEqual(l, { device: "coyote-v3", channel: "a", step: 1 });
    assert.equal(isCanonical("?channel=x&step=9", l), false);
    assert.equal(calibrateSearch(l), "?device=coyote-v3&channel=a&step=1");
    // an unknown device kind counts as none
    assert.equal(resolveCalibrateLink({ device: "lovense" }, [v3])!.device, "coyote-v3");
    // a channel the device doesn't have
    assert.equal(resolveCalibrateLink({ device: "coyote-v2", channel: "b" }, [mono])!.channel, "a");
  });

  it("has nothing to show without a named or connected device", () => {
    assert.equal(resolveCalibrateLink({}, [v2]), undefined);
    assert.equal(resolveCalibrateLink({ device: "coyote-v3" }, []), undefined);
  });

  it("builds hrefs in a fixed order", () => {
    assert.equal(calibrateHref({ device: "coyote-v3", channel: "b", step: 4 }), "/toysync/calibrate?device=coyote-v3&channel=b&step=4");
    assert.equal(calibrateStartHref("coyote-v2"), "/toysync/calibrate?device=coyote-v2&channel=a&step=1");
    assert.equal(isCanonical("device=coyote-v2&channel=a&step=1", { device: "coyote-v2", channel: "a", step: 1 }), true);
  });

  it("selects devices by instance id; old device=<kind> links open the first instance", () => {
    const second: CalibrateChoice = { instanceId: "coyote-v3:2", channels: ["a", "b"], connected: false };
    const choices = [v3, second];
    assert.deepEqual(parseCalibrateQuery("?device=coyote-v3%3A2&channel=b&step=2"), { device: "coyote-v3:2", channel: "b", step: "2" });
    const l = resolveCalibrateLink(parseCalibrateQuery("?device=coyote-v3:2&channel=b&step=2"), choices)!;
    assert.deepEqual(l, { device: "coyote-v3:2", channel: "b", step: 2 });
    assert.equal(calibrateHref(l), "/toysync/calibrate?device=coyote-v3:2&channel=b&step=2", "the colon stays readable");
    assert.equal(isCanonical("?device=coyote-v3:2&channel=b&step=2", l), true);
    assert.equal(isCanonical("?device=coyote-v3%3A2&channel=b&step=2", l), false, "normalised to the readable form");
    assert.equal(calibrateStartHref("coyote-v3:2", "b"), "/toysync/calibrate?device=coyote-v3:2&channel=b&step=1");
    // a link from before instances: the kind is the first instance's id
    assert.equal(resolveCalibrateLink(parseCalibrateQuery("?device=coyote-v3&channel=a&step=3"), choices)!.device, "coyote-v3");
    // a removed instance falls back to a connected one
    assert.equal(resolveCalibrateLink({ device: "coyote-v3:5" }, choices)!.device, "coyote-v3");
    assert.equal(resolveCalibrateLink({ device: "coyote-v3:5" }, [second]), undefined);
  });

  it("walks the steps", () => {
    assert.equal(nextStep(1), 2);
    assert.equal(nextStep(4), "review");
    assert.equal(nextStep("review"), undefined);
    assert.equal(prevStep(1), undefined);
    assert.equal(prevStep("review"), 4);
  });

  it("tells the pages apart by pathname", () => {
    assert.equal(pageFor("/toysync"), "devices");
    assert.equal(pageFor("/toysync/"), "devices");
    assert.equal(pageFor("/toysync/calibrate"), "calibrate");
    assert.equal(pageFor("/toysync/other"), "");
    assert.equal(pageFor("/scenes/1"), "");
  });
});
