// Serial write errors: after one failed write the port's output stream is
// broken and every later write fails at once (seen with an SR6 ESP32 board on
// Chrome: "UnknownError: An unknown system error has occurred"). The driver has
// to recover instead of silently sending into nothing. Ported from TCode
// Player's test/serial.test.js with every expectation kept.
import test from "node:test";
import assert from "node:assert/strict";
import { createTcodeDevice } from "../../src/tcode/device.ts";
import type { TcodeEngine } from "../../src/tcode/engine.ts";
import { createMemoryProfileStore } from "../../src/tcode/profileStore.ts";
import type { SerialLike, SerialPortLike } from "../../src/tcode/serial.d.ts";

class FlakyPort implements SerialPortLike {
  fail: (i: number) => boolean;
  fresh: boolean;
  n = 0;
  ok: string[] = [];
  opened = 0;
  readable: ReadableStream<Uint8Array> | null = null;
  _ws: WritableStream<Uint8Array> | null = null;
  _broken = false;
  /** fail(i) decides whether the i-th write overall fails; fresh = the browser hands out a new stream after an error */
  constructor(fail: (i: number) => boolean, { fresh = false } = {}) {
    this.fail = fail;
    this.fresh = fresh;
  }
  getInfo() {
    return { usbVendorId: 0x10c4, usbProductId: 0xea60 };
  }
  async open() {
    this.opened++;
    this.readable = new ReadableStream();
    this._ws = this._stream();
    this._broken = false;
  }
  async close() {
    this.readable = null;
    this._ws = null;
  }
  get writable() {
    if (this.fresh && this._broken && this._ws) {
      this._ws = this._stream();
      this._broken = false;
    }
    return this._ws;
  }
  _stream() {
    return new WritableStream<Uint8Array>({
      write: (chunk) => {
        const i = this.n++;
        if (this.fail(i)) {
          this._broken = true;
          throw new DOMException("An unknown system error has occurred.", "UnknownError");
        }
        this.ok.push(new TextDecoder().decode(chunk).trim());
      },
    });
  }
}

const envs: { engine: TcodeEngine; dispose(): void }[] = [];
test.afterEach(async () => {
  for (const { engine, dispose } of envs.splice(0)) {
    await engine._cleanup(null);
    dispose();
  }
});

function load(port: FlakyPort) {
  const warnings: unknown[][] = [];
  const serial: SerialLike = { getPorts: async () => [], requestPort: async () => port, addEventListener() {} };
  const device = createTcodeDevice(undefined, {
    engine: { serial, secure: true, storage: null },
    store: createMemoryProfileStore(),
    log: { warn: (...a: unknown[]) => warnings.push(a), info() {} },
  });
  const env = { engine: device.engine, warnings, dispose: () => device.dispose() };
  envs.push(env);
  return env;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function stream(engine: TcodeEngine, frames: number) {
  for (let i = 0; i < frames; i++) {
    engine.sendRaw("L0" + String(i % 10000).padStart(4, "0") + "I17");
    await wait(10);
  }
}

test("reopens the port after a failed write and the device gets data again", async () => {
  const port = new FlakyPort((i) => i === 3);
  const { engine, warnings } = load(port);
  await engine.connect();
  await stream(engine, 30);
  assert.equal(port.opened, 2, "reopened once");
  assert.equal(engine.state.status, "connected");
  assert.ok(port.ok.length >= 20, `writes reach the device again (${port.ok.length})`);
  assert.equal(warnings.length, 1, "one warning, not one per frame");
  assert.ok(engine.state.deviceLog.some((l) => l.includes("write error")), "noted in the device log");
});

test("takes a fresh stream without reopening when the browser offers one", async () => {
  const port = new FlakyPort((i) => i === 3, { fresh: true });
  const { engine } = load(port);
  await engine.connect();
  await stream(engine, 20);
  assert.equal(port.opened, 1, "no reopen, so the board is not restarted");
  assert.ok(port.ok.length >= 15);
});

test("gives up with a clear error when writes keep failing", async () => {
  const port = new FlakyPort((i) => i >= 3);
  const { engine } = load(port);
  await engine.connect();
  await stream(engine, 80);
  assert.equal(engine.state.status, "error");
  assert.match(engine.state.error!, /keeps rejecting data/);
  assert.equal(port.opened, 4, "the first open plus three reopens");
});
