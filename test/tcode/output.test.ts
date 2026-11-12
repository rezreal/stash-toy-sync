// Output timing: replays what the driver sends through a model of how TCode
// firmware moves (from where it is, linearly to the target, within the I time)
// and checks the device keeps up with fast strokes without standing still -
// including when every serial write takes longer than a frame. Ported from
// TCode Player's test/output.test.js with every expectation kept; the video
// is now the program's PlaybackClock.
import test from "node:test";
import assert from "node:assert/strict";
import { createTcodeDevice, type TcodeDevice } from "../../src/tcode/device.ts";
import type { TcodeEngine } from "../../src/tcode/engine.ts";
import type { SerialLike, SerialPortLike } from "../../src/tcode/serial.d.ts";
import { createMemoryProfileStore } from "../../src/tcode/profileStore.ts";
import { fakeProgram, FakeVideo } from "../fakes/playback.ts";

interface Cmd {
  at: number;
  target: number;
  I: number;
}

class TimedPort implements SerialPortLike {
  writeMs: number;
  failEvery: number | undefined;
  n = 0;
  opened = 0;
  cmds: Cmd[] = [];
  readable: ReadableStream<Uint8Array> | null = null;
  _ws: WritableStream<Uint8Array> | null = null;
  _broken = false;
  /** failEvery: every n-th write fails with a system error, after which the browser offers a fresh stream */
  constructor(writeMs: number, failEvery?: number) {
    this.writeMs = writeMs;
    this.failEvery = failEvery;
  }
  getInfo() {
    return { usbVendorId: 0x10c4, usbProductId: 0xea60 };
  }
  async open() {
    this.opened++;
    this.readable = new ReadableStream();
    this._ws = this._stream();
  }
  async close() {
    this.readable = null;
    this._ws = null;
  }
  get writable() {
    if (this._broken && this._ws) {
      this._ws = this._stream();
      this._broken = false;
    }
    return this._ws;
  }
  _stream() {
    return new WritableStream<Uint8Array>({
      write: async (chunk) => {
        if (this.failEvery && ++this.n % this.failEvery === 0) {
          this._broken = true;
          throw new DOMException("An unknown system error has occurred.", "UnknownError");
        }
        const at = performance.now();
        const m = /L0(\d{4})(?:I(\d+))?/.exec(new TextDecoder().decode(chunk));
        if (m) this.cmds.push({ at, target: (Number(m[1]) / 9999) * 100, I: Number(m[2] || 0) });
        await new Promise((r) => setTimeout(r, this.writeMs));
      },
    });
  }
}

// full 0 <-> 100 strokes every 150 ms - a fast sequence
const STROKE_MS = 150;
const SCRIPT = { actions: Array.from({ length: 200 }, (_, i) => ({ at: i * STROKE_MS, pos: i % 2 ? 100 : 0 })) };

const envs: { device: TcodeDevice; video: FakeVideo }[] = [];
test.afterEach(async () => {
  for (const { device, video } of envs.splice(0)) {
    video.pause();
    device.setProgram(null);
    await device.engine._cleanup(null);
    device.dispose();
  }
});

const quiet = { warn() {}, info() {} };

async function play(writeMs: number, ms: number, failEvery?: number): Promise<{ port: TimedPort; engine: TcodeEngine }> {
  const port = new TimedPort(writeMs, failEvery);
  const video = new FakeVideo({ advancing: true });
  const serial: SerialLike = { getPorts: async () => [], requestPort: async () => port, addEventListener() {} };
  const device = createTcodeDevice(undefined, {
    engine: { serial, secure: true, storage: null },
    store: createMemoryProfileStore(),
    log: quiet,
  });
  envs.push({ device, video });
  await device.ready();
  await device.connect();
  device.setProgram(fakeProgram({ clock: video, script: SCRIPT, device }));
  await new Promise((r) => setTimeout(r, 30));
  video.play();
  await new Promise((r) => setTimeout(r, ms));
  return { port, engine: device.engine };
}

/** Device position over time from the commands, per TCode: move linearly to the target within I. */
function simulate(cmds: Cmd[], from: number, to: number) {
  let start = cmds[0]!.target, k = 0;
  const posAt = (c: Cmd, s: number, t: number) => (c.I > 0 ? s + (c.target - s) * Math.min(1, (t - c.at) / c.I) : c.target);
  let lo = Infinity, hi = -Infinity, idle = 0;
  for (let t = from; t < to; t++) {
    while (k + 1 < cmds.length && cmds[k + 1]!.at <= t) {
      start = posAt(cmds[k]!, start, cmds[k + 1]!.at);
      k++;
    }
    const c = cmds[k]!;
    const p = posAt(c, start, t);
    lo = Math.min(lo, p);
    hi = Math.max(hi, p);
    if (t - c.at > c.I) idle++; // arrived, and the next command is not there yet
  }
  return { reach: (hi - lo) / 100, idle: idle / (to - from) };
}

for (const writeMs of [2, 25]) {
  test(`keeps up with fast strokes when a write takes ${writeMs} ms`, async () => {
    const { port, engine } = await play(writeMs, 1600);
    const from = port.cmds[0]!.at + 600, to = performance.now();
    const { reach, idle } = simulate(port.cmds, from, to);
    if (process.env.TCP_SRC) console.log(`writes ${writeMs} ms: reach ${(reach * 100).toFixed(0)} %, idle ${(idle * 100).toFixed(0)} %`);
    assert.ok(reach >= 0.8, `device covers ${(reach * 100).toFixed(0)} % of the stroke`);
    assert.ok(idle <= 0.1, `device stands waiting ${(idle * 100).toFixed(0)} % of the time`);
    if (engine.state.stats) assert.ok(engine.state.stats.fps > 0);
  });
}

test("a write failing every half second does not pause the output", async () => {
  const { port } = await play(2, 1600, 30); // about every 0.5 s at 60 frames a second, as seen on an SR6
  const from = port.cmds[0]!.at + 600, to = performance.now();
  const late = port.cmds.filter((c) => c.at >= from);
  const maxGap = Math.max(...late.slice(1).map((c, k) => c.at - late[k]!.at));
  const { idle } = simulate(port.cmds, from, to);
  assert.equal(port.opened, 1, "recovered on a fresh stream, no reopen");
  assert.ok(maxGap < 100, `longest gap between commands ${maxGap.toFixed(0)} ms`);
  assert.ok(idle <= 0.1, `device stands waiting ${(idle * 100).toFixed(0)} % of the time`);
});
