// Hismith PiuPiu lube launcher: follows the lube channel during playback,
// resending the squirt command while the lube value is above half, with no
// time cap. Ported from TCode Player's test/lube.test.js with the same inputs
// and expectations. What moved: the launcher is its own device (it followed
// the TCode A2 axis before) and gets the scene's lube channel through its
// default mapping; the video is the program's clock; auto-connect runs in
// resume() (TCode Player ran it at load); it remembers the launcher under
// Toy Sync's key (TCode Player's "tcp-lube" is still read once TCode Player
// is gone, which the auto-connect test relies on). The droplet on the 3D
// preview stays with the TCode device, which still tracks A2.
import test from "node:test";
import assert from "node:assert/strict";
import type { Bluetooth, BluetoothDevice } from "../../src/lovense/bluetooth.d.ts";
import { createPiupiuDevice, DEVICE_KEY, type PiupiuDevice } from "../../src/piupiu/device.ts";
import { createTcodeDevice, type TcodeDevice } from "../../src/tcode/device.ts";
import { createMemoryProfileStore } from "../../src/tcode/profileStore.ts";
import { fakeProgram, FakeVideo } from "../fakes/playback.ts";

const SQUIRT = [0xcc, 0x0b, 0x01, 0x0c];

class FakeLauncher {
  id: string;
  name = "Hismith Piupiu";
  writes: number[][] = [];
  connects = 0;
  gatt: { connected: boolean; connect(): Promise<unknown>; disconnect(): void };
  constructor(id: string) {
    this.id = id;
    const self = this;
    this.gatt = {
      connected: false,
      async connect() {
        self.connects++;
        this.connected = true;
        return {
          getPrimaryService: async (svc: number) => {
            assert.equal(svc, 0xffe5);
            return {
              getCharacteristic: async (ch: number) => {
                assert.equal(ch, 0xffe9);
                return {
                  properties: { writeWithoutResponse: true },
                  writeValueWithoutResponse: async (d: Uint8Array) => {
                    self.writes.push(Array.from(d));
                  },
                };
              },
            };
          },
        };
      },
      disconnect() {
        this.connected = false;
      },
    };
  }
  addEventListener() {}
  removeEventListener() {}
}

// stroke plus a lube channel that is high from 1 s to 9 s
const SCRIPT = {
  version: "2.0",
  actions: [{ at: 0, pos: 0 }, { at: 10000, pos: 100 }],
  channels: {
    lube: { actions: [{ at: 0, pos: 0 }, { at: 999, pos: 0 }, { at: 1000, pos: 100 }, { at: 9000, pos: 100 }, { at: 9001, pos: 0 }] },
  },
};

interface Env {
  store: Map<string, string>;
  video: FakeVideo;
  engine: PiupiuDevice;
  tcode?: TcodeDevice;
}

// devices from finished tests: stop their timers so node can exit
const envs: Env[] = [];
test.afterEach(() => {
  for (const { engine, tcode } of envs.splice(0)) {
    engine.disconnect();
    engine.setProgram(null);
    engine.dispose();
    if (tcode) {
      tcode.setProgram(null);
      tcode.dispose();
    }
  }
});

function load({ devices = [] as FakeLauncher[], storage = {} as Record<string, string> } = {}): Env {
  const store = new Map(Object.entries(storage));
  const video = new FakeVideo();
  const bluetooth = {
    requestDevice: async () => devices[0] as unknown as BluetoothDevice,
    getDevices: async () => devices as unknown as BluetoothDevice[],
  } as Bluetooth;
  const engine = createPiupiuDevice(undefined, {
    bluetooth,
    storage: { getItem: (k) => (store.has(k) ? store.get(k)! : null), setItem: (k, v) => void store.set(k, String(v)) },
    oldPluginPresent: () => false,
    log: { warn() {}, info() {} },
  });
  void engine.resume(); // TCode Player auto-connected at load; Toy Sync's manager calls resume()
  const env: Env = { store, video, engine };
  envs.push(env);
  return env;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function playScene(env: Env, device: { setProgram: PiupiuDevice["setProgram"]; defaultMapping: PiupiuDevice["defaultMapping"] } = env.engine) {
  device.setProgram(fakeProgram({ clock: env.video, script: SCRIPT, device }));
  await wait(30); // script loaded, video attached
  env.video.play();
}

test("fires while the lube channel is high and stops when it drops", async () => {
  const dev = new FakeLauncher("piu");
  const env = load({ devices: [dev] });
  await env.engine.connect();
  assert.equal(env.engine.status().connection, "connected");
  assert.equal(env.store.get(DEVICE_KEY), "piu");

  env.video.currentTime = 0.2;
  await playScene(env);
  await wait(150);
  assert.equal(dev.writes.length, 0, "no squirt while lube is low");

  env.video.currentTime = 2;
  await wait(350);
  assert.equal(env.engine.active(), true);
  assert.ok(dev.writes.length >= 3, `resends while held (got ${dev.writes.length})`);
  assert.deepEqual(dev.writes[0], SQUIRT);

  env.video.currentTime = 9.5;
  await wait(100);
  const n = dev.writes.length;
  await wait(250);
  assert.equal(env.engine.active(), false);
  assert.ok(dev.writes.length <= n + 1, "stops resending once the lube value drops");
  env.video.pause();
  env.engine.disconnect();
});

test("keeps firing for as long as the script says - no time cap", async () => {
  const dev = new FakeLauncher("piu");
  const env = load({ devices: [dev] });
  await env.engine.connect();
  env.video.currentTime = 1.5;
  await playScene(env);
  await wait(1300);
  assert.equal(env.engine.active(), true);
  const n = dev.writes.length;
  await wait(250);
  assert.ok(dev.writes.length >= n + 2, "still resending after more than a second");
  env.video.pause();
  env.engine.disconnect();
});

test("pausing the video stops the launcher", async () => {
  const dev = new FakeLauncher("piu");
  const env = load({ devices: [dev] });
  await env.engine.connect();
  env.video.currentTime = 2;
  await playScene(env);
  await wait(200);
  assert.equal(env.engine.active(), true);
  env.video.pause();
  const n = dev.writes.length;
  await wait(300);
  assert.equal(env.engine.active(), false);
  assert.equal(dev.writes.length, n);
  env.engine.disconnect();
});

test("hold-to-squirt fires until released", async () => {
  const dev = new FakeLauncher("piu");
  const env = load({ devices: [dev] });
  await env.engine.connect();
  env.engine.squirt(true);
  await wait(250);
  assert.ok(dev.writes.length >= 2);
  env.engine.squirt(false);
  const n = dev.writes.length;
  await wait(250);
  assert.equal(dev.writes.length, n);
  env.engine.disconnect();
});

test("shows on the preview without a launcher connected", async () => {
  const env = load();
  const tcode = createTcodeDevice(undefined, {
    engine: { serial: undefined, secure: true, storage: null, oldPluginPresent: () => false },
    store: createMemoryProfileStore(),
    log: { warn() {}, info() {} },
  });
  env.tcode = tcode;
  await tcode.ready();
  tcode.engine.addEmulator({ write() {} }); // a mounted 3D preview acts as the virtual device
  env.video.currentTime = 2;
  await playScene(env, tcode);
  await wait(100);
  assert.equal(tcode.engine.state.lubeActive, true);
  env.video.pause();
});

test("auto-connects only the launcher it paired with, and not one in use", async () => {
  const other = new FakeLauncher("other");
  const mine = new FakeLauncher("piu");
  let env = load({ devices: [other, mine], storage: { "tcp-lube": "piu" } });
  await wait(30);
  assert.equal(other.connects, 0);
  assert.equal(mine.connects, 1);
  assert.equal(env.engine.status().connection, "connected");
  env.engine.disconnect();

  const busy = new FakeLauncher("piu");
  busy.gatt.connected = true; // held by another plugin in this page
  env = load({ devices: [busy], storage: { "tcp-lube": "piu" } });
  await wait(30);
  assert.equal(busy.connects, 0);
  assert.equal(env.engine.status().connection, "disconnected");

  const none = new FakeLauncher("piu");
  env = load({ devices: [none] });
  await wait(30);
  assert.equal(none.connects, 0, "never paired: no auto-connect");
});

test("connecting a launcher another plugin holds reports it instead of taking it", async () => {
  const busy = new FakeLauncher("piu");
  busy.gatt.connected = true;
  const env = load({ devices: [busy] });
  await env.engine.connect();
  assert.equal(busy.connects, 0);
  assert.equal(env.engine.status().connection, "error");
  assert.match(env.engine.status().message!, /in use/);
});
