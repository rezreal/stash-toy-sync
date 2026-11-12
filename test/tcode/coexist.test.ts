// The driver must work alongside other interactive plugins: it may not grab
// serial ports they own, and the 3D preview bundle may not leave stray globals.
// Ported from TCode Player's test/coexist.test.js with every expectation kept.
// TCode Player auto-connected at load; Toy Sync's manager calls resume() when
// an interactive scene opens, so each test calls resume() where TCode Player
// ran its init. The storage key is TCode Player's own ("tcp-port"): Toy Sync
// takes over the port TCode Player remembered once TCode Player is gone.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createTcodeDevice } from "../../src/tcode/device.ts";
import { loadEmulator } from "../../src/tcode/emulator.ts";
import { createMemoryProfileStore } from "../../src/tcode/profileStore.ts";
import type { SerialLike, SerialPortInfo, SerialPortLike } from "../../src/tcode/serial.d.ts";

const EMU = path.join(import.meta.dirname, "../../plugin/vendor/osr-emu.dist.min.js");

class FakePort implements SerialPortLike {
  info: SerialPortInfo;
  busy: boolean;
  readable: ReadableStream<Uint8Array> | null = null;
  writable: WritableStream<Uint8Array> | null = null;
  opened = 0;
  constructor(info: SerialPortInfo, { busy = false } = {}) {
    this.info = info;
    this.busy = busy;
  }
  getInfo() {
    return this.info;
  }
  async open() {
    if (this.busy) throw Object.assign(new Error("Failed to open serial port."), { name: "NetworkError" });
    this.opened++;
    this.readable = new ReadableStream();
    this.writable = new WritableStream();
  }
  async close() {
    this.readable = null;
    this.writable = null;
  }
}

class MapStorage {
  store: Map<string, string>;
  constructor(entries: Record<string, string>) {
    this.store = new Map(Object.entries(entries));
  }
  getItem(k: string) {
    return this.store.has(k) ? this.store.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.store.set(k, String(v));
  }
}

const devices: { dispose(): void; engine: { _cleanup(r: null): Promise<void> } }[] = [];
test.afterEach(async () => {
  for (const d of devices.splice(0)) {
    await d.engine._cleanup(null);
    d.dispose();
  }
});

function load({ ports = [] as FakePort[], storage = {} as Record<string, string>, oldPlugin = false } = {}) {
  const store = new MapStorage(storage);
  const serial: SerialLike = { getPorts: async () => ports, requestPort: async () => ports[0]!, addEventListener() {} };
  const device = createTcodeDevice(undefined, {
    engine: { serial, secure: true, storage: store, oldPluginPresent: () => oldPlugin },
    store: createMemoryProfileStore(),
    log: { warn() {}, info() {} },
  });
  devices.push(device);
  void device.resume(); // what TCode Player's init did, and Toy Sync's manager does on an interactive scene
  return { store, device, engine: device.engine };
}

const settle = () => new Promise((r) => setTimeout(r, 20));
const USB = { usbVendorId: 0x10c4, usbProductId: 0xea60 };
const OTHER = { usbVendorId: 0x2341, usbProductId: 0x0043 };

test("does not auto-connect to a port it never used", async () => {
  const other = new FakePort(OTHER);
  const { engine } = load({ ports: [other] });
  await settle();
  assert.equal(other.opened, 0);
  assert.equal(engine.state.status, "disconnected");
});

test("auto-connects only to the remembered port, skipping other plugins' ports", async () => {
  const other = new FakePort(OTHER);
  const mine = new FakePort(USB);
  const { engine } = load({ ports: [other, mine], storage: { "tcp-port": JSON.stringify(USB) } });
  await settle();
  assert.equal(other.opened, 0);
  assert.equal(mine.opened, 1);
  assert.equal(engine.state.status, "connected");
  await engine._cleanup(null);
});

test("leaves a remembered port alone when another plugin has it open", async () => {
  const mine = new FakePort(USB);
  mine.readable = new ReadableStream(); // already open in this page
  const { engine } = load({ ports: [mine], storage: { "tcp-port": JSON.stringify(USB) } });
  await settle();
  assert.equal(mine.opened, 0);
  assert.equal(engine.state.status, "disconnected");
  assert.equal(engine.state.error, null);
});

test("backs off quietly when the remembered port is busy elsewhere", async () => {
  const mine = new FakePort(USB, { busy: true });
  const { engine } = load({ ports: [mine], storage: { "tcp-port": JSON.stringify(USB) } });
  await settle();
  assert.equal(engine.state.status, "disconnected");
  assert.equal(engine.state.error, null);
});

test("manual connect to a port in use reports it instead of taking it", async () => {
  const mine = new FakePort(USB);
  mine.readable = new ReadableStream();
  const { engine } = load({ ports: [mine] });
  await settle();
  await engine.connect();
  assert.equal(mine.opened, 0);
  assert.equal(engine.state.status, "error");
  assert.match(engine.state.error!, /in use/);
});

test("3D preview bundle leaves only window.OSREmulator behind", async () => {
  const scripts: { onload(): void }[] = [];
  const window: Record<string, unknown> = {};
  const document = {
    baseURI: "http://localhost:9999/",
    createElement: () => ({ remove() {} }),
    head: { appendChild: (el: { onload(): void }) => scripts.push(el) },
    querySelector: () => null,
  };
  const ctx = vm.createContext(window);
  Object.assign(window, {
    window, navigator: {}, document, console, URL, TextEncoder, TextDecoderStream,
    ReadableStream, WritableStream, setTimeout, clearTimeout, setInterval, clearInterval,
  });
  await settle();
  const loading = loadEmulator({ window, document, src: "vendor/osr-emu.dist.min.js" });
  assert.equal(scripts.length, 1);
  vm.runInContext(fs.readFileSync(EMU, "utf8"), ctx); // what the <script> tag would run
  scripts[0]!.onload();
  const Emu = await loading;
  assert.equal(typeof Emu, "function");
  assert.equal("default" in window, false);
  assert.equal("__esModule" in window, false);
});

// --- Toy Sync additions ---------------------------------------------------------------

test("remembers the port under its own key and auto-connects to it", async () => {
  const mine = new FakePort(USB);
  const first = load({ ports: [mine] });
  await settle();
  await first.engine.connect();
  assert.equal(first.store.getItem("toysync.tcode.port"), JSON.stringify(USB));
  await first.engine._cleanup(null);
  const again = load({ ports: [mine], storage: { "toysync.tcode.port": JSON.stringify(USB) } });
  await settle();
  assert.equal(again.engine.state.status, "connected");
});

test("does not auto-connect while TCode Player is active in the page, and says why", async () => {
  const mine = new FakePort(USB);
  const { engine, device } = load({ ports: [mine], storage: { "toysync.tcode.port": JSON.stringify(USB) }, oldPlugin: true });
  await settle();
  assert.equal(mine.opened, 0);
  assert.equal(engine.state.status, "disconnected");
  assert.match(device.status().message!, /TCode Player/);
  await engine.connect(); // by hand it still connects
  assert.equal(mine.opened, 1);
  assert.equal(device.status().message, undefined);
});
