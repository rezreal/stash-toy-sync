import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  draftChannel,
  draftKey,
  initialDraft,
  loadDraft,
  mergeCalibration,
  nudgeConfirmed,
  percentOfRange,
  reviewProblems,
  saveDraft,
  startLevel,
  stepProblem,
  valueFor,
  withLevel,
  type Draft,
} from "../../src/pages/wizard.ts";
import { MemStorage } from "../fakes/bluetooth.ts";

const R = { min: 0, max: 200 };

describe("calibration wizard", () => {
  it("starts low: each step just above the previous one", () => {
    const d: Draft = {};
    assert.equal(valueFor(d, 1, R), 0);
    assert.equal(valueFor(d, 2, R), 1);
    const d2 = withLevel(withLevel(d, 1, 20, R), 2, 50, R);
    assert.equal(startLevel(d2, 3, R), 51);
    assert.equal(valueFor(d2, 4, R), 51, "hard max starts at the nudge level");
  });

  it("clamps levels to the device range", () => {
    assert.equal(valueFor(withLevel({}, 1, 999, R), 1, R), 200);
    assert.equal(valueFor({ firstFelt: -5 }, 1, R), 0);
  });

  it("blocks a step whose level breaks the ordering", () => {
    const d: Draft = { firstFelt: 20, comfortMax: 20 };
    assert.match(stepProblem(d, 2, R)!, /above First felt/);
    assert.equal(stepProblem({ ...d, comfortMax: 21 }, 2, R), undefined);
    assert.match(stepProblem({ firstFelt: 20, comfortMax: 40, nudge: 40 }, 3, R)!, /above Comfort max/);
    assert.match(stepProblem({ firstFelt: 20, comfortMax: 40, nudge: 60, hardMax: 59, nudgeConfirmed: 60 }, 4, R)!, /at least the nudge/);
  });

  it("needs the nudge confirmed at its current level", () => {
    const d: Draft = { firstFelt: 20, comfortMax: 40, nudge: 60 };
    assert.match(stepProblem(d, 3, R)!, /sharp but OK/);
    const ok = { ...d, nudgeConfirmed: 60 };
    assert.equal(nudgeConfirmed(ok, R), true);
    assert.equal(stepProblem(ok, 3, R), undefined);
    const moved = withLevel(ok, 3, 70, R);
    assert.equal(nudgeConfirmed(moved, R), false, "a changed nudge needs confirming again");
  });

  it("reviews the whole channel", () => {
    const good: Draft = { firstFelt: 20, comfortMax: 40, nudge: 60, hardMax: 60, nudgeConfirmed: 60 };
    assert.deepEqual(reviewProblems(good, R), []);
    assert.deepEqual(draftChannel(good, R), { firstFelt: 20, comfortMax: 40, nudge: 60, hardMax: 60 });
    assert.match(reviewProblems({ ...good, nudgeConfirmed: undefined }, R)[0]!, /confirmed/);
    assert.equal(reviewProblems({ ...good, comfortMax: 10 }, R).length, 1);
  });

  it("starts from the stored calibration", () => {
    const d = initialDraft({ firstFelt: 5, comfortMax: 30, nudge: 45, hardMax: 50 });
    assert.equal(nudgeConfirmed(d, R), true);
    assert.deepEqual(initialDraft(undefined), {});
  });

  it("merges one channel into the stored calibration", () => {
    const a = { firstFelt: 5, comfortMax: 30, nudge: 45, hardMax: 50 };
    const b = { firstFelt: 8, comfortMax: 35, nudge: 40, hardMax: 40 };
    assert.deepEqual(mergeCalibration(undefined, "a", a, "t"), { a, updatedAt: "t" });
    assert.deepEqual(mergeCalibration({ a, b, updatedAt: "old" }, "a", a, "t"), { a, b, updatedAt: "t" });
    assert.deepEqual(mergeCalibration({ a, updatedAt: "old" }, "b", b, "t"), { a, b, updatedAt: "t" });
    assert.equal(mergeCalibration(undefined, "b", b, "t"), undefined, "channel A comes first");
  });

  it("shows levels as % of the range", () => {
    assert.equal(percentOfRange(50, R), 25);
    assert.equal(percentOfRange(5, { min: 0, max: 0 }), 0);
  });

  it("keeps the draft in session storage, tolerating failures", () => {
    const s = new MemStorage();
    const key = draftKey("coyote-v3", "dev1", "b");
    assert.equal(key, "toysync.calibrationDraft.coyote-v3.dev1.b");
    saveDraft(key, { firstFelt: 3, nudgeConfirmed: 9 }, s);
    assert.deepEqual(loadDraft(key, s), { firstFelt: 3, nudgeConfirmed: 9 });
    s.setItem(key, "{broken");
    assert.equal(loadDraft(key, s), undefined);
    saveDraft(key, undefined, s);
    assert.equal(loadDraft(key, s), undefined);
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => undefined,
    };
    assert.equal(loadDraft(key, broken), undefined);
    saveDraft(key, {}, broken);
  });
});
