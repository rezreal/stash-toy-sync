import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createSceneMapStore } from "../../src/mapping/store.ts";

function setup(fail = false) {
  const writes: [string, string | null][] = [];
  const store = createSceneMapStore({
    saveField: async (id, value) => {
      if (fail) throw new Error("nope");
      writes.push([id, value]);
    },
  });
  let changes = 0;
  store.onChange(() => changes++);
  return { store, writes, changes: () => changes };
}

const tcode = JSON.stringify({ v: 2, offsetMs: 30, channels: { roll: { axis: "R2" } } });

describe("scene map store", () => {
  it("binds a scene, keeps edits across identical re-binds, tracks dirty", () => {
    const t = setup();
    t.store.bind("1", { toysync_map: JSON.stringify({ v: 1, offsetMs: 0, devices: { lovense: { mapping: { stroke: { max: 50 } } } } }) });
    const s = t.store.state()!;
    assert.equal(s.source, "toysync");
    assert.equal(s.dirty, false);
    t.store.setChannel("lovense", "stroke", { target: "intensity", max: 80 });
    assert.equal(t.store.state()!.dirty, true);
    t.store.bind("1", { toysync_map: JSON.stringify({ v: 1, offsetMs: 0, devices: { lovense: { mapping: { stroke: { max: 50 } } } } }) });
    assert.equal(t.store.state()!.edit.devices.lovense!.mapping.stroke!.max, 80, "same props: edits stay");
    t.store.setChannel("lovense", "stroke", { max: 50 });
    assert.equal(t.store.state()!.dirty, false, "back to saved");
    t.store.unbind("2");
    assert.ok(t.store.state());
    t.store.unbind("1");
    assert.equal(t.store.state(), undefined);
  });

  it("migrates tcode_map on read and saves it as toysync_map", async () => {
    const t = setup();
    t.store.bind("1", { tcode_map: tcode });
    const s = t.store.state()!;
    assert.equal(s.source, "tcode");
    assert.equal(s.edit.offsetMs, 30);
    assert.equal(s.canSave, true, "the migrated map can be saved as is");
    assert.equal(await t.store.save(), true);
    assert.deepEqual(t.writes, [["1", '{"v":1,"offsetMs":30,"devices":{"tcode":{"mapping":{"roll":{"target":"R2"}}}}}']]);
    assert.equal(t.store.state()!.source, "toysync");
  });

  it("Use defaults + Save removes toysync_map, or writes an empty map while tcode_map exists", async () => {
    const t = setup();
    t.store.bind("1", { toysync_map: JSON.stringify({ v: 1, offsetMs: 20, devices: {} }) });
    t.store.useDefaults();
    await t.store.save();
    assert.deepEqual(t.writes.at(-1), ["1", null]);
    t.store.bind("2", { tcode_map: tcode });
    t.store.useDefaults();
    await t.store.save();
    assert.deepEqual(t.writes.at(-1), ["2", '{"v":1,"offsetMs":0,"devices":{}}']);
  });

  it("remembers its own save over stale props", async () => {
    const t = setup();
    t.store.bind("1", {});
    t.store.setOffset(40);
    await t.store.save();
    t.store.unbind("1");
    t.store.bind("1", {});
    assert.equal(t.store.state()!.saved.offsetMs, 40);
  });

  it("reports a failed save", async () => {
    const t = setup(true);
    t.store.bind("1", {});
    t.store.setOptions("tcode", { generate: "strong" });
    assert.equal(await t.store.save(), false);
    assert.equal(t.store.state()!.error, "nope");
    assert.equal(t.store.state()!.dirty, true);
    t.store.revert();
    assert.equal(t.store.state()!.dirty, false);
  });
});
