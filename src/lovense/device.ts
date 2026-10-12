// A Lovense toy over Web Bluetooth: pick (or reuse) the device, connect GATT,
// find the command (TX) and reply (RX) characteristics, keep the link up
// while it is wanted, and send levels through the rate-limited sender.
// Same shape as Skilltree's distance sensor (src/sensors/ble.ts): globals
// are injectable, connect() never rejects, failures end up in status() with
// a message that says what to do.
//
// Web Bluetooth notes:
// - requestDevice() needs a user gesture (a click on Connect).
// - navigator.bluetooth.getDevices() lists devices this origin was granted
//   earlier (behind a flag on some platforms, so feature-detected). With it a
//   toy paired on an earlier visit reconnects without a click (resume()).
// - A service is only reachable when it was named in the requestDevice() call
//   that granted the device, hence the long LOVENSE_SERVICES list.
// - Only in secure contexts (https or http://localhost) and Chromium browsers.
// - A toy connected to the Lovense Remote / Connect app stops advertising, so
//   the browser can't see it until the app lets go.
import type { Bluetooth, BluetoothDevice, BluetoothRemoteGATTCharacteristic, BluetoothRemoteGATTService } from "./bluetooth.d.ts";
import {
  BATTERY_COMMAND,
  DEVICE_TYPE_COMMAND,
  decodeText,
  encodeCommand,
  isLovenseName,
  modelName,
  parseReply,
  pickChannels,
  requestOptions,
  splitReplies,
  vibrateCommand,
} from "./protocol.ts";
import { createLevelSender, DEFAULT_MIN_INTERVAL_MS, type LevelSender } from "./sender.ts";
import { createListeners, defaultNow, GLOBAL_TIMERS, type Timers } from "../util/timers.ts";

export type Connection = "disconnected" | "connecting" | "connected" | "error";

export interface LovenseStatus {
  connection: Connection;
  /** the toy's Bluetooth name, e.g. "LVS-Lush42" */
  device?: string;
  /** percent, from the last "Battery;" reply */
  battery?: number;
  /** friendly model name ("Lush"), or the model letter when unknown */
  model?: string;
  /** the level last sent (0..20), while connected */
  level?: number;
  message?: string;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface LovenseDeviceOptions {
  /** default navigator.bluetooth */
  bluetooth?: Bluetooth;
  now?: () => number;
  timers?: Timers;
  /** remembers the chosen device id; null = don't. Default localStorage */
  storage?: StorageLike | null;
  /** reconnect delays in ms after the link drops; the last one repeats */
  reconnectDelaysMs?: number[];
  /** default window.isSecureContext */
  secureContext?: boolean;
  /** an extra device name prefix for the picker */
  namePrefix?: string;
  minIntervalMs?: number;
  batteryPollMs?: number;
  writeTimeoutMs?: number;
}

export interface LovenseDevice {
  /** pick (needs a user gesture) or reuse the toy and connect; never rejects */
  connect(): Promise<void>;
  /** connect a toy granted on an earlier visit, without a picker; quietly does nothing otherwise */
  resume(): Promise<void>;
  /** sends Vibrate:0, closes the link and stops reconnecting; never rejects */
  disconnect(): Promise<void>;
  /** the wanted level 0..20 (rate-limited, only changes are sent) */
  setLevel(level: number): void;
  /** resolves once the toy has the wanted level (or there is no link) */
  idle(): Promise<void>;
  /** best effort, immediate Vibrate:0 outside the queue (page unload) */
  stopNow(): void;
  status(): LovenseStatus;
  onStatus(cb: (s: LovenseStatus) => void): () => void;
  setNamePrefix(prefix: string | undefined): void;
}

export const DEVICE_KEY = "lovense.device";
export const DEFAULT_RECONNECT_DELAYS_MS = [500, 1000, 2000, 3000, 5000];
export const DEFAULT_BATTERY_POLL_MS = 60_000;
export const WRITE_TIMEOUT_MS = 2000;
/** consecutive failed writes before the link is dropped and reconnected */
export const WRITE_FAILS_RELINK = 3;
/** how long disconnect() waits for the final Vibrate:0 */
export const STOP_WRITE_TIMEOUT_MS = 500;

// --- messages ---------------------------------------------------------------------

export const MSG_NO_BLUETOOTH =
  "Web Bluetooth is not available. Use Chrome or Edge on desktop or Android (not Firefox or Safari), " +
  "and open stash over https or http://localhost.";
export const MSG_INSECURE = "Web Bluetooth only works on secure pages: open stash over https (or http://localhost).";
export const MSG_NEEDS_CLICK = "Click Connect to choose the toy: the browser shows its Bluetooth picker only after a click.";
export const MSG_NOT_CHOSEN =
  "No toy chosen. Turn the toy on, close the Lovense Remote app (a toy connected to the app is invisible to the browser) " +
  "and pick it from the browser's Bluetooth list.";
export const MSG_NO_ADAPTER = "Bluetooth is off or this computer has no Bluetooth adapter. Turn Bluetooth on and try again.";
export const MSG_PERMISSION_DENIED =
  "The browser blocked Bluetooth for this site. Allow it in the site settings (the icon left of the address bar) and try again.";
export const MSG_POLICY =
  "Bluetooth is disallowed on this page by a permissions policy (e.g. stash runs inside a frame or behind a proxy " +
  "that sends Permissions-Policy: bluetooth=()).";
export const MSG_PICK_AGAIN = "The browser hasn't granted this toy's services to the site yet. Click Connect and pick the toy again.";
export const MSG_NO_SERVICE =
  "No Lovense service found on this device. Is it a Lovense toy? If it is, click Connect and pick it again; " +
  "very new models may use a service this plugin doesn't know yet.";

function errName(e: unknown): string {
  return typeof e === "object" && e !== null && "name" in e ? String((e as { name: unknown }).name) : "";
}

function errMessage(e: unknown): string {
  return e instanceof Error
    ? e.message
    : typeof e === "object" && e !== null && "message" in e
      ? String((e as { message: unknown }).message)
      : String(e);
}

/** Status message for a failure of requestDevice() (picking the toy). */
export function pickErrorMessage(e: unknown): string {
  const name = errName(e);
  const msg = errMessage(e);
  if (/user gesture/i.test(msg)) return MSG_NEEDS_CLICK;
  if (/permissions? policy|disallowed/i.test(msg)) return MSG_POLICY;
  if (/adapter|bluetooth (is )?(turned )?off|radio/i.test(msg)) return MSG_NO_ADAPTER;
  if (name === "NotFoundError") return MSG_NOT_CHOSEN;
  if (name === "NotAllowedError" || name === "SecurityError") return MSG_PERMISSION_DENIED;
  return `Couldn't open the Bluetooth picker: ${msg}`;
}

// --- helpers ------------------------------------------------------------------------

function navigatorBluetooth(): Bluetooth | undefined {
  const nav = globalThis.navigator as (Navigator & { bluetooth?: Bluetooth }) | undefined;
  return nav?.bluetooth;
}

function defaultStorage(): StorageLike | undefined {
  try {
    return globalThis.localStorage ?? undefined;
  } catch {
    return undefined;
  }
}

function readStored(storage: StorageLike | undefined): string | undefined {
  try {
    return storage?.getItem(DEVICE_KEY) || undefined;
  } catch {
    return undefined;
  }
}

function writeStored(storage: StorageLike | undefined, id: string | undefined): void {
  try {
    if (id) storage?.setItem(DEVICE_KEY, id);
    else storage?.removeItem(DEVICE_KEY);
  } catch {
    // not remembered: the next visit asks again
  }
}

/** Web Bluetooth exists in this browser (it may still be off or blocked). */
export function bluetoothAvailable(bt: Bluetooth | undefined = navigatorBluetooth()): boolean {
  return bt !== undefined && typeof bt.requestDevice === "function";
}

/**
 * Which already-granted device is the toy: the one remembered from the last
 * connect, else the first with a Lovense name (or the custom prefix).
 */
export function pickKnownDevice<D extends { id: string; name?: string | null }>(
  devices: D[],
  rememberedId: string | undefined,
  namePrefix: string | undefined,
): D | undefined {
  if (rememberedId) {
    const hit = devices.find((d) => d.id === rememberedId);
    if (hit) return hit;
  }
  return devices.find((d) => isLovenseName(d.name, namePrefix));
}

function withTimeout<T>(p: Promise<T>, ms: number, timers: Timers, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const timer = timers.setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error(`${what}: no answer within ${ms / 1000} s`));
    }, ms);
    p.then(
      (v) => {
        if (done) return;
        done = true;
        timers.clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        if (done) return;
        done = true;
        timers.clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** writes bytes, without response when the characteristic allows it */
export function writeBytes(ch: BluetoothRemoteGATTCharacteristic, bytes: Uint8Array<ArrayBuffer>): Promise<void> {
  if (ch.properties.writeWithoutResponse && typeof ch.writeValueWithoutResponse === "function") {
    return ch.writeValueWithoutResponse(bytes);
  }
  if (typeof ch.writeValueWithResponse === "function") return ch.writeValueWithResponse(bytes);
  if (typeof ch.writeValue === "function") return ch.writeValue(bytes);
  return Promise.reject(new Error("This characteristic can't be written."));
}

/** Thrown inside start() for a failure with a ready status message. */
class Failure extends Error {
  readonly retry: boolean;
  constructor(message: string, retry = false) {
    super(message);
    this.retry = retry;
  }
}

type StartMode = "pick" | "silent" | "reconnect";

// --- device ---------------------------------------------------------------------------

export function createLovenseDevice(opts: LovenseDeviceOptions = {}): LovenseDevice {
  const now = opts.now ?? defaultNow;
  const timers = opts.timers ?? GLOBAL_TIMERS;
  const storage = opts.storage === null ? undefined : (opts.storage ?? defaultStorage());
  const delays = opts.reconnectDelaysMs?.length ? opts.reconnectDelaysMs : DEFAULT_RECONNECT_DELAYS_MS;
  const batteryPollMs = opts.batteryPollMs ?? DEFAULT_BATTERY_POLL_MS;
  const writeTimeoutMs = opts.writeTimeoutMs ?? WRITE_TIMEOUT_MS;
  let namePrefix = opts.namePrefix;

  const statuses = createListeners<LovenseStatus>();

  type BaseStatus = Pick<LovenseStatus, "connection" | "device" | "message">;
  let st: BaseStatus = { connection: "disconnected" };
  /** from the toy's replies; kept across reconnects of the same toy */
  let battery: number | undefined;
  let model: string | undefined;
  /** connect() was called and disconnect() wasn't: keep reconnecting */
  let wanted = false;
  let device: BluetoothDevice | undefined;
  let tx: BluetoothRemoteGATTCharacteristic | undefined;
  let rx: BluetoothRemoteGATTCharacteristic | undefined;
  let rxBuffer = "";
  let mustPick = false;
  let pending: Promise<void> | undefined;
  let generation = 0;
  let retryTimer: unknown;
  let batteryTimer: unknown;
  let attempt = 0;
  let everConnected = false;
  let writeFails = 0;
  let lastEmitted = "";

  // every write (levels, battery polls) goes through one chain: never overlapping
  let chain: Promise<void> = Promise.resolve();

  function enqueue(cmd: string): Promise<void> {
    const ch = tx;
    if (!ch) return Promise.reject(new Error("not connected"));
    const p = chain.then(() => {
      if (ch !== tx) throw new Error("the link changed");
      return withTimeout(writeBytes(ch, encodeCommand(cmd)), writeTimeoutMs, timers, "Writing to the toy");
    });
    chain = p.catch(() => undefined);
    return p.then(
      () => {
        writeFails = 0;
      },
      (e: unknown) => {
        if (ch === tx && st.connection === "connected") {
          writeFails++;
          if (writeFails >= WRITE_FAILS_RELINK) relink(`Writing to the toy failed: ${errMessage(e)}`);
        }
        throw e;
      },
    );
  }

  const sender: LevelSender = createLevelSender({
    write: enqueue,
    timers,
    now,
    minIntervalMs: opts.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS,
  });
  sender.onSent(() => emit());

  function deviceName(): string | undefined {
    return device?.name || undefined;
  }

  function status(): LovenseStatus {
    const out: LovenseStatus = { ...st };
    if (st.connection === "connected") {
      if (model !== undefined) out.model = model;
      if (battery !== undefined) out.battery = battery;
      out.level = sender.sent() ?? 0;
    }
    return out;
  }

  /** notifies listeners when anything visible changed */
  function emit(): void {
    const s = status();
    const key = JSON.stringify(s);
    if (key === lastEmitted) return;
    lastEmitted = key;
    statuses.emit(s);
  }

  function setStatus(next: BaseStatus): void {
    st = next;
    emit();
  }

  function named(extra: Omit<BaseStatus, "device">): BaseStatus {
    const name = deviceName();
    return name ? { ...extra, device: name } : extra;
  }

  function fail(message: string): void {
    setStatus(named({ connection: "error", message }));
  }

  const onNotify = (): void => {
    const dv = rx?.value;
    if (!dv) return;
    const { replies, rest } = splitReplies(rxBuffer + decodeText(dv));
    rxBuffer = rest;
    for (const text of replies) {
      const r = parseReply(text);
      if (r.kind === "battery") battery = r.percent;
      else if (r.kind === "deviceType") model = modelName(r.model);
    }
    emit();
  };

  const onGattDisconnected = (): void => {
    detach();
    if (!wanted) {
      if (st.connection === "connected" || st.connection === "connecting") setStatus(named({ connection: "disconnected" }));
      return;
    }
    scheduleReconnect();
  };

  /** forgets TX/RX and stops sending and polling (the link is gone or going) */
  function detach(): void {
    sender.setEnabled(false);
    if (batteryTimer !== undefined) timers.clearTimeout(batteryTimer);
    batteryTimer = undefined;
    const r = rx;
    rx = undefined;
    tx = undefined;
    rxBuffer = "";
    writeFails = 0;
    if (r) {
      r.removeEventListener("characteristicvaluechanged", onNotify);
      r.stopNotifications().catch(() => undefined);
    }
  }

  function closeGatt(d: BluetoothDevice | undefined): void {
    try {
      if (d?.gatt?.connected) d.gatt.disconnect();
    } catch {
      // already gone
    }
  }

  /** drops a link that stopped taking writes and reconnects (while wanted) */
  function relink(reason: string): void {
    detach();
    const d = device;
    d?.removeEventListener("gattserverdisconnected", onGattDisconnected);
    closeGatt(d);
    d?.addEventListener("gattserverdisconnected", onGattDisconnected);
    if (!wanted) {
      fail(reason);
      return;
    }
    scheduleReconnect(reason);
  }

  function scheduleReconnect(reason?: string): void {
    if (retryTimer !== undefined) return;
    const delay = delays[Math.min(attempt, delays.length - 1)]!;
    attempt++;
    const name = deviceName();
    const secs = Math.round(delay / 1000) || 1;
    setStatus(
      named({
        connection: "connecting",
        message: !everConnected
          ? `Waiting for ${name ? `“${name}”` : "the toy"}: turn it on and keep it close. Trying again in ${secs} s…`
          : attempt === 1
            ? `${reason ? `${reason}. ` : "The toy disconnected. "}Reconnecting…`
            : `The toy is still away. Reconnect attempt ${attempt} in ${secs} s…`,
      }),
    );
    retryTimer = timers.setTimeout(() => {
      retryTimer = undefined;
      if (!wanted) return;
      void start(++generation, "reconnect");
    }, delay);
  }

  function scheduleBattery(): void {
    if (batteryTimer !== undefined) timers.clearTimeout(batteryTimer);
    batteryTimer = timers.setTimeout(() => {
      batteryTimer = undefined;
      if (!tx || st.connection !== "connected") return;
      enqueue(BATTERY_COMMAND).catch(() => undefined);
      scheduleBattery();
    }, batteryPollMs);
  }

  async function chooseDevice(bt: Bluetooth, mode: StartMode, gen: number): Promise<BluetoothDevice | undefined> {
    if (device && !mustPick) return device;
    if (!mustPick && typeof bt.getDevices === "function") {
      try {
        const known = pickKnownDevice(await bt.getDevices(), readStored(storage), namePrefix);
        if (known) return known;
      } catch {
        // fall through to the picker
      }
      if (gen !== generation) return undefined;
    }
    if (mode === "silent") return undefined;
    try {
      const d = await bt.requestDevice(requestOptions(namePrefix));
      mustPick = false;
      return d;
    } catch (e) {
      throw new Failure(pickErrorMessage(e));
    }
  }

  /** first service with a writable characteristic */
  async function findChannels(services: BluetoothRemoteGATTService[]) {
    for (const svc of services) {
      let chars: BluetoothRemoteGATTCharacteristic[];
      try {
        chars = await svc.getCharacteristics();
      } catch {
        continue;
      }
      const picked = pickChannels(svc.uuid, chars);
      if (picked) return picked;
    }
    return undefined;
  }

  /** GATT connect, TX/RX lookup, RX subscription on `dev`; throws Failure */
  async function open(dev: BluetoothDevice, gen: number): Promise<boolean> {
    const name = dev.name || undefined;
    const gatt = dev.gatt;
    if (!gatt) throw new Failure("This Bluetooth device has no GATT server, so it can't be a Lovense toy.");
    let server;
    try {
      server = await gatt.connect();
    } catch (e) {
      throw new Failure(`Couldn't connect to ${name ? `“${name}”` : "the toy"}: ${errMessage(e)}. Is it on and in range?`, true);
    }
    if (gen !== generation) return false;
    let services: BluetoothRemoteGATTService[];
    try {
      services = await server.getPrimaryServices();
    } catch (e) {
      const n = errName(e);
      if (n === "SecurityError") {
        mustPick = true;
        writeStored(storage, undefined);
        throw new Failure(MSG_PICK_AGAIN);
      }
      if (n === "NotFoundError") throw new Failure(MSG_NO_SERVICE);
      throw new Failure(`Couldn't read the toy's services: ${errMessage(e)}`, true);
    }
    if (gen !== generation) return false;
    const picked = await findChannels(services);
    if (gen !== generation) return false;
    if (!picked) throw new Failure(MSG_NO_SERVICE);
    tx = picked.tx;
    if (picked.rx) {
      const r = picked.rx;
      rx = r;
      r.addEventListener("characteristicvaluechanged", onNotify);
      try {
        await r.startNotifications();
      } catch {
        // replies are a nice-to-have: commands still work without them
        r.removeEventListener("characteristicvaluechanged", onNotify);
        rx = undefined;
      }
    }
    if (gen !== generation) {
      detach();
      return false;
    }
    return true;
  }

  async function start(gen: number, mode: StartMode): Promise<void> {
    try {
      const bt = opts.bluetooth ?? navigatorBluetooth();
      if (!bluetoothAvailable(bt)) {
        if (mode === "silent") {
          wanted = false;
          return;
        }
        const secure = opts.secureContext ?? (globalThis as { isSecureContext?: boolean }).isSecureContext;
        throw new Failure(secure === false ? MSG_INSECURE : MSG_NO_BLUETOOTH);
      }
      if (mode === "pick") setStatus({ connection: "connecting", message: "Looking for the toy…" });
      const dev = await chooseDevice(bt!, mode, gen);
      if (gen !== generation) return;
      if (!dev) {
        // silent resume with nothing granted: stay as we were
        wanted = false;
        return;
      }
      if (dev !== device) {
        device?.removeEventListener("gattserverdisconnected", onGattDisconnected);
        device = dev;
        battery = undefined;
        model = undefined;
        dev.addEventListener("gattserverdisconnected", onGattDisconnected);
      }
      writeStored(storage, dev.id);
      if (mode !== "reconnect") setStatus(named({ connection: "connecting", message: "Connecting to the toy…" }));
      const ok = await open(dev, gen);
      if (!ok || gen !== generation) return;
      attempt = 0;
      everConnected = true;
      writeFails = 0;
      setStatus(named({ connection: "connected" }));
      // a fresh link: send the wanted level even when it is 0, so the toy starts in step
      sender.reset();
      sender.setEnabled(true);
      enqueue(DEVICE_TYPE_COMMAND).catch(() => undefined);
      enqueue(BATTERY_COMMAND).catch(() => undefined);
      scheduleBattery();
    } catch (e) {
      if (gen !== generation) return;
      const failure = e instanceof Failure ? e : new Failure(`The toy failed: ${errMessage(e)}`, true);
      detach();
      if (failure.retry && wanted && device && mode !== "silent") {
        // a known toy, just not reachable (off, out of range): keep trying while wanted
        scheduleReconnect();
        return;
      }
      wanted = false;
      closeGatt(device);
      if (mode === "silent") {
        // nobody clicked anything: no error, just a hint
        const message = failure.retry
          ? `${deviceName() ? `“${deviceName()}”` : "The toy"} isn't reachable. Turn it on and click Connect.`
          : failure.message;
        setStatus(named({ connection: "disconnected", message }));
        return;
      }
      fail(failure.message);
    }
  }

  function begin(mode: "pick" | "silent"): Promise<void> {
    if (st.connection === "connected" && tx) return Promise.resolve();
    if (pending) return pending;
    if (mode === "silent" && wanted) return Promise.resolve();
    wanted = true;
    everConnected = false;
    if (retryTimer !== undefined) {
      // a reconnect is waiting: try right away
      timers.clearTimeout(retryTimer);
      retryTimer = undefined;
    }
    const gen = ++generation;
    pending = start(gen, mode)
      .catch((e: unknown) => {
        if (gen === generation) fail(`The toy failed: ${errMessage(e)}`);
      })
      .finally(() => {
        if (gen === generation) pending = undefined;
      });
    return pending;
  }

  return {
    connect: () => begin("pick"),
    resume: () => begin("silent"),
    async disconnect() {
      wanted = false;
      const gen = ++generation;
      pending = undefined;
      attempt = 0;
      if (retryTimer !== undefined) timers.clearTimeout(retryTimer);
      retryTimer = undefined;
      const d = device;
      const was = st.connection;
      sender.set(0);
      // the final 0 goes out through the queue (after anything in flight)
      const zero = tx ? enqueue(vibrateCommand(0)).catch(() => undefined) : Promise.resolve();
      detachKeepingTx();
      if (was !== "disconnected") setStatus(named({ connection: "disconnected" }));
      try {
        await withTimeout(zero, STOP_WRITE_TIMEOUT_MS, timers, "Stopping the toy");
      } catch {
        // best effort
      }
      if (gen !== generation) return; // connect() was called meanwhile
      tx = undefined;
      d?.removeEventListener("gattserverdisconnected", onGattDisconnected);
      closeGatt(d);
      d?.addEventListener("gattserverdisconnected", onGattDisconnected);
    },
    setLevel: (level) => sender.set(level),
    idle: () => sender.idle(),
    stopNow() {
      sender.set(0);
      const ch = tx;
      if (!ch) return;
      try {
        writeBytes(ch, encodeCommand(vibrateCommand(0))).catch(() => undefined);
      } catch {
        // page is going away anyway
      }
    },
    status,
    onStatus: (cb) => statuses.add(cb),
    setNamePrefix(prefix) {
      namePrefix = prefix?.trim() || undefined;
    },
  };

  /** like detach() but keeps tx until the final 0 has been queued and written */
  function detachKeepingTx(): void {
    const keep = tx;
    detach();
    tx = keep;
  }
}
