import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  compactSceneMap,
  emptySceneMap,
  fileKeyOf,
  isEmptySceneMap,
  migrateTcodeMap,
  parseSceneMap,
  readSceneMap,
  serializeSceneMap,
  tcodeDefaultAxis,
} from "../../src/mapping/sceneMap.ts";

describe("toysync_map", () => {
  it("parses the flat format leniently", () => {
    const m = parseSceneMap(
      JSON.stringify({
        v: 1,
        offsetMs: "40",
        devices: {
          "coyote-v3": { mapping: { Stroke: { target: "auto" }, e1: { target: "a", min: -5, max: 180, invert: "true", junk: 1 }, bad: 3 } },
          tcode: { mapping: {}, options: { generate: "gentle" } },
          lovense: { mapping: { x: {} } },
        },
      }),
    )!;
    assert.equal(m.offsetMs, 40);
    assert.deepEqual(m.devices["coyote-v3"]!.mapping, {
      stroke: { target: "auto" },
      e1: { target: "a", invert: true, min: 0, max: 100 },
    });
    assert.deepEqual(m.devices.tcode, { mapping: {}, options: { generate: "gentle" } });
    assert.equal(m.devices.lovense, undefined, "a device with nothing usable is dropped");
  });

  it("rejects what isn't an object", () => {
    assert.equal(parseSceneMap(undefined), undefined);
    assert.equal(parseSceneMap(""), undefined);
    assert.equal(parseSceneMap("{nope"), undefined);
    assert.equal(parseSceneMap("[1]"), undefined);
    assert.deepEqual(parseSceneMap("{}"), emptySceneMap());
  });

  it("serializes compactly and round-trips", () => {
    const m = emptySceneMap();
    m.offsetMs = -20;
    m.devices.lovense = { mapping: { stroke: { target: "intensity", max: 60 } } };
    m.devices.tcode = { mapping: {} };
    const s = serializeSceneMap(m);
    assert.equal(s, '{"v":1,"offsetMs":-20,"devices":{"lovense":{"mapping":{"stroke":{"target":"intensity","max":60}}}}}');
    assert.deepEqual(parseSceneMap(s), compactSceneMap(m));
    assert.equal(isEmptySceneMap(compactSceneMap({ v: 1, offsetMs: 0, devices: { tcode: { mapping: {} } } })), true);
  });
});

describe("tcode_map migration", () => {
  it("maps v2 channels, offset and generate onto devices.tcode", () => {
    const m = migrateTcodeMap(
      JSON.stringify({
        v: 2,
        offsetMs: 40,
        generate: "gentle",
        channels: { pitch: { invert: true, min: 20, max: 80 }, surge: { axis: "off" }, R1: { axis: "R2" } },
      }),
    )!;
    assert.equal(m.offsetMs, 40);
    assert.deepEqual(m.devices.tcode, {
      mapping: { pitch: { invert: true, min: 20, max: 80 }, surge: { target: "off" }, r1: { target: "R2" } },
      options: { generate: "gentle" },
    });
  });

  it("reads the legacy per-file form: the scene file's entry, else the first", () => {
    const raw = { v: 1, files: { aaa: { offsetMs: 10, channels: {} }, bbb: { offsetMs: 20, channels: { roll: { axis: "R0" } } } } };
    assert.equal(migrateTcodeMap(raw, "bbb")!.offsetMs, 20);
    assert.deepEqual(migrateTcodeMap(raw, "bbb")!.devices.tcode!.mapping, { roll: { target: "R0" } });
    assert.equal(migrateTcodeMap(raw, "zzz")!.offsetMs, 10);
    assert.equal(migrateTcodeMap(raw)!.offsetMs, 10);
  });

  it("ignores unknown generate levels and empty configs", () => {
    const m = migrateTcodeMap({ v: 2, generate: "wild", channels: {} })!;
    assert.deepEqual(m, emptySceneMap());
    assert.equal(migrateTcodeMap("nope"), undefined);
  });

  it("knows TCode Player's default axes", () => {
    assert.equal(tcodeDefaultAxis("roll"), "R1");
    assert.equal(tcodeDefaultAxis("r2"), "R2");
    assert.equal(tcodeDefaultAxis("stroke"), "L0");
    assert.equal(tcodeDefaultAxis("volume"), undefined);
  });
});

describe("readSceneMap", () => {
  it("prefers toysync_map, migrates tcode_map, else empty", () => {
    const own = { v: 1, offsetMs: 5, devices: {} };
    const tcode = { v: 2, offsetMs: 9, channels: {} };
    assert.deepEqual(readSceneMap({ toysync_map: JSON.stringify(own), tcode_map: JSON.stringify(tcode) }), { map: own, source: "toysync" });
    const r = readSceneMap({ tcode_map: JSON.stringify(tcode) });
    assert.equal(r.source, "tcode");
    assert.equal(r.map.offsetMs, 9);
    assert.deepEqual(readSceneMap(undefined), { map: emptySceneMap(), source: "none" });
    assert.equal(readSceneMap({ toysync_map: "garbage", tcode_map: JSON.stringify(tcode) }).source, "tcode");
  });
});

describe("fileKeyOf", () => {
  it("is oshash, else md5, else the file id, else default", () => {
    assert.equal(fileKeyOf({ id: "7", fingerprints: [{ type: "md5", value: "m" }, { type: "oshash", value: "o" }] }), "o");
    assert.equal(fileKeyOf({ id: "7", fingerprints: [{ type: "md5", value: "m" }] }), "m");
    assert.equal(fileKeyOf({ id: "7", fingerprints: [] }), "file-7");
    assert.equal(fileKeyOf(undefined), "default");
  });
});
