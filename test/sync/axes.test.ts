import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseFunscript } from "../../src/funscript/parse.ts";
import { describeAxes, parseAxisMap, resolveAxes } from "../../src/sync/axes.ts";

const flat = (pos: number) => ({ actions: [{ at: 0, pos }, { at: 1000, pos }] });

describe("parseAxisMap", () => {
  it("reads id=target lists, case-insensitive", () => {
    const m = parseAxisMap("Volume=Intensity, alpha=balance; e1:a\ne2 = b, pulse_frequency=speed");
    assert.deepEqual(m.entries, [
      { axis: "volume", target: "intensity" },
      { axis: "alpha", target: "balance" },
      { axis: "e1", target: "a" },
      { axis: "e2", target: "b" },
      { axis: "pulse_frequency", target: "speed" },
    ]);
    assert.deepEqual(m.problems, []);
  });

  it("reports malformed entries and unknown targets", () => {
    const m = parseAxisMap("volume, x=wobble, =a, y=b");
    assert.deepEqual(m.entries, [{ axis: "y", target: "b" }]);
    assert.equal(m.problems.length, 3);
    assert.deepEqual(parseAxisMap("").entries, []);
    assert.deepEqual(parseAxisMap(undefined).entries, []);
  });
});

describe("resolveAxes", () => {
  const f = parseFunscript({
    actions: [{ at: 0, pos: 10 }, { at: 1000, pos: 90 }],
    channels: { volume: flat(50), e1: flat(20), channel_b: flat(30), roll: flat(70), frequency: flat(5) },
  });

  it("auto-detects when the map is empty", () => {
    const r = resolveAxes(f, []);
    assert.deepEqual(Object.keys(r).sort(), ["a", "b", "intensity", "speed"]);
    assert.equal(r.b!.axis, "channel_b");
    assert.equal(describeAxes(r), "volume → intensity, frequency → speed, e1 → a, channel_b → b");
  });

  it("uses only the map when it has entries; the first entry per target wins", () => {
    const r = resolveAxes(f, [
      { axis: "R1", target: "balance" },
      { axis: "missing", target: "a" },
      { axis: "e1", target: "a" },
      { axis: "volume", target: "a" },
      { axis: "stroke", target: "speed" },
    ]);
    assert.equal(r.balance!.axis, "roll", "T-Code aliases resolve");
    assert.equal(r.a!.axis, "e1");
    assert.equal(r.speed!.axis, "stroke", "the main stroke axis can be mapped");
    assert.equal(r.intensity, undefined);
    assert.equal(r.b, undefined);
  });
});
