import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  clampLevel,
  decodeText,
  encodeCommand,
  expectedChannels,
  FFF0_SERVICE,
  isLovenseName,
  LOVENSE_SERVICES,
  lovenseServices,
  modelName,
  NORDIC_UART_SERVICE,
  parseReply,
  pickChannels,
  requestOptions,
  splitReplies,
  vibrateCommand,
} from "../../src/lovense/protocol.ts";
import { props } from "../fakes/bluetooth.ts";

const ch = (uuid: string, p: Parameters<typeof props>[0]) => ({ uuid, properties: props(p) });

describe("service list", () => {
  it("covers XX300001-002Y for XX 40..5f and Y 3,4, plus fff0 and Nordic UART", () => {
    const list = lovenseServices();
    assert.equal(list.length, 32 * 2 + 2);
    assert.equal(new Set(list).size, list.length);
    assert.equal(list[0], "40300001-0023-4bd4-bbd5-a6920e4c5653");
    assert.equal(list[1], "40300001-0024-4bd4-bbd5-a6920e4c5653");
    assert.ok(list.includes("5a300001-0024-4bd4-bbd5-a6920e4c5653"));
    assert.ok(list.includes("5f300001-0023-4bd4-bbd5-a6920e4c5653"));
    assert.ok(!list.includes("60300001-0023-4bd4-bbd5-a6920e4c5653"));
    assert.ok(!list.includes("3f300001-0023-4bd4-bbd5-a6920e4c5653"));
    assert.ok(list.includes(FFF0_SERVICE));
    assert.ok(list.includes(NORDIC_UART_SERVICE));
    for (const u of list) assert.match(u, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.deepEqual([...LOVENSE_SERVICES], list);
  });

  it("asks for LVS- and LOVE- names plus a custom prefix, with every service", () => {
    const o = requestOptions();
    assert.deepEqual(o.filters, [{ namePrefix: "LVS-" }, { namePrefix: "LOVE-" }]);
    assert.equal(o.optionalServices?.length, LOVENSE_SERVICES.length);
    assert.deepEqual(requestOptions(" MyToy ").filters, [{ namePrefix: "LVS-" }, { namePrefix: "LOVE-" }, { namePrefix: "MyToy" }]);
    assert.deepEqual(requestOptions("LVS-").filters?.length, 2);
    assert.equal(requestOptions("").filters?.length, 2);
  });

  it("recognises Lovense names", () => {
    assert.ok(isLovenseName("LVS-Lush42"));
    assert.ok(isLovenseName("LOVE-123"));
    assert.ok(!isLovenseName("HR strap"));
    assert.ok(isLovenseName("Custom 1", "Custom"));
    assert.ok(!isLovenseName(null));
  });
});

describe("TX / RX selection", () => {
  it("predicts TX/RX from the service uuid", () => {
    assert.deepEqual(expectedChannels("5A300001-0024-4bd4-bbd5-a6920e4c5653"), {
      tx: "5a300002-0024-4bd4-bbd5-a6920e4c5653",
      rx: "5a300003-0024-4bd4-bbd5-a6920e4c5653",
    });
    assert.deepEqual(expectedChannels(FFF0_SERVICE), {
      tx: "0000fff2-0000-1000-8000-00805f9b34fb",
      rx: "0000fff1-0000-1000-8000-00805f9b34fb",
    });
    assert.deepEqual(expectedChannels(NORDIC_UART_SERVICE), {
      tx: "6e400002-b5a3-f393-e0a9-e50e24dcca9e",
      rx: "6e400003-b5a3-f393-e0a9-e50e24dcca9e",
    });
    assert.equal(expectedChannels("0000180f-0000-1000-8000-00805f9b34fb"), undefined);
  });

  it("prefers the named characteristics", () => {
    const svc = "45300001-0023-4bd4-bbd5-a6920e4c5653";
    // a decoy writable characteristic listed first
    const decoy = ch("45300009-0023-4bd4-bbd5-a6920e4c5653", { write: true, notify: true });
    const tx = ch("45300002-0023-4bd4-bbd5-a6920e4c5653", { writeWithoutResponse: true });
    const rx = ch("45300003-0023-4bd4-bbd5-a6920e4c5653", { notify: true });
    const got = pickChannels(svc, [decoy, rx, tx]);
    assert.equal(got?.tx, tx);
    assert.equal(got?.rx, rx);
  });

  it("uses fff2/fff1 on the old service", () => {
    const fff1 = ch("0000fff1-0000-1000-8000-00805f9b34fb", { notify: true, write: true });
    const fff2 = ch("0000fff2-0000-1000-8000-00805f9b34fb", { write: true });
    const got = pickChannels(FFF0_SERVICE, [fff1, fff2]);
    assert.equal(got?.tx, fff2);
    assert.equal(got?.rx, fff1);
  });

  it("falls back to properties when the names don't match", () => {
    const a = ch("aaaa0001-0000-1000-8000-00805f9b34fb", { read: true });
    const b = ch("aaaa0002-0000-1000-8000-00805f9b34fb", { write: true });
    const c = ch("aaaa0003-0000-1000-8000-00805f9b34fb", { indicate: true });
    const got = pickChannels("aaaa0000-0000-1000-8000-00805f9b34fb", [a, b, c]);
    assert.equal(got?.tx, b);
    assert.equal(got?.rx, c);
    // a named TX without write properties is skipped too
    const svc = "50300001-0024-4bd4-bbd5-a6920e4c5653";
    const badTx = ch("50300002-0024-4bd4-bbd5-a6920e4c5653", { read: true });
    const other = ch("50300005-0024-4bd4-bbd5-a6920e4c5653", { write: true });
    assert.equal(pickChannels(svc, [badTx, other])?.tx, other);
  });

  it("works without RX and gives up without anything writable", () => {
    const tx = ch("x", { write: true });
    assert.deepEqual(pickChannels("y", [tx]), { tx });
    assert.equal(pickChannels("y", [ch("z", { notify: true })]), undefined);
    assert.equal(pickChannels("y", []), undefined);
  });
});

describe("commands", () => {
  it("encodes Vibrate with a clamped integer level", () => {
    assert.equal(vibrateCommand(0), "Vibrate:0;");
    assert.equal(vibrateCommand(20), "Vibrate:20;");
    assert.equal(vibrateCommand(7.4), "Vibrate:7;");
    assert.equal(vibrateCommand(7.5), "Vibrate:8;");
    assert.equal(vibrateCommand(-3), "Vibrate:0;");
    assert.equal(vibrateCommand(99), "Vibrate:20;");
    assert.equal(vibrateCommand(Number.NaN), "Vibrate:0;");
    assert.equal(clampLevel(Infinity), 0);
  });

  it("encodes ASCII bytes and adds the terminator", () => {
    assert.deepEqual([...encodeCommand("Battery;")], [...Buffer.from("Battery;")]);
    assert.deepEqual([...encodeCommand("DeviceType")], [...Buffer.from("DeviceType;")]);
  });

  it("decodes notification text up to a NUL", () => {
    const u = new Uint8Array([...Buffer.from("85;"), 0, 65]);
    assert.equal(decodeText(new DataView(u.buffer)), "85;");
  });

  it("splits buffered replies", () => {
    assert.deepEqual(splitReplies("OK;85;"), { replies: ["OK", "85"], rest: "" });
    assert.deepEqual(splitReplies("Z:11:00"), { replies: [], rest: "Z:11:00" });
    assert.deepEqual(splitReplies("Z:11:0082059AD3BD;O"), { replies: ["Z:11:0082059AD3BD"], rest: "O" });
    assert.equal(splitReplies("x".repeat(300)).rest, "");
  });
});

describe("replies", () => {
  it("parses OK, errors, battery and device type", () => {
    assert.deepEqual(parseReply("OK"), { kind: "ok" });
    assert.deepEqual(parseReply("OK;"), { kind: "ok" });
    assert.deepEqual(parseReply("ERR"), { kind: "error", text: "ERR" });
    assert.deepEqual(parseReply("85"), { kind: "battery", percent: 85 });
    assert.deepEqual(parseReply("s64;"), { kind: "battery", percent: 64 });
    assert.deepEqual(parseReply("100"), { kind: "battery", percent: 100 });
    assert.equal(parseReply("150").kind, "unknown");
    assert.deepEqual(parseReply("Z:11:0082059AD3BD;"), {
      kind: "deviceType",
      model: "Z",
      firmware: "11",
      address: "0082059AD3BD",
    });
    assert.deepEqual(parseReply("ed:05:aabbccddeeff"), {
      kind: "deviceType",
      model: "ED",
      firmware: "05",
      address: "AABBCCDDEEFF",
    });
    assert.deepEqual(parseReply("C:11"), { kind: "deviceType", model: "C", firmware: "11" });
    assert.deepEqual(parseReply("hello"), { kind: "unknown", text: "hello" });
  });

  it("names well-known models and keeps unknown letters", () => {
    assert.equal(modelName("S"), "Lush");
    assert.equal(modelName("z"), "Hush");
    assert.equal(modelName("ED"), "Gush");
    assert.equal(modelName("Q"), "Q");
  });
});
