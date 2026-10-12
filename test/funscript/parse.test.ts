import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalAxis, findAxis, parseFunscript } from "../../src/funscript/parse.ts";

test("v1.0: top-level actions only, sorted, no extra axes", () => {
  const f = parseFunscript({
    version: "1.0",
    actions: [
      { at: 200, pos: 10 },
      { at: 100, pos: 90 },
    ],
  });
  assert.deepEqual(f.actions, [
    { at: 100, pos: 90 },
    { at: 200, pos: 10 },
  ]);
  assert.equal(f.axes.size, 0);
  assert.equal(f.inverted, undefined);
  assert.equal(f.range, undefined);
});

test("inverted and range on the main axis are kept as flags, not applied", () => {
  const f = parseFunscript({ inverted: true, range: 90, actions: [{ at: 0, pos: 20 }] });
  assert.equal(f.inverted, true);
  assert.equal(f.range, 90);
  assert.deepEqual(f.actions, [{ at: 0, pos: 20 }]);
});

test("v1.1: axes by id, axis or name, keys lowercased", () => {
  const f = parseFunscript({
    actions: [{ at: 0, pos: 50 }],
    axes: [
      { id: "R1", actions: [{ at: 0, pos: 30 }] },
      { axis: "Snap", actions: [{ at: 10, pos: 100 }] },
      { name: "Vib", actions: [{ at: 20, pos: 40 }] },
      { actions: [{ at: 0, pos: 1 }] }, // no key
      { id: "empty", actions: [] }, // no actions
    ],
  });
  assert.deepEqual([...f.axes.keys()], ["r1", "snap", "vib"]);
  assert.deepEqual(findAxis(f, ["snap", "snaps"]), [{ at: 10, pos: 100 }]);
});

test("v2.0: channels, object or bare array; per-axis range and inverted applied", () => {
  const f = parseFunscript({
    version: "2.0",
    channels: {
      SNAPS: { actions: [{ at: 5, pos: 100 }] },
      roll: [{ at: 0, pos: 25 }],
      twist: { inverted: true, range: 50, actions: [{ at: 0, pos: 10 }] },
    },
  });
  assert.deepEqual(findAxis(f, ["snap", "snaps"]), [{ at: 5, pos: 100 }]);
  assert.deepEqual(f.axes.get("roll"), [{ at: 0, pos: 25 }]);
  assert.deepEqual(f.axes.get("twist"), [{ at: 0, pos: 80 }]);
  assert.deepEqual(f.actions, []);
});

test("the same axis in both containers collapses to one (axes win)", () => {
  const f = parseFunscript({
    axes: [{ id: "R1", actions: [{ at: 0, pos: 1 }] }],
    channels: { roll: { actions: [{ at: 0, pos: 2 }] }, snap: { actions: [{ at: 0, pos: 3 }] } },
  });
  assert.deepEqual([...f.axes.keys()], ["r1", "snap"]);
  assert.deepEqual(findAxis(f, ["roll"]), [{ at: 0, pos: 1 }]);
  assert.equal(canonicalAxis("ROLL"), "R1");
  assert.equal(canonicalAxis("snap"), undefined);
});

test("stroke carried as an axis becomes the main actions when there are none", () => {
  const f = parseFunscript({ channels: { stroke: { actions: [{ at: 0, pos: 70 }] } } });
  assert.deepEqual(f.actions, [{ at: 0, pos: 70 }]);
});

test("malformed input: bad actions skipped, positions clamped, non-objects tolerated", () => {
  const f = parseFunscript({
    actions: [
      { at: 300, pos: 150 },
      { at: "1", pos: 10 },
      null,
      { at: 100 },
      { at: -5, pos: 10 },
      { at: Number.NaN, pos: 10 },
      { at: 200, pos: -20 },
      7,
    ],
    axes: "nope",
    channels: [1, 2],
  });
  assert.deepEqual(f.actions, [
    { at: 200, pos: 0 },
    { at: 300, pos: 100 },
  ]);
  assert.equal(f.axes.size, 0);
  for (const bad of [null, undefined, 42, "x", [], { actions: "no" }]) {
    const g = parseFunscript(bad);
    assert.deepEqual(g.actions, []);
    assert.equal(g.axes.size, 0);
  }
});

test("findAxis returns undefined when nothing matches", () => {
  assert.equal(findAxis(parseFunscript({ actions: [] }), ["snap", "snaps"]), undefined);
});
