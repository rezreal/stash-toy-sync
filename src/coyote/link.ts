// The Bluetooth side shared by both Coyote drivers: pick (or reuse) the
// device, connect GATT, let the version profile find its characteristics,
// keep the link up while it is wanted (backoff up to 5 s), read the battery,
// and run every GATT operation through one queue so two are never in flight
// ("GATT operation already in progress"). Same shape as the Lovense device
// (src/lovense/device.ts): globals injectable, connect() never rejects,
// every failure ends up in status() with a message that says what to do.
//
// Several Coyotes (one link per Toy Sync instance): each instance remembers
// its own device (storageKey) and claims the device it picks (claims), so it
// never takes, reuses or closes a Coyote another instance holds; a picked one
// that is already connected as another instance is refused with a message.
import type {
  Bluetooth,
  BluetoothCharacteristicProperties,
  BluetoothDevice,
  BluetoothRemoteGATTCharacteristic,
  BluetoothRemoteGATTServer,
  RequestDeviceOptions,
} from "../lovense/bluetooth.d.ts";
import type { StorageLike } from "../devices/calibration.ts";
import { alreadyConnectedMessage, NO_CLAIMS, type InstanceClaims } from "../devices/claims.ts";
import { createListeners, GLOBAL_TIMERS, type Timers } from "../util/timers.ts";

export type Connection = "disconnected" | "connecting" | "connected" | "error";

export interface LinkStatus {
  connection: Connection;
  /** the device's Bluetooth name (may be absent: Coyote 3.0 privacy mode) */
  name?: string;
  battery?: number;
  message?: string;
}

/** serialized GATT access for the profile and the transport */
export interface LinkIo {
  /** one write; `front` goes before everything queued that isn't `front` itself (stop packets) */
  write(ch: BluetoothRemoteGATTCharacteristic, bytes: Uint8Array<ArrayBuffer>, front?: boolean): Promise<void>;
  /** any other GATT operation (reads, subscriptions) */
  run<T>(op: () => Promise<T>, front?: boolean): Promise<T>;
  /** an operation is in flight or queued */
  busy(): boolean;
}

/** What a Coyote version tells the link. */
export interface CoyoteProfile {
  /** "Coyote 3.0", used in messages */
  readonly label: string;
  requestOptions(): RequestDeviceOptions;
  /** a granted device with this name is this kind of Coyote (for silent reconnects) */
  isOwnName(name: string | null | undefined): boolean;
  readonly batteryService: string;
  readonly batteryCharacteristic: string;
  parseBattery(bytes: Uint8Array): number | undefined;
  /** the message when the picker was closed without a choice */
  readonly notChosenMessage: string;
  /**
   * After GATT connect: find the characteristics, subscribe, read config.
   * Throw a LinkFailure for a failure with a ready message.
   */
  open(server: BluetoothRemoteGATTServer, device: BluetoothDevice, io: LinkIo): Promise<void>;
  /** the link is gone: forget the characteristics */
  detach(): void;
}

/** a failure with a ready status message */
export class LinkFailure extends Error {
  readonly retry: boolean;
  /** the grant is stale: the next connect must show the picker */
  readonly repick: boolean;
  constructor(message: string, opts: { retry?: boolean; repick?: boolean } = {}) {
    super(message);
    this.retry = opts.retry ?? false;
    this.repick = opts.repick ?? false;
  }
}

export interface LinkOptions {
  profile: CoyoteProfile;
  /** localStorage key that remembers the chosen device id */
  storageKey: string;
  bluetooth?: Bluetooth;
  timers?: Timers;
  /** null = don't remember; default localStorage */
  storage?: StorageLike | null;
  reconnectDelaysMs?: number[];
  secureContext?: boolean;
  batteryPollMs?: number;
  opTimeoutMs?: number;
  /** how long gatt.connect() may take before the attempt is given up (default CONNECT_TIMEOUT_MS) */
  connectTimeoutMs?: number;
  /** how long the profile's service setup may take (default OPEN_TIMEOUT_MS) */
  openTimeoutMs?: number;
  /** which devices other instances hold (default: none) */
  claims?: InstanceClaims;
  /**
   * With nothing remembered, take an already-granted device with this
   * version's name without the picker (default true; only the first
   * instance does, so an extra one never grabs a Coyote meant for another).
   */
  nameFallback?: boolean;
}

export interface CoyoteLink {
  /** pick (user gesture) or reuse the device and connect; never rejects */
  connect(): Promise<void>;
  /** reconnect a device granted earlier, without a picker; quietly does nothing otherwise */
  resume(): Promise<void>;
  /**
   * Stops reconnecting, runs `beforeClose` (the stop packets, given at most
   * STOP_TIMEOUT_MS) while the link is still up, then closes it. Never rejects.
   */
  disconnect(beforeClose?: () => Promise<unknown>): Promise<void>;
  /** the link is up and the profile opened */
  ready(): boolean;
  status(): LinkStatus;
  onStatus(cb: (s: LinkStatus) => void): () => void;
  /** every successful (re)connect */
  onReady(cb: () => void): () => void;
  /** the link went down (dropped or closed) */
  onLost(cb: () => void): () => void;
  /** the GATT queue became empty */
  onDrain(cb: () => void): () => void;
  readonly io: LinkIo;
  deviceId(): string | undefined;
  /** forgets the remembered device (the instance was removed) */
  forget(): void;
  /** gives up this instance's claim on its device (dispose) */
  release(): void;
}

export const DEFAULT_RECONNECT_DELAYS_MS = [500, 1000, 2000, 3000, 5000];
export const DEFAULT_BATTERY_POLL_MS = 60_000;
export const OP_TIMEOUT_MS = 2000;
/**
 * A GATT connect to a device that is off, out of range or held by another
 * app can sit for a very long time (or forever) in the browser. After this
 * the attempt is dropped and retried, so the status never hangs on
 * "connecting".
 */
export const CONNECT_TIMEOUT_MS = 20_000;
/** the profile's service discovery and notification setup after the link is up */
export const OPEN_TIMEOUT_MS = 15_000;
export const STOP_TIMEOUT_MS = 500;
/** consecutive failed writes before the link is dropped and reconnected */
export const WRITE_FAILS_RELINK = 3;

// --- messages ---------------------------------------------------------------------

export const MSG_NO_BLUETOOTH =
  "Web Bluetooth is not available. Use Chrome or Edge on desktop or Android (not Firefox or Safari), " +
  "and open stash over https or http://localhost.";
export const MSG_INSECURE = "Web Bluetooth only works on secure pages: open stash over https (or http://localhost).";
export const MSG_NEEDS_CLICK = "Click Connect to choose the Coyote: the browser shows its Bluetooth picker only after a click.";
export const MSG_NO_ADAPTER = "Bluetooth is off or this computer has no Bluetooth adapter. Turn Bluetooth on and try again.";
export const MSG_PERMISSION_DENIED =
  "The browser blocked Bluetooth for this site. Allow it in the site settings (the icon left of the address bar) and try again.";
export const MSG_POLICY =
  "Bluetooth is disallowed on this page by a permissions policy (e.g. stash runs inside a frame or behind a proxy " +
  "that sends Permissions-Policy: bluetooth=()).";
export const MSG_WAITING_TURN = "Waiting for another device to finish connecting…";
export const MSG_PICK_AGAIN = "The browser hasn't granted this Coyote's services to the site yet. Click Connect and pick it again.";

export function errName(e: unknown): string {
  return typeof e === "object" && e !== null && "name" in e ? String((e as { name: unknown }).name) : "";
}

export function errMessage(e: unknown): string {
  return e instanceof Error
    ? e.message
    : typeof e === "object" && e !== null && "message" in e
      ? String((e as { message: unknown }).message)
      : String(e);
}

/** status message for a failed requestDevice() */
export function pickErrorMessage(e: unknown, notChosen: string): string {
  const name = errName(e);
  const msg = errMessage(e);
  if (/user gesture/i.test(msg)) return MSG_NEEDS_CLICK;
  if (/permissions? policy|disallowed/i.test(msg)) return MSG_POLICY;
  if (/adapter|bluetooth (is )?(turned )?off|radio/i.test(msg)) return MSG_NO_ADAPTER;
  if (name === "NotFoundError") return notChosen;
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

export function withTimeout<T>(p: Promise<T>, ms: number, timers: Timers, what: string): Promise<T> {
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

/** writes without response when the characteristic supports it, else with response */
export function writeBytes(ch: BluetoothRemoteGATTCharacteristic, bytes: Uint8Array<ArrayBuffer>): Promise<void> {
  const p: BluetoothCharacteristicProperties = ch.properties;
  if (p.writeWithoutResponse && typeof ch.writeValueWithoutResponse === "function") return ch.writeValueWithoutResponse(bytes);
  if (typeof ch.writeValueWithResponse === "function") return ch.writeValueWithResponse(bytes);
  if (typeof ch.writeValue === "function") return ch.writeValue(bytes);
  return Promise.reject(new Error("This characteristic can't be written."));
}

/** a DataView's bytes */
export function bytesOf(dv: DataView | null | undefined): Uint8Array {
  if (!dv) return new Uint8Array(0);
  return new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
}

type StartMode = "pick" | "silent" | "reconnect";

interface Job {
  op: () => Promise<unknown>;
  front: boolean;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

// --- link -----------------------------------------------------------------------------

export function createCoyoteLink(opts: LinkOptions): CoyoteLink {
  const profile = opts.profile;
  const timers = opts.timers ?? GLOBAL_TIMERS;
  const storage = opts.storage === null ? undefined : (opts.storage ?? defaultStorage());
  const delays = opts.reconnectDelaysMs?.length ? opts.reconnectDelaysMs : DEFAULT_RECONNECT_DELAYS_MS;
  const batteryPollMs = opts.batteryPollMs ?? DEFAULT_BATTERY_POLL_MS;
  const opTimeoutMs = opts.opTimeoutMs ?? OP_TIMEOUT_MS;
  const claims: InstanceClaims = opts.claims ?? NO_CLAIMS;
  const connectTimeoutMs = opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
  const openTimeoutMs = opts.openTimeoutMs ?? OPEN_TIMEOUT_MS;
  const nameFallback = opts.nameFallback ?? true;
  const free = (id: string) => claims.heldByOther(id) === undefined;
  /** the device this instance holds a claim on */
  let claimed: string | undefined;

  function releaseClaim(): void {
    if (claimed !== undefined) claims.release(claimed);
    claimed = undefined;
  }

  const statusListeners = createListeners<LinkStatus>();
  const readyListeners = createListeners<void>();
  const lostListeners = createListeners<void>();
  const drainListeners = createListeners<void>();

  type Base = Pick<LinkStatus, "connection" | "message">;
  let st: Base = { connection: "disconnected" };
  let battery: number | undefined;
  let wanted = false;
  let device: BluetoothDevice | undefined;
  let up = false; // io enabled: the profile is opening or open
  let isReady = false;
  let mustPick = false;
  let pending: Promise<void> | undefined;
  /** gives up the attempt that is setting the link up right now (frees the connect lock); undefined when none is */
  let cancelOpen: (() => void) | undefined;
  /** where the pending attempt is: the picker may be open (choosing) or the link is being set up (opening) */
  let phase: "choosing" | "opening" | undefined;
  let generation = 0;
  let retryTimer: unknown;
  let attempt = 0;
  let everConnected = false;
  let writeFails = 0;
  let lastEmitted = "";
  let batteryChar: BluetoothRemoteGATTCharacteristic | undefined;
  let batteryTimer: unknown;

  let queue: Job[] = [];
  let running = false;

  function readStored(): string | undefined {
    try {
      return storage?.getItem(opts.storageKey) || undefined;
    } catch {
      return undefined;
    }
  }

  function writeStored(id: string | undefined): void {
    try {
      if (id) storage?.setItem(opts.storageKey, id);
      else storage?.removeItem(opts.storageKey);
    } catch {
      // not remembered: the next visit asks again
    }
  }

  // --- the GATT queue ---------------------------------------------------------------

  function pump(): void {
    if (running) return;
    const job = queue.shift();
    if (!job) return;
    running = true;
    let p: Promise<unknown>;
    try {
      p = withTimeout(job.op(), opTimeoutMs, timers, "The Coyote");
    } catch (e) {
      p = Promise.reject(e);
    }
    p.then(job.resolve, job.reject).finally(() => {
      running = false;
      if (queue.length > 0) pump();
      else drainListeners.emit();
    });
  }

  function run<T>(op: () => Promise<T>, front = false): Promise<T> {
    if (!up) return Promise.reject(new Error("The Coyote isn't connected."));
    return new Promise<T>((resolve, reject) => {
      const job: Job = { op, front, resolve: resolve as (v: unknown) => void, reject };
      if (front) {
        // after other front jobs, so a batch of stop packets keeps its order
        let i = 0;
        while (i < queue.length && queue[i]!.front) i++;
        queue.splice(i, 0, job);
      } else queue.push(job);
      pump();
    });
  }

  function write(ch: BluetoothRemoteGATTCharacteristic, bytes: Uint8Array<ArrayBuffer>, front = false): Promise<void> {
    const gen = generation;
    return run(() => writeBytes(ch, bytes), front).then(
      () => {
        writeFails = 0;
      },
      (e: unknown) => {
        if (up && isReady && gen === generation) {
          writeFails++;
          if (writeFails >= WRITE_FAILS_RELINK) relink(`Writing to the Coyote failed: ${errMessage(e)}`);
        }
        throw e;
      },
    );
  }

  const io: LinkIo = { write, run, busy: () => running || queue.length > 0 };

  // --- status -----------------------------------------------------------------------

  function status(): LinkStatus {
    const out: LinkStatus = { ...st };
    const name = device?.name || undefined;
    if (name) out.name = name;
    if (st.connection === "connected" && battery !== undefined) out.battery = battery;
    return out;
  }

  function emit(): void {
    const s = status();
    const key = JSON.stringify(s);
    if (key === lastEmitted) return;
    lastEmitted = key;
    statusListeners.emit(s);
  }

  function setStatus(next: Base): void {
    st = next;
    emit();
  }

  function fail(message: string): void {
    setStatus({ connection: "error", message });
  }

  // --- link up / down ----------------------------------------------------------------

  const onGattDisconnected = (): void => {
    detach();
    if (!wanted) {
      if (st.connection === "connected" || st.connection === "connecting") setStatus({ connection: "disconnected" });
      return;
    }
    scheduleReconnect();
  };

  const onBattery = (): void => {
    const v = profile.parseBattery(bytesOf(batteryChar?.value));
    if (v !== undefined) {
      battery = v;
      emit();
    }
  };

  /** forgets the characteristics, rejects queued operations, stops polling */
  function detach(): void {
    const wasReady = isReady;
    up = false;
    isReady = false;
    writeFails = 0;
    const q = queue;
    queue = [];
    for (const job of q) job.reject(new Error("The Coyote disconnected."));
    if (batteryTimer !== undefined) timers.clearTimeout(batteryTimer);
    batteryTimer = undefined;
    const b = batteryChar;
    batteryChar = undefined;
    if (b) {
      b.removeEventListener("characteristicvaluechanged", onBattery);
      b.stopNotifications().catch(() => undefined);
    }
    try {
      profile.detach();
    } catch (err) {
      console.error("[toysync] coyote detach failed", err);
    }
    if (wasReady) lostListeners.emit();
  }

  function closeGatt(d: BluetoothDevice | undefined): void {
    // never close a link another instance holds (one GATT connection per device in the page)
    if (d && !free(d.id)) return;
    try {
      if (d?.gatt?.connected) d.gatt.disconnect();
    } catch {
      // already gone
    }
  }

  /** closes a link that stopped taking writes and reconnects (while wanted) */
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
    const secs = Math.round(delay / 1000) || 1;
    setStatus({
      connection: "connecting",
      message: !everConnected
        ? `Waiting for the ${profile.label}: turn it on and keep it close. Trying again in ${secs} s…`
        : attempt === 1
          ? `${reason ? `${reason}. ` : `The ${profile.label} disconnected. `}Reconnecting…`
          : `The ${profile.label} is still away. Reconnect attempt ${attempt} in ${secs} s…`,
    });
    retryTimer = timers.setTimeout(() => {
      retryTimer = undefined;
      if (!wanted) return;
      void start(++generation, "reconnect");
    }, delay);
  }

  // --- battery ------------------------------------------------------------------------

  function pollBattery(): void {
    if (batteryTimer !== undefined) timers.clearTimeout(batteryTimer);
    batteryTimer = timers.setTimeout(() => {
      batteryTimer = undefined;
      const ch = batteryChar;
      if (!ch || !isReady) return;
      run(() => ch.readValue())
        .then((dv) => {
          const v = profile.parseBattery(bytesOf(dv));
          if (v !== undefined) {
            battery = v;
            emit();
          }
        })
        .catch(() => undefined);
      pollBattery();
    }, batteryPollMs);
  }

  async function setupBattery(server: BluetoothRemoteGATTServer, gen: number): Promise<void> {
    let ch: BluetoothRemoteGATTCharacteristic;
    try {
      const svc = await run(() => server.getPrimaryService(profile.batteryService));
      ch = await run(() => svc.getCharacteristic(profile.batteryCharacteristic));
    } catch {
      return; // no battery reading: not a reason to fail
    }
    if (gen !== generation || !isReady) return;
    batteryChar = ch;
    try {
      const v = profile.parseBattery(bytesOf(await run(() => ch.readValue())));
      if (v !== undefined) {
        battery = v;
        emit();
      }
    } catch {
      // try notifications / polling anyway
    }
    if (gen !== generation || batteryChar !== ch) return;
    if (ch.properties.notify) {
      ch.addEventListener("characteristicvaluechanged", onBattery);
      try {
        await run(() => ch.startNotifications());
        return;
      } catch {
        ch.removeEventListener("characteristicvaluechanged", onBattery);
      }
    }
    if (gen === generation && batteryChar === ch) pollBattery();
  }

  // --- connecting ---------------------------------------------------------------------

  function pickKnown(devices: BluetoothDevice[]): BluetoothDevice | undefined {
    const remembered = readStored();
    if (remembered) {
      const hit = devices.find((d) => d.id === remembered);
      if (hit && free(hit.id)) return hit;
    }
    if (!nameFallback) return undefined;
    // With nothing remembered a granted device is taken by its name only when
    // that is unambiguous. Two Coyotes are called the same: guessing would
    // connect whichever comes first - perhaps the one that is off, or the one
    // another instance remembers - so the picker decides.
    const own = devices.filter((d) => free(d.id) && profile.isOwnName(d.name));
    return own.length === 1 ? own[0] : undefined;
  }

  async function chooseDevice(bt: Bluetooth, mode: StartMode, gen: number): Promise<BluetoothDevice | undefined> {
    if (device && !mustPick && free(device.id)) return device;
    if (!mustPick && typeof bt.getDevices === "function") {
      try {
        const known = pickKnown(await bt.getDevices());
        if (known) return known;
      } catch {
        // fall through to the picker
      }
      if (gen !== generation) return undefined;
    }
    if (mode === "silent") return undefined;
    let d: BluetoothDevice;
    try {
      d = await bt.requestDevice(profile.requestOptions());
    } catch (e) {
      throw new LinkFailure(pickErrorMessage(e, profile.notChosenMessage));
    }
    mustPick = false;
    const other = claims.heldByOther(d.id);
    if (other !== undefined) throw new LinkFailure(alreadyConnectedMessage(other));
    return d;
  }

  /**
   * Stops a link that is still being set up: its attempt ends at once (so the
   * page's connect lock is free for the next one) and the browser is told to
   * abandon the pending GATT connect. A link that is up isn't touched.
   */
  function abortOpening(): void {
    const cancel = cancelOpen;
    if (!cancel) return;
    cancelOpen = undefined;
    cancel();
    const d = device;
    if (d && free(d.id)) {
      try {
        d.gatt?.disconnect();
      } catch {
        // nothing to abort
      }
    }
  }

  /** a promise's rejection for running out of time (withTimeout's) */
  const isTimeout = (e: unknown) => /no answer within/.test(errMessage(e));
  const seconds = (ms: number) => Math.max(1, Math.round(ms / 1000));

  async function open(dev: BluetoothDevice, gen: number, mode: StartMode): Promise<boolean> {
    if (!dev.gatt) throw new LinkFailure(`This Bluetooth device has no GATT server, so it can't be a ${profile.label}.`);
    // one link is set up at a time across the page's instances (see
    // ClaimRegistry.exclusive); a second one queues and says so
    return claims.exclusive(
      async () => {
        if (gen !== generation) return false; // superseded while queued
        if (mode !== "reconnect") setStatus({ connection: "connecting", message: `Connecting to the ${profile.label}…` });
        // abortOpening() ends this attempt from outside, whatever the browser is doing
        let wake: () => void = () => undefined;
        const cancelled = new Promise<never>((_, reject) => {
          wake = () => reject(new LinkFailure("cancelled"));
        });
        cancelled.catch(() => undefined);
        cancelOpen = wake;
        try {
          return await setUp(dev, gen, cancelled);
        } finally {
          if (cancelOpen === wake) cancelOpen = undefined;
        }
      },
      () => {
        if (gen === generation) setStatus({ connection: "connecting", message: MSG_WAITING_TURN });
      },
    );
  }

  /** connect GATT and let the profile discover its services; `cancelled` rejects when the attempt is abandoned */
  async function setUp(dev: BluetoothDevice, gen: number, cancelled: Promise<never>): Promise<boolean> {
    const gatt = dev.gatt!;
    let server: BluetoothRemoteGATTServer;
    try {
      server = await Promise.race([withTimeout(gatt.connect(), connectTimeoutMs, timers, "Connecting"), cancelled]);
    } catch (e) {
      if (e instanceof LinkFailure) throw e;
      if (isTimeout(e)) {
        // abandon the pending connect so the browser lets go of the device
        try {
          gatt.disconnect();
        } catch {
          // nothing to abort
        }
        throw new LinkFailure(
          `The ${profile.label} didn't answer within ${seconds(connectTimeoutMs)} s. Is it on, in range and not connected to another app or page?`,
          { retry: true },
        );
      }
      throw new LinkFailure(`Couldn't connect to the ${profile.label}: ${errMessage(e)}. Is it on and in range?`, { retry: true });
    }
    if (gen !== generation) return false;
    up = true;
    try {
      await Promise.race([withTimeout(profile.open(server, dev, io), openTimeoutMs, timers, "Setting up"), cancelled]);
    } catch (e) {
      if (e instanceof LinkFailure) {
        if (e.repick) {
          mustPick = true;
          writeStored(undefined);
        }
        throw e;
      }
      if (isTimeout(e)) {
        throw new LinkFailure(`The ${profile.label} connected but didn't finish setting up within ${seconds(openTimeoutMs)} s.`, { retry: true });
      }
      const n = errName(e);
      if (n === "SecurityError") {
        mustPick = true;
        writeStored(undefined);
        throw new LinkFailure(MSG_PICK_AGAIN);
      }
      throw new LinkFailure(`Couldn't set up the ${profile.label}: ${errMessage(e)}`, { retry: true });
    }
    if (gen !== generation) {
      detach();
      return false;
    }
    void setupBattery(server, gen);
    return true;
  }

  async function start(gen: number, mode: StartMode): Promise<void> {
    try {
      const bt = opts.bluetooth ?? navigatorBluetooth();
      if (!bt || typeof bt.requestDevice !== "function") {
        if (mode === "silent") {
          wanted = false;
          return;
        }
        const secure = opts.secureContext ?? (globalThis as { isSecureContext?: boolean }).isSecureContext;
        throw new LinkFailure(secure === false ? MSG_INSECURE : MSG_NO_BLUETOOTH);
      }
      if (mode === "pick") setStatus({ connection: "connecting", message: `Looking for the ${profile.label}…` });
      if (gen === generation) phase = "choosing";
      const dev = await chooseDevice(bt, mode, gen);
      if (gen !== generation) return;
      if (!dev) {
        wanted = false; // silent resume with nothing granted: stay as we were
        return;
      }
      if (!claims.claim(dev.id)) {
        // taken by another instance meanwhile
        throw new LinkFailure(alreadyConnectedMessage(claims.heldByOther(dev.id) ?? "another device"));
      }
      if (claimed !== dev.id) releaseClaim();
      claimed = dev.id;
      if (dev !== device) {
        device?.removeEventListener("gattserverdisconnected", onGattDisconnected);
        device = dev;
        battery = undefined;
        dev.addEventListener("gattserverdisconnected", onGattDisconnected);
      }
      writeStored(dev.id);
      phase = "opening";
      const ok = await open(dev, gen, mode);
      if (!ok || gen !== generation) return;
      attempt = 0;
      everConnected = true;
      writeFails = 0;
      isReady = true;
      setStatus({ connection: "connected" });
      readyListeners.emit();
    } catch (e) {
      if (gen !== generation) return;
      const failure = e instanceof LinkFailure ? e : new LinkFailure(`The ${profile.label} failed: ${errMessage(e)}`, { retry: true });
      detach();
      if (failure.retry && wanted && device && mode !== "silent") {
        scheduleReconnect(); // a known device, just not reachable: keep trying while wanted
        return;
      }
      wanted = false;
      closeGatt(device);
      releaseClaim();
      if (mode === "silent") {
        const message = failure.retry ? `The ${profile.label} isn't reachable. Turn it on and click Connect.` : failure.message;
        setStatus({ connection: "disconnected", message });
        return;
      }
      fail(failure.message);
    }
  }

  function begin(mode: "pick" | "silent"): Promise<void> {
    if (st.connection === "connected" && isReady) return Promise.resolve();
    if (pending) {
      // A Connect click while the link is being set up means "try again now":
      // drop the stuck attempt (and abort its pending GATT connect) instead of
      // handing back the same promise forever. While the picker is open it
      // stays the same attempt.
      if (mode !== "pick" || phase !== "opening") return pending;
      generation++;
      pending = undefined;
      phase = undefined;
      abortOpening();
      detach();
    }
    if (mode === "silent" && wanted) return Promise.resolve();
    wanted = true;
    everConnected = false;
    if (retryTimer !== undefined) {
      timers.clearTimeout(retryTimer);
      retryTimer = undefined;
    }
    const gen = ++generation;
    pending = start(gen, mode)
      .catch((e: unknown) => {
        if (gen === generation) fail(`The ${profile.label} failed: ${errMessage(e)}`);
      })
      .finally(() => {
        if (gen === generation) {
          pending = undefined;
          phase = undefined;
        }
      });
    return pending;
  }

  return {
    connect: () => begin("pick"),
    resume: () => begin("silent"),
    async disconnect(beforeClose) {
      wanted = false;
      const gen = ++generation;
      pending = undefined;
      phase = undefined;
      attempt = 0;
      abortOpening();
      if (retryTimer !== undefined) timers.clearTimeout(retryTimer);
      retryTimer = undefined;
      const d = device;
      const was = st.connection;
      if (was !== "disconnected") setStatus({ connection: "disconnected" });
      if (up && isReady && beforeClose) {
        try {
          await withTimeout(Promise.resolve().then(beforeClose), STOP_TIMEOUT_MS, timers, "Stopping the Coyote");
        } catch {
          // best effort
        }
      }
      if (gen !== generation) return; // connect() was called meanwhile
      detach();
      d?.removeEventListener("gattserverdisconnected", onGattDisconnected);
      closeGatt(d);
      d?.addEventListener("gattserverdisconnected", onGattDisconnected);
      releaseClaim();
    },
    ready: () => up && isReady,
    status,
    onStatus: (cb) => statusListeners.add(cb),
    onReady: (cb) => readyListeners.add(cb),
    onLost: (cb) => lostListeners.add(cb),
    onDrain: (cb) => drainListeners.add(cb),
    io,
    deviceId: () => device?.id ?? readStored(),
    forget() {
      writeStored(undefined);
    },
    release: releaseClaim,
  };
}
