// The Hismith PiuPiu lube launcher over Web Bluetooth as a Toy Sync
// self-timed device (kind "piupiu"). Ported from TCode Player ("Drive the
// Hismith PiuPiu lube launcher over Web Bluetooth"), where it followed the
// TCode A2 axis; here it is its own device with its own scene mapping: the
// channel mapped to "squirt" (by default the script's lube / A2 channel),
// after invert and range, fires while it is above half.
//
// - One momentary command, no parameters and no feedback
//   (buttplugio/docs.buttplug.io#34); a longer shot is the command resent
//   every 100 ms, one write in flight at a time. No time cap: it fires for as
//   long as the script holds it.
// - It stops on pause, seek, the end, a closed scene, stopNow() and disconnect.
// - Auto-connect (resume) only reconnects the launcher this plugin paired
//   with, never one another plugin in the page already holds, and not at all
//   while TCode Player is active in the page.
import type { Bluetooth, BluetoothDevice, BluetoothRemoteGATTCharacteristic } from "../lovense/bluetooth.d.ts";
import type { DriverContext } from "../devices/registry.ts";
import type {
  ChannelMapping,
  DeviceProgram,
  DeviceStatus,
  MappingTarget,
  PlaybackEvent,
  ScriptChannel,
  SelfTimedDevice,
} from "../devices/types.ts";
import { tcodePlayerPresent } from "../tcode/coexist.ts";
import { applyChannelMap, clamp, normalizeChannelName, num, valueAt } from "../tcode/core.ts";
import { GLOBAL_INTERVAL_TIMERS, type IntervalTimers, type StorageLike } from "../tcode/engine.ts";

export const PIUPIU = {
  names: ["Hismith Piupiu", "Piupiu"],
  service: 0xffe5,
  tx: 0xffe9,
  squirt: [0xcc, 0x0b, 0x01, 0x0c],
  threshold: 0.5,
  repeatMs: 100,
} as const;

/** id of the launcher this plugin last paired with */
export const DEVICE_KEY = "toysync.piupiu.device";
/** TCode Player's key for the same, read once it is gone */
export const LEGACY_DEVICE_KEY = "tcp-lube";
/** the one mapping target */
export const SQUIRT_TARGET = "squirt";
/** how often playback is sampled (TCode Player's default output rate) */
export const TICK_MS = 1000 / 60;
/** how often the device checks the clock while not sampling (missed events) */
export const WATCH_MS = 250;
/** channels mapped to the launcher by default */
export const DEFAULT_CHANNELS = ["lube", "A2"];

export const MSG_IN_USE = "The lube launcher is already in use by another plugin.";
export const MSG_GONE = "Lube launcher disconnected";
export const MSG_NO_BLUETOOTH =
  "Web Bluetooth is not available. Use Chrome or Edge on desktop, and open stash over https or http://localhost.";
export const MSG_OLD_PLUGIN =
  "The TCode Player plugin is also active in this page, so Toy Sync doesn't reconnect the lube launcher on its own. " +
  "Disable TCode Player, or connect here by hand.";

export interface PiupiuDevice extends SelfTimedDevice {
  readonly kind: "piupiu";
  /** hold-to-squirt: fires while on */
  squirt(on: boolean): void;
  /** firing right now (playback, Test or hold-to-squirt) */
  active(): boolean;
  /** runs TCode Player's Test sweep through one mapped channel's range: fires while it is above half */
  testChannel(channelId: string): void;
  program(): DeviceProgram | null;
  resume(): Promise<void>;
  mappingTargets(): readonly MappingTarget[];
  defaultMapping(channels: readonly ScriptChannel[]): Record<string, ChannelMapping>;
  dispose(): void;
}

export interface PiupiuDeviceOptions {
  /** default navigator.bluetooth */
  bluetooth?: Bluetooth | undefined;
  /** default localStorage, null = don't remember */
  storage?: StorageLike | null;
  timers?: IntervalTimers;
  oldPluginPresent?: () => boolean;
  log?: Pick<Console, "warn" | "info">;
  /** a React component (props { device }): hold-to-squirt */
  settingsPanel?: unknown;
}

type Connection = DeviceStatus["connection"];

function errText(e: unknown): string {
  return String((e && typeof e === "object" && "message" in e && (e as Error).message) || e);
}
function errName(e: unknown): string {
  return e && typeof e === "object" && "name" in e ? String((e as Error).name) : "";
}

function navigatorBluetooth(): Bluetooth | undefined {
  const nav = globalThis.navigator as (Navigator & { bluetooth?: Bluetooth }) | undefined;
  return nav?.bluetooth;
}

function defaultStorage(): StorageLike | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function createPiupiuDevice(_ctx: DriverContext | undefined, opts: PiupiuDeviceOptions = {}): PiupiuDevice {
  const bt = "bluetooth" in opts ? opts.bluetooth : navigatorBluetooth();
  const storage = opts.storage === undefined ? defaultStorage() : opts.storage;
  const timers = opts.timers ?? GLOBAL_INTERVAL_TIMERS;
  const log = opts.log ?? console;
  const oldPluginPresent = opts.oldPluginPresent ?? (() => tcodePlayerPresent());

  let connection: Connection = "disconnected";
  let error: string | null = null;
  let notice: string | null = null;
  let dev: BluetoothDevice | null = null;
  let ch: BluetoothRemoteGATTCharacteristic | null = null;
  let onGone: (() => void) | null = null;
  let writing = false;
  let fireTimer: unknown = null;
  let auto = false; // from playback / Test
  let manual = false; // hold-to-squirt
  let shown = false; // what status() last said about firing

  let program: DeviceProgram | null = null;
  let unclock: (() => void) | null = null;
  let tickTimer: unknown = null;
  let watchTimer: unknown = null;
  let testing = false;
  let halted = false;

  const listeners = new Set<(s: DeviceStatus) => void>();
  let lastStatus = "";

  function read(key: string): string | null {
    try {
      return storage?.getItem(key) || null;
    } catch {
      return null;
    }
  }

  function status(): DeviceStatus {
    const out: DeviceStatus = { connection };
    out.device = dev?.name || "Hismith PiuPiu";
    const message = error ?? (!bt ? MSG_NO_BLUETOOTH : null) ?? notice;
    if (message) out.message = message;
    if (connection === "connected") out.output = { a: shown ? 1 : 0 };
    return out;
  }

  function emit(): void {
    const st = status();
    const json = JSON.stringify(st);
    if (json === lastStatus) return;
    lastStatus = json;
    for (const cb of [...listeners]) {
      try {
        cb(st);
      } catch (e) {
        log.warn("[toysync] piupiu status listener failed", e);
      }
    }
  }

  function setConnection(c: Connection, err: string | null): void {
    connection = c;
    error = err;
    emit();
  }

  /* ---------- firing ---------- */

  function sendSquirt(): void {
    const c = ch;
    if (!c || writing) return; // one write in flight at a time
    writing = true;
    const data = new Uint8Array(PIUPIU.squirt);
    let write: Promise<void> | undefined;
    try {
      write =
        c.properties && c.properties.writeWithoutResponse && c.writeValueWithoutResponse
          ? c.writeValueWithoutResponse(data)
          : c.writeValueWithResponse
            ? c.writeValueWithResponse(data)
            : c.writeValue?.(data);
    } catch (e) {
      write = Promise.reject(e);
    }
    Promise.resolve(write)
      .catch((e: unknown) => log.warn("[toysync] lube write failed", e))
      .finally(() => {
        writing = false;
      });
  }

  function apply(): void {
    const active = auto || manual;
    if (active !== shown) {
      shown = active;
      emit();
    }
    const fire = active && !!ch;
    if (fire && fireTimer === null) {
      sendSquirt();
      fireTimer = timers.setInterval(sendSquirt, PIUPIU.repeatMs);
    } else if (!fire && fireTimer !== null) {
      timers.clearInterval(fireTimer); // the launcher stops once the command stops coming
      fireTimer = null;
    }
  }

  function setAuto(on: boolean): void {
    if (auto === on) return;
    auto = on;
    apply();
  }

  /* ---------- playback ---------- */

  /** the channels mapped to the launcher, with their mapping */
  function mapped(): { actions: ScriptChannel["actions"]; m: ChannelMapping }[] {
    if (!program) return [];
    const out: { actions: ScriptChannel["actions"]; m: ChannelMapping }[] = [];
    for (const c of program.channels) {
      const m = program.mapping[c.id];
      if (m && m.target === SQUIRT_TARGET) out.push({ actions: c.actions, m });
    }
    return out;
  }

  function shouldRun(): boolean {
    return !!(program && ch && !testing && !halted && program.clock.playing() && mapped().length > 0);
  }

  function tick(): void {
    if (!program || !shouldRun()) {
      updateLoop();
      return;
    }
    const now = program.clock.scriptMs();
    if (now === undefined) return;
    const t = now + TICK_MS; // one tick ahead, as TCode Player's loop
    let fire = false;
    for (const { actions, m } of mapped()) {
      const raw = valueAt(actions, t);
      if (raw == null) continue;
      const v = applyChannelMap(raw, { invert: !!m.invert, min: clamp(num(m.min, 0), 0, 100), max: clamp(num(m.max, 100), 0, 100) });
      fire = v / 100 > PIUPIU.threshold; // the last mapped channel wins, as on TCode axes
    }
    setAuto(fire);
  }

  function updateLoop(): void {
    const run = shouldRun();
    if (run && tickTimer === null) {
      tickTimer = timers.setInterval(tick, TICK_MS);
      tick();
    } else if (!run && tickTimer !== null) {
      timers.clearInterval(tickTimer);
      tickTimer = null;
      setAuto(false); // pause, seek, scene left: stop squirting
    }
  }

  function onClock(e: PlaybackEvent): void {
    if (e === "play" || e === "seek") halted = false;
    if (e !== "play") setAuto(false); // pause, seek, ended, a new scene: stop until the script says again
    updateLoop();
  }

  function unbindClock(): void {
    unclock?.();
    unclock = null;
    if (watchTimer !== null) timers.clearInterval(watchTimer);
    watchTimer = null;
  }

  /* ---------- Bluetooth ---------- */

  function close(reason: string | null): void {
    if (dev && onGone) dev.removeEventListener("gattserverdisconnected", onGone);
    onGone = null;
    dev = null;
    ch = null;
    writing = false;
    apply();
    updateLoop();
    setConnection(reason ? "error" : "disconnected", reason);
  }

  async function open(device: BluetoothDevice, quiet: boolean): Promise<boolean> {
    if (device.gatt && device.gatt.connected) {
      // already connected in this page - another plugin is using it
      if (!quiet) setConnection("error", MSG_IN_USE);
      return false;
    }
    notice = null;
    setConnection("connecting", null);
    try {
      const server = await device.gatt!.connect();
      const service = await server.getPrimaryService(PIUPIU.service);
      const c = await service.getCharacteristic(PIUPIU.tx);
      dev = device;
      ch = c;
      onGone = () => close(MSG_GONE);
      device.addEventListener("gattserverdisconnected", onGone);
    } catch (e) {
      try {
        if (device.gatt && device.gatt.connected) device.gatt.disconnect();
      } catch {
        /* ignore */
      }
      if (quiet) {
        log.info("[toysync] lube launcher not reachable, not auto-connecting", e);
        setConnection("disconnected", null);
      } else {
        setConnection("error", "Could not connect the lube launcher: " + errText(e));
      }
      return false;
    }
    try {
      storage?.setItem(DEVICE_KEY, device.id);
    } catch {
      // not remembered: no auto-connect next time
    }
    setConnection("connected", null);
    apply();
    updateLoop();
    return true;
  }

  const device: PiupiuDevice = {
    kind: "piupiu",
    selfTimed: true,
    get id() {
      return dev?.id ?? read(DEVICE_KEY) ?? "piupiu";
    },
    async connect() {
      if (!bt) {
        setConnection("error", MSG_NO_BLUETOOTH);
        return;
      }
      let picked: BluetoothDevice;
      try {
        picked = await bt.requestDevice({
          filters: PIUPIU.names.map((namePrefix) => ({ namePrefix })),
          optionalServices: [PIUPIU.service],
        });
      } catch (e) {
        if (errName(e) === "NotFoundError") return; // picker cancelled
        setConnection("error", errText(e));
        return;
      }
      await open(picked, false);
    },
    /** Like serial auto-connect: only the launcher this plugin paired with, and only if nobody else holds it. */
    async resume() {
      if (!bt || connection === "connected" || connection === "connecting") return;
      if (oldPluginPresent()) {
        log.info("[toysync] TCode Player is active in this page, not auto-connecting the lube launcher");
        notice = MSG_OLD_PLUGIN;
        emit();
        return;
      }
      try {
        const known = read(DEVICE_KEY) ?? read(LEGACY_DEVICE_KEY);
        if (!known || !bt.getDevices) return;
        const devices = await bt.getDevices();
        const found = devices.find((d) => d.id === known);
        if (found && !(found.gatt && found.gatt.connected)) await open(found, true);
      } catch (e) {
        log.info("[toysync] lube launcher auto-connect skipped", e);
      }
    },
    disconnect() {
      const d = dev;
      manual = false;
      auto = false;
      close(null);
      try {
        if (d && d.gatt && d.gatt.connected) d.gatt.disconnect();
      } catch {
        /* ignore */
      }
    },
    status,
    onStatus(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    drive() {
      // self-timed: follows the program's clock, not the engine's DriveFrames
    },
    nudge: () => false,
    /** one shot: the shortest squirt there is */
    test() {
      sendSquirt();
    },
    testChannel(channelId) {
      if (!ch || testing || !program) return;
      const c = program.channels.find((x) => x.id === channelId || normalizeChannelName(x.id) === normalizeChannelName(channelId));
      const m = c ? program.mapping[c.id] : undefined;
      if (!m || m.target !== SQUIRT_TARGET) return;
      const mm = { invert: !!m.invert, min: clamp(num(m.min, 0), 0, 100), max: clamp(num(m.max, 100), 0, 100) };
      const lo = applyChannelMap(0, mm) / 100, hi = applyChannelMap(100, mm) / 100;
      testing = true;
      updateLoop();
      const seq: [number, number][] = [[lo, 700], [hi, 900], [lo, 900], [0, 700]];
      const sleep = (ms: number) => new Promise<void>((r) => timers.setTimeout(r, ms));
      void (async () => {
        for (const [x, ms] of seq) {
          setAuto(x > PIUPIU.threshold);
          await sleep(ms + 50);
        }
        setAuto(false);
        testing = false;
        updateLoop();
      })();
    },
    squirt(on) {
      on = !!on;
      if (manual === on) return;
      manual = on;
      apply();
    },
    active: () => auto || manual,
    stopNow() {
      halted = true;
      manual = false;
      if (tickTimer !== null) timers.clearInterval(tickTimer);
      tickTimer = null;
      auto = false;
      apply();
    },
    setProgram(p) {
      const prev = program;
      if (!p) {
        if (!prev) return;
        unbindClock();
        program = null;
        updateLoop();
        setAuto(false);
        return;
      }
      if (!prev || prev.clock !== p.clock) {
        unbindClock();
        unclock = p.clock.onChange(onClock);
        watchTimer = timers.setInterval(() => {
          if (shouldRun() !== (tickTimer !== null)) updateLoop();
        }, WATCH_MS);
      }
      if (!prev || prev.sceneId !== p.sceneId) halted = false;
      program = p;
      updateLoop();
    },
    program: () => program,
    mappingTargets: (): readonly MappingTarget[] => [{ id: SQUIRT_TARGET, label: "Squirt (fires above 50 %)", group: "Lube launcher" }],
    defaultMapping(channels) {
      const out: Record<string, ChannelMapping> = {};
      for (const c of channels) {
        if (DEFAULT_CHANNELS.includes(normalizeChannelName(c.id))) out[c.id] = { target: SQUIRT_TARGET };
      }
      return out;
    },
    settingsPanel: opts.settingsPanel,
    dispose() {
      unbindClock();
      if (tickTimer !== null) timers.clearInterval(tickTimer);
      tickTimer = null;
      manual = false;
      auto = false;
      apply();
      listeners.clear();
    },
  };
  return device;
}
