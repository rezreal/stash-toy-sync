import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { alreadyConnectedMessage, createClaimRegistry, instanceClaims } from "../../src/devices/claims.ts";
import {
  cleanName,
  defaultInstanceName,
  INSTANCES_KEY,
  instanceIdFor,
  instanceInfoOf,
  instanceStorageKey,
  kindOfInstance,
  loadInstances,
  nextInstanceId,
  normalizeInstances,
  ordinalOf,
  parseInstanceId,
  saveInstances,
  type DeviceInstance,
} from "../../src/devices/instances.ts";
import type { DeviceKind } from "../../src/devices/types.ts";
import { MemStorage } from "../fakes/bluetooth.ts";

const LABELS: Record<string, string> = { lovense: "Lovense", "coyote-v3": "DG-LAB Coyote 3.0", tcode: "TCode device" };
const labelOf = (k: DeviceKind) => LABELS[k] ?? k;
const KINDS: DeviceKind[] = ["lovense", "coyote-v3"];

describe("instance ids", () => {
  it("keeps the kind as the first instance's id and numbers the others", () => {
    assert.equal(instanceIdFor("coyote-v3", 1), "coyote-v3");
    assert.equal(instanceIdFor("coyote-v3", 2), "coyote-v3:2");
    assert.deepEqual(parseInstanceId("coyote-v3"), { kind: "coyote-v3", ordinal: 1 });
    assert.deepEqual(parseInstanceId("coyote-v3:3"), { kind: "coyote-v3", ordinal: 3 });
    for (const bad of ["", "coyote-v3:1", "coyote-v3:0", "coyote-v3:x", ":2", "Coyote", "a b"]) {
      assert.equal(parseInstanceId(bad), undefined, bad);
    }
    assert.equal(kindOfInstance("tcode:2"), "tcode");
    assert.equal(ordinalOf("tcode:2"), 2);
    assert.equal(ordinalOf("tcode"), 1);
  });

  it("names instances after the driver by default", () => {
    assert.equal(defaultInstanceName("Lovense", 1), "Lovense");
    assert.equal(defaultInstanceName("Lovense", 2), "Lovense 2");
    assert.equal(cleanName("  Left \n  one "), "Left one");
    assert.equal(cleanName("   "), undefined);
    assert.equal(cleanName(7), undefined);
    assert.equal(cleanName("x".repeat(100))!.length, 60);
  });

  it("gives a new instance the lowest free ordinal", () => {
    const list: DeviceInstance[] = [
      { instanceId: "coyote-v3", kind: "coyote-v3", name: "A" },
      { instanceId: "coyote-v3:3", kind: "coyote-v3", name: "C" },
    ];
    assert.equal(nextInstanceId(list, "coyote-v3"), "coyote-v3:2");
    assert.equal(nextInstanceId([...list, { instanceId: "coyote-v3:2", kind: "coyote-v3", name: "B" }], "coyote-v3"), "coyote-v3:4");
    assert.equal(nextInstanceId([], "lovense"), "lovense");
  });

  it("keys per-instance storage: the first instance keeps the old key", () => {
    assert.equal(instanceStorageKey("lovense.device", { id: "lovense", ordinal: 1 }), "lovense.device");
    assert.equal(instanceStorageKey("lovense.device", { id: "lovense:2", ordinal: 2 }), "lovense.device.lovense:2");
    assert.equal(instanceStorageKey("lovense.device", undefined), "lovense.device");
    assert.deepEqual(instanceInfoOf(undefined, "tcode", "TCode device"), { id: "tcode", name: "TCode device", ordinal: 1 });
  });
});

describe("instance list", () => {
  it("defaults to one instance per registered kind", () => {
    assert.deepEqual(loadInstances(KINDS, labelOf, new MemStorage()), [
      { instanceId: "lovense", kind: "lovense", name: "Lovense" },
      { instanceId: "coyote-v3", kind: "coyote-v3", name: "DG-LAB Coyote 3.0" },
    ]);
    assert.equal(loadInstances(KINDS, labelOf, undefined).length, 2, "no storage at all");
  });

  it("round-trips through storage, sorted by kind and ordinal, first instances always present", () => {
    const storage = new MemStorage();
    const list: DeviceInstance[] = [
      { instanceId: "coyote-v3:2", kind: "coyote-v3", name: "Right" },
      { instanceId: "coyote-v3", kind: "coyote-v3", name: "Left" },
    ];
    assert.equal(saveInstances(list, storage), true);
    assert.deepEqual(JSON.parse(storage.getItem(INSTANCES_KEY)!), [
      { instanceId: "coyote-v3:2", kind: "coyote-v3", name: "Right" },
      { instanceId: "coyote-v3", kind: "coyote-v3", name: "Left" },
    ]);
    assert.deepEqual(loadInstances(KINDS, labelOf, storage), [
      { instanceId: "lovense", kind: "lovense", name: "Lovense" },
      { instanceId: "coyote-v3", kind: "coyote-v3", name: "Left" },
      { instanceId: "coyote-v3:2", kind: "coyote-v3", name: "Right" },
    ]);
  });

  it("reads garbage leniently and keeps kinds this build doesn't register", () => {
    const raw = [
      null,
      "x",
      { instanceId: "lovense:2" },
      { instanceId: "lovense:2", name: "dup" },
      { instanceId: "lovense:1", name: "bad id" },
      { instanceId: "coyote-v3:2", kind: "lovense", name: "kind mismatch" },
      { instanceId: "tcode:2", kind: "tcode", name: "Other build" },
    ];
    assert.deepEqual(normalizeInstances(raw, KINDS, labelOf), [
      { instanceId: "lovense", kind: "lovense", name: "Lovense" },
      { instanceId: "lovense:2", kind: "lovense", name: "Lovense 2" },
      { instanceId: "coyote-v3", kind: "coyote-v3", name: "DG-LAB Coyote 3.0" },
      { instanceId: "tcode:2", kind: "tcode", name: "Other build" },
    ]);
    const broken = new MemStorage();
    broken.setItem(INSTANCES_KEY, "{not json");
    assert.equal(loadInstances(KINDS, labelOf, broken).length, 2);
  });

  it("survives a storage that throws", () => {
    const throwing = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => undefined,
    };
    assert.equal(loadInstances(KINDS, labelOf, throwing).length, 2);
    assert.equal(saveInstances([], throwing), false);
  });
});

describe("claim registry", () => {
  const names: Record<string, string> = { "coyote-v3": "Coyote 1", "coyote-v3:2": "Coyote 2" };
  const registry = () => createClaimRegistry((id) => names[id]);

  it("never lets two instances hold one device", () => {
    const r = registry();
    assert.equal(r.claim("BT-1", "coyote-v3"), true);
    assert.equal(r.claim("BT-1", "coyote-v3"), true, "claiming again is fine");
    assert.equal(r.claim("BT-1", "coyote-v3:2"), false);
    assert.equal(r.holder("BT-1"), "coyote-v3");
    assert.equal(r.isClaimed("BT-1"), true);
    assert.equal(r.isClaimed("BT-1", "coyote-v3"), true);
    assert.equal(r.isClaimed("BT-1", "coyote-v3:2"), false);
    assert.equal(r.holderName("BT-1"), "Coyote 1");
    assert.equal(r.claim("BT-2", "coyote-v3:2"), true);
  });

  it("releases only for the holder; releaseAll frees an instance's keys", () => {
    const r = registry();
    r.claim("BT-1", "coyote-v3");
    r.claim("BT-2", "coyote-v3");
    r.release("BT-1", "coyote-v3:2");
    assert.equal(r.isClaimed("BT-1"), true, "not the holder");
    r.release("BT-1", "coyote-v3");
    assert.equal(r.isClaimed("BT-1"), false);
    assert.equal(r.claim("BT-1", "coyote-v3:2"), true);
    r.releaseAll("coyote-v3");
    assert.equal(r.isClaimed("BT-2"), false);
    assert.equal(r.isClaimed("BT-1"), true);
    assert.equal(r.holderName("BT-2"), undefined);
  });

  it("gives drivers an instance-bound view with the refusal message", () => {
    const r = registry();
    const one = instanceClaims(r, "coyote-v3");
    const two = instanceClaims(r, "coyote-v3:2");
    assert.equal(one.claim("BT-1"), true);
    assert.equal(one.heldByOther("BT-1"), undefined, "ours");
    assert.equal(two.heldByOther("BT-1"), "Coyote 1");
    assert.equal(two.claim("BT-1"), false);
    assert.equal(alreadyConnectedMessage("Coyote 1").startsWith('Already connected as "Coyote 1"'), true);
    one.release("BT-1");
    assert.equal(two.heldByOther("BT-1"), undefined);
    const free = instanceClaims(undefined, "x");
    assert.equal(free.claim("BT-1"), true);
    assert.equal(free.heldByOther("BT-1"), undefined);
  });
});
