import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createGainCombiner, GAIN_EVENT, listenGainEvents } from "../../src/sync/gain.ts";

describe("gain combiner", () => {
  it("is 1 without sources and the product of all present gains", () => {
    const g = createGainCombiner();
    assert.equal(g.gain(), 1);
    g.set("a", 0.5);
    g.set("b", 0.5);
    assert.equal(g.gain(), 0.25);
    g.set("a", 1);
    assert.equal(g.gain(), 0.5);
  });

  it("clamps to 0..1 and removes a source with null", () => {
    const g = createGainCombiner();
    g.set("a", 3);
    assert.equal(g.sources().get("a"), 1);
    g.set("b", -2);
    assert.equal(g.gain(), 0);
    g.set("b", null);
    assert.equal(g.gain(), 1);
    g.set("a", null);
    assert.equal(g.sources().size, 0);
  });

  it("ignores invalid input", () => {
    const g = createGainCombiner();
    assert.equal(g.set("", 0.5), false);
    assert.equal(g.set(7, 0.5), false);
    assert.equal(g.set("a", Number.NaN), false);
    assert.equal(g.set("a", "0.5"), false);
    assert.equal(g.set("a", undefined), false);
    assert.equal(g.gain(), 1);
  });

  it("notifies only on changes", () => {
    const g = createGainCombiner();
    const seen: number[] = [];
    g.onChange((v) => seen.push(v));
    g.set("a", 0.5);
    g.set("a", 0.5);
    g.set("b", 1);
    g.set("a", null);
    assert.deepEqual(seen, [0.5, 1]);
  });

  it("listens to lovense:gain events", () => {
    const target = new EventTarget();
    const g = createGainCombiner();
    const off = listenGainEvents(target, g);
    target.dispatchEvent(new CustomEvent(GAIN_EVENT, { detail: { source: "skilltree", gain: 0.4 } }));
    target.dispatchEvent(new CustomEvent(GAIN_EVENT, { detail: { source: "other", gain: 0.5 } }));
    assert.equal(g.gain(), 0.2);
    target.dispatchEvent(new CustomEvent(GAIN_EVENT, { detail: { source: "other", gain: null } }));
    assert.equal(g.gain(), 0.4);
    // malformed events are ignored
    target.dispatchEvent(new CustomEvent(GAIN_EVENT, { detail: null }));
    target.dispatchEvent(new CustomEvent(GAIN_EVENT, { detail: { gain: 0 } }));
    target.dispatchEvent(new CustomEvent(GAIN_EVENT));
    assert.equal(g.gain(), 0.4);
    off();
    target.dispatchEvent(new CustomEvent(GAIN_EVENT, { detail: { source: "skilltree", gain: 0 } }));
    assert.equal(g.gain(), 0.4);
  });
});
