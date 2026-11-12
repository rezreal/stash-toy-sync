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
import { alreadyConnectedMessage, type InstanceClaims } from "../devices/claims.ts";
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
  const claims: InstanceClaims = opts.claims ?? { heldByOther: () => undefined, claim: () => true, release: () => undefined };
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
    return devices.find((d) => free(d.id) && profile.isOwnName(d.name));
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

  async function open(dev: BluetoothDevice, gen: number): Promise<boolean> {
    const gatt = dev.gatt;
    if (!gatt) throw new LinkFailure(`This Bluetooth device has no GATT server, so it can't be a ${profile.label}.`);
    let server: BluetoothRemoteGATTServer;
    try {
      server = await gatt.connect();
    } catch (e) {
      throw new LinkFailure(`Couldn't connect to the ${profile.label}: ${errMessage(e)}. Is it on and in range?`, { retry: true });
    }
    if (gen !== generation) return false;
    up = true;
    try {
      await profile.open(server, dev, io);
    } catch (e) {
      if (e instanceof LinkFailure) {
        if (e.repick) {
          mustPick = true;
          writeStored(undefined);
        }
        throw e;
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
      if (mode !== "reconnect") setStatus({ connection: "connecting", message: `Connecting to the ${profile.label}…` });
      const ok = await open(dev, gen);
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
    if (pending) return pending;
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
        if (gen === generation) pending = undefined;
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
      attempt = 0;
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
