// The TCode engine: the Web Serial connection, the output loop and the 3D
// previews. Ported from TCode Player's `engine` (plugin/TCodePlayer.js) with
// its real-hardware fixes intact:
//
// - "Recover the serial connection after a failed write": a failed write
//   leaves the port's output stream broken, so the engine takes a fresh
//   stream if the browser offers one, else reopens the port, and gives up
//   with a clear error after three reopens within a minute. Errors are
//   logged once per kind per connection and counted for the readout; the
//   read loop restarts after a non-fatal read error.
// - "Stop the stop-go: time output frames like MultiFunPlayer": a frame due
//   while a write is in flight waits for it instead of being dropped; each
//   command's move time is the measured frame spacing plus a tenth; only
//   changed axes are sent; the clock is smoothed between reads.
// - "Don't pause the output after recovering a failed write": recovering on a
//   fresh stream carries on without the resync ramp (a reopen still ramps).
//
// What changed for Toy Sync: time, pause, seek and scene changes come from the
// program's PlaybackClock instead of the <video> element, the scene's
// mapping comes from the program, and the lube launcher is its own device
// (src/piupiu); the engine only tracks whether A2 asks for lube, for the
// droplet on the preview.
//
// Several TCode devices (one engine per Toy Sync instance): each remembers
// its own port (portKey) and claims the port it opens. Web Serial has no
// stable per-device id (getInfo() only gives the USB vendor / product, the
// same for two identical boards), so the claim key is per SerialPort object
// in this page (portClaimKey); a remembered port matches by getInfo(), and
// auto-connect takes the first matching port that isn't open or held.
import { alreadyConnectedMessage, NO_CLAIMS, type InstanceClaims } from "../devices/claims.ts";
import type { DeviceProgram, PlaybackEvent } from "../devices/types.ts";
import {
  applyAxisCaps,
  applyChannelMap,
  AXES,
  channelsFromScript,
  clamp,
  computeTargets,
  defaultProfile,
  findConflicts,
  homeOf,
  isLevel,
  mappingFromProgram,
  num,
  tcodeCommand,
  type Axis,
  type AxisCfg,
  type Channel,
  type GenerateLevel,
  type MapEntry,
  type Profile,
} from "./core.ts";
import { generateChannels } from "./generate.ts";
import type { SerialLike, SerialPortLike } from "./serial.d.ts";

/** getInfo() of the port this plugin last opened */
export const PORT_KEY = "toysync.tcode.port";
/** TCode Player's key for the same, read once it is gone (see autoConnect) */
export const LEGACY_PORT_KEY = "tcp-port";
/** the axis whose value means "lube" (droplet on the preview) */
export const LUBE_AXIS = "A2";
export const LUBE_THRESHOLD = 0.5;
/** how often the engine checks the clock while no frames go out (missed events, seek finished) */
export const WATCH_MS = 250;

export const MSG_INSECURE = "Web Serial needs a secure page. Open Stash via HTTPS or http://localhost to connect a device.";
export const MSG_UNSUPPORTED = "This browser has no Web Serial support. Use Chrome, Edge or Opera on desktop.";
export const MSG_PORT_IN_USE = "This port is already in use by another plugin.";
export const MSG_GAVE_UP = "The device keeps rejecting data. Check its USB cable and power, then connect again.";
export const MSG_UNPLUGGED = "Device unplugged";
export const MSG_OLD_PLUGIN =
  "The TCode Player plugin is also active in this page, so Toy Sync doesn't reconnect the device on its own " +
  "(it would be driven twice). Disable TCode Player, or connect here by hand.";

export interface IntervalTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export const GLOBAL_INTERVAL_TIMERS: IntervalTimers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof globalThis.setTimeout>),
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
  clearInterval: (h) => globalThis.clearInterval(h as ReturnType<typeof globalThis.setInterval>),
};

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

/** a 3D preview (osr-emu): takes the same TCode lines as the device */
export interface Emulator {
  write(line: string): void;
  destroy?(): void;
}

export interface EngineEnv {
  /** default navigator.serial */
  serial?: SerialLike | undefined;
  /** default window.isSecureContext */
  secure?: boolean;
  /** remembers the port; default localStorage, null = don't */
  storage?: StorageLike | null;
  /** monotonic ms (performance.now) */
  now?: () => number;
  /** wall clock ms (Date.now), for the reopen budget */
  wallNow?: () => number;
  timers?: IntervalTimers;
  log?: Pick<Console, "warn" | "info">;
  /** TCode Player is active in this page (auto-connect stays off) */
  oldPluginPresent?: () => boolean;
  /** where the port is remembered; default PORT_KEY (the first instance's key) */
  portKey?: string;
  /** TCode Player's port key, read once it is gone; default LEGACY_PORT_KEY, null = never (instances after the first) */
  legacyPortKey?: string | null;
  /** which ports other instances hold (default: none) */
  claims?: InstanceClaims;
}

export type Connection = "disconnected" | "connecting" | "connected" | "error";

export interface Stats {
  fps: number;
  writeMs: number;
  maxGapMs: number;
  writeErrors: number;
  readErrors: number;
}

export interface TcodeState {
  supported: boolean;
  secure: boolean;
  status: Connection;
  error: string | null;
  /** why auto-connect stayed off (TCode Player present) */
  notice: string | null;
  deviceInfo: string | null;
  deviceLog: string[];
  outputEnabled: boolean;
  /** A2 asks for lube right now (droplet on the preview, with or without a launcher) */
  lubeActive: boolean;
  profile: Profile;
  profileLoaded: boolean;
  sceneId: string | null;
  /** the program's channels, normalized */
  scriptChannels: Channel[];
  /** scriptChannels + generated ones (mapping[i] belongs to channels[i]) */
  channels: Channel[];
  mapping: MapEntry[];
  conflicts: Record<string, true>;
  playing: boolean;
  testing: boolean;
  /** number of mounted 3D previews (they act as virtual devices) */
  previews: number;
  /** last values sent per axis (0..1), at most every 100 ms */
  live: Record<string, number>;
  /** the last second while sending */
  stats: Stats | null;
}

interface FrameStats {
  since: number;
  frames: number;
  writeMs: number;
  maxGapMs: number;
  writeErrors?: number;
  readErrors?: number;
}

const encoder = new TextEncoder();

const portKeys = new WeakMap<object, string>();
let portSeq = 0;

/**
 * The claim key of a serial port: one per SerialPort object in this page
 * (the browser hands out the same object for the same port), since Web
 * Serial has no stable id that tells two identical boards apart.
 */
export function portClaimKey(port: SerialPortLike): string {
  let key = portKeys.get(port);
  if (key === undefined) portKeys.set(port, (key = `serial-port:${++portSeq}`));
  return key;
}

export function portId(port: SerialPortLike): string {
  try {
    return JSON.stringify(port.getInfo());
  } catch {
    return "{}";
  }
}

function errText(e: unknown): string {
  return String((e && typeof e === "object" && "message" in e && (e as Error).message) || e);
}
function errName(e: unknown): string {
  return e && typeof e === "object" && "name" in e ? String((e as Error).name) : "";
}

function defaultStorage(): StorageLike | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function navigatorSerial(): SerialLike | undefined {
  const nav = globalThis.navigator as (Navigator & { serial?: SerialLike }) | undefined;
  return nav?.serial;
}

export class TcodeEngine {
  state: TcodeState;
  readonly serial: SerialLike | undefined;
  readonly storage: StorageLike | null;
  readonly timers: IntervalTimers;
  readonly log: Pick<Console, "warn" | "info">;
  readonly oldPluginPresent: () => boolean;
  readonly now: () => number;
  readonly wallNow: () => number;
  readonly portKey: string;
  readonly legacyPortKey: string | null;
  readonly claims: InstanceClaims;

  _listeners = new Set<() => void>();
  _emus = new Set<Emulator>();
  _port: SerialPortLike | null = null;
  _writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  _reader: ReadableStreamDefaultReader<string> | null = null;
  _readDone: Promise<void> | null = null;
  _writing = false;
  _writable: WritableStream<Uint8Array> | null = null;
  /** a frame is due while a write is still in flight: send it when that finishes */
  _frameWaiting = false;
  _lastSendAt = 0;
  /** smoothed time between frames that went out */
  _gapMs = 0;
  /** script clock smoothing */
  _clock: { media: number; wall: number } | null = null;
  _stats: FrameStats | null = null;
  _writeFails = 0;
  _errorsLogged: Record<string, boolean> | null = null;
  _recovering: Promise<void> | null = null;
  _reopens: number[] = [];
  _timer: unknown = null;
  _watch: unknown = null;
  _infoTimer: unknown = null;
  _last: Record<string, number> = {};
  _rampUntil = 0;
  _rampPending = false;
  _liveNotify = 0;
  _genCache: { scripts: Channel[]; key: string; result: Channel[] } | null = null;
  _program: DeviceProgram | null = null;
  _unclock: (() => void) | null = null;
  /** stopNow(): no output until playback starts again */
  _halted = false;
  _onSerialDisconnect: ((ev: { target: unknown }) => void) | null = null;

  constructor(env: EngineEnv = {}) {
    this.serial = "serial" in env ? env.serial : navigatorSerial();
    this.storage = env.storage === undefined ? defaultStorage() : env.storage;
    this.timers = env.timers ?? GLOBAL_INTERVAL_TIMERS;
    this.log = env.log ?? console;
    this.oldPluginPresent = env.oldPluginPresent ?? (() => false);
    this.now = env.now ?? (() => globalThis.performance.now());
    this.wallNow = env.wallNow ?? (() => Date.now());
    this.portKey = env.portKey ?? PORT_KEY;
    this.legacyPortKey = env.legacyPortKey === undefined ? LEGACY_PORT_KEY : env.legacyPortKey;
    this.claims = env.claims ?? NO_CLAIMS;
    const secure = env.secure ?? !!(globalThis as { isSecureContext?: boolean }).isSecureContext;
    this.state = {
      supported: !!this.serial,
      secure,
      status: "disconnected",
      error: null,
      notice: null,
      deviceInfo: null,
      deviceLog: [],
      outputEnabled: true,
      lubeActive: false,
      profile: defaultProfile(),
      profileLoaded: false,
      sceneId: null,
      scriptChannels: [],
      channels: [],
      mapping: [],
      conflicts: {},
      playing: false,
      testing: false,
      previews: 0,
      live: {},
      stats: null,
    };
    if (this.serial) {
      this._onSerialDisconnect = (ev) => {
        if (this._port && ev.target === this._port) void this._cleanup(MSG_UNPLUGGED);
      };
      this.serial.addEventListener("disconnect", this._onSerialDisconnect);
    }
  }

  subscribe(fn: () => void): () => void {
    this._listeners.add(fn);
    return () => {
      this._listeners.delete(fn);
    };
  }

  set(patch: Partial<TcodeState>): void {
    Object.assign(this.state, patch);
    for (const fn of [...this._listeners]) {
      try {
        fn();
      } catch (e) {
        this.log.warn("[toysync] tcode listener failed", e);
      }
    }
  }

  /* ---------- profile ---------- */

  /** a loaded or saved profile; applies at once (a new rate restarts the loop) */
  setProfile(profile: Profile): void {
    this.set({ profile, profileLoaded: true });
    this.recompute();
    this._restartTimerIfRunning();
  }

  /* ---------- serial ---------- */

  rememberedPort(): string | null {
    try {
      return this.storage?.getItem(this.portKey) || null;
    } catch {
      return null;
    }
  }

  /** forgets the remembered port (the instance was removed) */
  forgetPort(): void {
    try {
      this.storage?.removeItem?.(this.portKey);
    } catch {
      // nothing to forget
    }
  }

  async connect(): Promise<void> {
    if (!this.serial) {
      this.set({ status: "error", error: this.state.secure ? MSG_UNSUPPORTED : MSG_INSECURE });
      return;
    }
    try {
      const port = await this.serial.requestPort();
      await this._open(port);
    } catch (e) {
      if (errName(e) === "NotFoundError") return; // user cancelled the picker
      this.set({ status: "error", error: errText(e) });
    }
  }

  /**
   * Serial permissions are per origin, so getPorts() also lists ports other Stash plugins were granted.
   * Only reconnect to the port this plugin used last, skip ports that are already open, and back off
   * quietly if it is busy - another plugin, tab or app (e.g. Intiface) may own it. While TCode Player
   * is active in the page it stays off entirely; once TCode Player is gone, the port it remembered
   * counts as this plugin's (Toy Sync replaces it).
   */
  async autoConnect(): Promise<void> {
    if (!this.serial) return;
    if (this.oldPluginPresent()) {
      this.log.info("[toysync] TCode Player is active in this page, not auto-connecting the TCode device");
      if (this.state.status === "disconnected") this.set({ notice: MSG_OLD_PLUGIN });
      return;
    }
    try {
      let known = this.rememberedPort();
      if (!known && this.legacyPortKey) {
        try {
          known = this.storage?.getItem(this.legacyPortKey) || null;
        } catch {
          known = null;
        }
      }
      if (!known) return;
      const ports = await this.serial.getPorts();
      for (const port of ports) {
        if (this.state.status !== "disconnected" && this.state.status !== "error") return;
        if (port.readable || portId(port) !== known || this.claims.heldByOther(portClaimKey(port)) !== undefined) continue;
        if (await this._open(port, true)) return;
      }
    } catch (e) {
      this.log.warn("[toysync] TCode auto-connect failed", e);
    }
  }

  async _open(port: SerialPortLike, quiet = false, reopening = false): Promise<boolean> {
    const claimKey = portClaimKey(port);
    const other = this.claims.heldByOther(claimKey);
    if (other !== undefined) {
      // another TCode instance drives this port
      if (!quiet) this.set({ status: "error", error: alreadyConnectedMessage(other) });
      return false;
    }
    if (port.readable) {
      // opened by someone else in this page
      if (!quiet) this.set({ status: "error", error: MSG_PORT_IN_USE });
      return false;
    }
    if (!reopening) this._errorsLogged = null;
    this.set(
      reopening
        ? { status: "connecting", error: null }
        : { status: "connecting", error: null, notice: null, deviceInfo: null, deviceLog: [] },
    );
    this.claims.claim(claimKey);
    try {
      await port.open({ baudRate: this.state.profile.baud });
    } catch (e) {
      this.claims.release(claimKey);
      if (quiet) {
        this.log.info("[toysync] remembered TCode port is busy, not auto-connecting", e);
        this.set({ status: "disconnected" });
      } else {
        this.set({ status: "error", error: "Could not open port (in use by another tab or app?): " + errText(e) });
      }
      return false;
    }
    try {
      this.storage?.setItem(this.portKey, portId(port));
    } catch {
      // not remembered: auto-connect won't find it
    }
    this._port = port;
    this._writable = port.writable;
    this._writer = this._writable!.getWriter();
    this._writeFails = 0;
    this._readDone = this._readLoop(port);
    this._last = {};
    this.set({ status: "connected" });
    // ESP32/Arduino boards reset when the port opens – ask for firmware info after boot.
    this._infoTimer = this.timers.setTimeout(() => {
      this._infoTimer = null;
      this.sendRaw("D1");
    }, 2000);
    this.updateLoop();
    return true;
  }

  async _readLoop(port: SerialPortLike): Promise<void> {
    if (!port.readable) return;
    const decoder = new TextDecoderStream();
    const piped = port.readable.pipeTo(decoder.writable as unknown as WritableStream<Uint8Array>).catch(() => {});
    const reader = decoder.readable.getReader();
    this._reader = reader;
    let buf = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (line) this._onLine(line);
        }
      }
    } catch (e) {
      // reader cancelled, device lost, or a non-fatal read error (garbled or lost bytes)
      if (this._port === port && /Break|Framing|Parity|Overrun/.test(errName(e))) this._countError("read", e);
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* ignore */
      }
    }
    await piped;
    // still connected: the browser offers a fresh input stream after a non-fatal error
    if (this._port === port && port.readable) {
      await new Promise<void>((r) => this.timers.setTimeout(r, 100));
      if (this._port === port && port.readable && !port.readable.locked) this._readDone = this._readLoop(port);
    }
  }

  _onLine(line: string): void {
    const log = this.state.deviceLog.concat(line).slice(-30);
    const patch: Partial<TcodeState> = { deviceLog: log };
    if (!this.state.deviceInfo && /tcode|osr|sr6|tempest/i.test(line)) patch.deviceInfo = line;
    this.set(patch);
  }

  async disconnect(): Promise<void> {
    if (!this._port) return;
    this.home(600);
    await new Promise<void>((r) => this.timers.setTimeout(r, 650));
    await this._cleanup(null);
  }

  async _cleanup(reason: string | null): Promise<void> {
    this._stopTimer();
    if (this._infoTimer !== null) this.timers.clearTimeout(this._infoTimer);
    this._infoTimer = null;
    const port = this._port;
    this._port = null;
    try {
      if (this._reader) await this._reader.cancel();
    } catch {
      /* ignore */
    }
    try {
      if (this._readDone) await this._readDone;
    } catch {
      /* ignore */
    }
    try {
      if (this._writer) this._writer.releaseLock();
    } catch {
      /* ignore */
    }
    try {
      if (port) await port.close();
    } catch {
      /* ignore */
    }
    if (port) this.claims.release(portClaimKey(port));
    this._reader = null;
    this._writer = null;
    this._writable = null;
    this._readDone = null;
    this._writing = false;
    this.set({ status: reason ? "error" : "disconnected", error: reason, live: {} });
    this.updateLoop(); // a preview keeps following the video
  }

  /** true when something consumes TCode: a serial device and/or a 3D preview. */
  hasOutput(): boolean {
    return !!this._port || this._emus.size > 0;
  }

  addEmulator(emu: Emulator): void {
    this._emus.add(emu);
    // start the preview at the device's last known position
    const parts = Object.keys(this._last).map((a) => tcodeCommand(a, this._last[a]!, 0));
    try {
      if (parts.length) emu.write(parts.join(" ") + "\n");
    } catch {
      /* ignore */
    }
    this._rampPending = true;
    this.set({ previews: this._emus.size });
    this.updateLoop();
  }

  removeEmulator(emu: Emulator): void {
    this._emus.delete(emu);
    this.set({ previews: this._emus.size });
    this.updateLoop();
  }

  sendRaw(line: string): boolean {
    // drop the frame for everyone while the serial port is busy, so device and preview stay identical
    if (this._writer && this._writing) return false;
    this._emus.forEach((emu) => {
      try {
        emu.write(line + "\n");
      } catch {
        /* ignore */
      }
    });
    if (!this._writer) return this._emus.size > 0;
    this._writing = true;
    const started = this.now();
    this._writer
      .write(encoder.encode(line + "\n"))
      .then(() => {
        this._writeFails = 0;
        if (this._stats) this._stats.writeMs = Math.max(this._stats.writeMs, this.now() - started);
      })
      .catch((e: unknown) => this._onWriteError(e))
      .finally(() => {
        this._writing = false;
        if (this._frameWaiting) {
          this._frameWaiting = false;
          this._tick();
        }
      });
    return true;
  }

  /*
   * A failed write leaves the port's output stream broken, and every later write fails at once -
   * the device just stops. Recover instead of carrying on: take a fresh stream if the browser has
   * one, else reopen the port (most ESP32 boards restart on that), and give up with a clear error
   * if it keeps failing. An unplugged device is handled by the disconnect event instead.
   */
  _onWriteError(e: unknown): void {
    this._writeFails = (this._writeFails || 0) + 1;
    if (this._writeFails > 1 || !this._port || errName(e) === "NetworkError") return;
    this._countError("write", e);
    if (!this._recovering) {
      this._recovering = this._recoverWriter().finally(() => {
        this._recovering = null;
      });
    }
  }

  /** Log the first error of a kind per connection, count the rest for the readout. */
  _countError(kind: "read" | "write", e: unknown): void {
    const st = this._stats;
    if (st) st[`${kind}Errors`] = (st[`${kind}Errors`] || 0) + 1;
    this._errorsLogged = this._errorsLogged || {};
    if (this._errorsLogged[kind]) return;
    this._errorsLogged[kind] = true;
    this.log.warn(`[toysync] TCode ${kind} error (logged once per connection, counted in the readout)`, e);
    this._onLine(`[${kind} error: ${(e && typeof e === "object" && errName(e) + " " + (e as Error).message) || e}]`);
  }

  async _recoverWriter(): Promise<void> {
    const port = this._port;
    if (!port) return;
    try {
      this._writer?.releaseLock();
    } catch {
      /* ignore */
    }
    this._writer = null;
    const ws = port.writable;
    if (ws && ws !== this._writable && !ws.locked) {
      // only the failed frame was lost and the device kept moving: carry on without a resync ramp,
      // which would hold the output for rampMs and show as a pause
      this._writable = ws;
      this._writer = ws.getWriter();
      this._writeFails = 0;
      return;
    }
    const now = this.wallNow();
    this._reopens = this._reopens.filter((t) => now - t < 60000);
    if (this._reopens.length >= 3) {
      await this._cleanup(MSG_GAVE_UP);
      return;
    }
    this._reopens.push(now);
    await this._cleanup(null);
    await this._open(port, false, true);
  }

  /** Send absolute device positions {axis: 0..1} with an interval. */
  sendTargets(targets: Record<string, number>, intervalMs: number): boolean {
    const parts = Object.keys(targets).map((a) => tcodeCommand(a, targets[a]!, intervalMs));
    if (!parts.length) return false;
    return this.sendRaw(parts.join(" "));
  }

  /** L/R axes to the middle (through the caps), V/A axes to 0: every mapped axis plus L0. */
  home(intervalMs?: number): void {
    const targets: Record<string, number> = {};
    const p = this.state.profile;
    const axes = new Set(this.state.mapping.filter((m) => m.axis !== "off").map((m) => m.axis));
    axes.add("L0");
    axes.forEach((a) => {
      const ax = p.axes[a as Axis];
      if (ax && ax.enabled) targets[a] = homeOf(a) === 0 ? 0 : applyAxisCaps(50, ax);
    });
    this._last = Object.assign({}, this._last, targets);
    this.sendTargets(targets, intervalMs || 800);
  }

  setOutputEnabled(on: boolean): void {
    this.set({ outputEnabled: !!on });
    if (!on) this.home(600);
    this.updateLoop();
  }

  /** Output stops and the device goes home; playing again (play / seek / a new scene) resumes. */
  stopNow(): void {
    this._halted = true;
    this._stopTimer();
    if (this.hasOutput()) this.home(600);
    this.updateLoop();
  }

  /* ---------- program (scene) ---------- */

  setProgram(program: DeviceProgram | null): void {
    const prev = this._program;
    if (!program) {
      if (!prev) return;
      this._unbindClock();
      this._program = null;
      this._rampPending = true;
      this._clock = null;
      this.updateLoop();
      if (this.hasOutput()) this.home(800);
      this.set({ sceneId: null, scriptChannels: [], channels: [], mapping: [], conflicts: {} });
      return;
    }
    const newScene = !prev || prev.sceneId !== program.sceneId;
    if (!prev || prev.clock !== program.clock) {
      this._unbindClock();
      this._unclock = program.clock.onChange((e) => this._onClock(e));
      this._watch = this.timers.setInterval(() => {
        if (this._shouldRun() !== !!this._timer) this.updateLoop();
      }, WATCH_MS);
    }
    this._program = program;
    const patch: Partial<TcodeState> = { sceneId: program.sceneId };
    if (newScene || prev.channels !== program.channels) patch.scriptChannels = channelsFromScript(program.channels);
    if (newScene) {
      this._halted = false;
      this._rampPending = true;
      this._clock = null;
    }
    this.set(patch);
    this.recompute();
  }

  _unbindClock(): void {
    this._unclock?.();
    this._unclock = null;
    if (this._watch !== null) this.timers.clearInterval(this._watch);
    this._watch = null;
  }

  _onClock(e: PlaybackEvent): void {
    if (e === "pause" || e === "ended") {
      this.updateLoop();
      if (this.state.profile.homeOnPause && this.hasOutput()) this.home(800);
      return;
    }
    // play, seek, scene: resync with a ramp so the device doesn't jump
    this._halted = false;
    this._rampPending = true;
    this._clock = null;
    this.updateLoop();
  }

  /** Level for the current scene: its own choice, else the device setting. */
  generateLevel(): GenerateLevel {
    const o = this._program?.options?.generate;
    return isLevel(o) ? o : this.state.profile.generate;
  }

  _generated(): Channel[] {
    const st = this.state;
    if (!st.sceneId || !st.scriptChannels.length) return [];
    const level = this.generateLevel();
    const p = st.profile;
    const key = JSON.stringify([st.sceneId, level, p.generateVibe, p.channelMap, AXES.filter((a) => p.axes[a].enabled)]);
    const c = this._genCache;
    if (c && c.scripts === st.scriptChannels && c.key === key) return c.result;
    const result = generateChannels(st.scriptChannels, p, level, st.sceneId);
    this._genCache = { scripts: st.scriptChannels, key, result };
    return result;
  }

  recompute(): void {
    const st = this.state;
    const channels = st.scriptChannels.concat(this._generated());
    const mapping = this._program ? mappingFromProgram(channels, this._program.mapping, st.profile) : [];
    this.set({ channels, mapping, conflicts: findConflicts(mapping) });
    this.updateLoop();
  }

  /* ---------- playback ---------- */

  _shouldRun(): boolean {
    const prog = this._program;
    return !!(
      prog &&
      this.hasOutput() &&
      this.state.outputEnabled &&
      !this.state.testing &&
      !this._halted &&
      prog.clock.playing() &&
      this.state.mapping.some((m) => m.axis !== "off")
    );
  }

  updateLoop(): void {
    const run = this._shouldRun();
    if (run && !this._timer) {
      this._rampPending = true;
      this._timer = this.timers.setInterval(() => this._tick(), 1000 / this.state.profile.rateHz);
    } else if (!run && this._timer) {
      this._stopTimer();
    }
    const playing = !!(this._program && this._program.clock.playing());
    if (playing !== this.state.playing) this.set({ playing });
  }

  _stopTimer(): void {
    if (this._timer) this.timers.clearInterval(this._timer);
    this._timer = null;
    this._frameWaiting = false;
    this._stats = null;
    if (this.state.stats) this.set({ stats: null });
    this._setLube(false); // pause, seek, output off, scene left: no lube
  }

  _restartTimerIfRunning(): void {
    if (this._timer) {
      this._stopTimer();
      this.updateLoop();
    }
  }

  _setLube(on: boolean): void {
    if (on !== this.state.lubeActive) this.set({ lubeActive: on });
  }

  /**
   * Script time in ms, smoothed: extrapolated from the wall clock between reads and gently pulled
   * towards what the clock reports, so a time that advances in steps can't make it jump.
   */
  _scriptTime(program: DeviceProgram, now: number): number | undefined {
    const reported = program.clock.scriptMs();
    if (reported === undefined || !Number.isFinite(reported)) {
      this._clock = null;
      return undefined;
    }
    const rate = 1;
    const c = this._clock;
    if (c) {
      const predicted = c.media + (now - c.wall) * rate;
      if (Math.abs(predicted - reported) < 50) {
        c.media += (reported - predicted) * 0.1;
        return c.media + (now - c.wall) * rate;
      }
    }
    this._clock = { media: reported, wall: now };
    return reported;
  }

  /*
   * One output frame. Each command aims just past when the next frame should arrive (the measured
   * frame spacing plus a tenth) and uses that as its move time. Shorter, and the device arrives
   * early and stands waiting - with a fixed 17 ms it moved, stopped, moved. Much longer, and every
   * command only gets part way before the next replaces it, which flattens fast strokes. A frame
   * due while a write is still in flight waits for it instead of being dropped, and only axes that
   * changed are sent (as MultiFunPlayer does).
   */
  _tick(): void {
    const prog = this._program;
    if (!prog || !this._shouldRun()) {
      this.updateLoop();
      return;
    }
    const now = this.now();
    const p = this.state.profile;
    const dt = 1000 / p.rateHz;
    const lead = clamp(1.1 * (this._gapMs || dt), dt, 60);
    const media = this._scriptTime(prog, now);
    if (media === undefined) return;
    const t = media + num(p.offsetMs, 0) + lead;
    const targets = computeTargets(this.state.channels, this.state.mapping, p, t);
    this._setLube((targets[LUBE_AXIS] ?? 0) > LUBE_THRESHOLD);
    if (now < this._rampUntil) return; // let the device finish the resync move
    if (this._writer && this._writing) {
      this._frameWaiting = true;
      return;
    }

    let interval = lead;
    const ramp = this._rampPending;
    if (ramp) {
      interval = p.rampMs || lead;
      this._rampPending = false;
      this._rampUntil = now + interval;
    } else {
      // per-axis speed limits (percent of range per second), over the time since the last frame
      const elapsed = this._lastSendAt ? now - this._lastSendAt : dt;
      for (const a of Object.keys(targets)) {
        const sp = num(p.axes[a as Axis].speed, 0);
        if (sp > 0 && this._last[a] != null) {
          const maxStep = (sp / 100) * (elapsed / 1000);
          targets[a] = clamp(targets[a]!, this._last[a]! - maxStep, this._last[a]! + maxStep);
        }
      }
      // only what changed (TCode resolves 1/9999)
      for (const a of Object.keys(targets)) {
        if (this._last[a] != null && Math.abs(targets[a]! - this._last[a]!) < 0.5 / 9999) delete targets[a];
      }
    }

    if (!Object.keys(targets).length) return;
    if (this.sendTargets(targets, interval)) {
      Object.assign(this._last, targets);
      this._countFrame(now, ramp);
      if (now - this._liveNotify > 100) {
        this._liveNotify = now;
        this.set({ live: Object.assign({}, this._last) });
      }
    }
  }

  /** Frame spacing for the look-ahead, and a once-a-second readout of how sending goes. */
  _countFrame(now: number, ramp: boolean): void {
    if (this._lastSendAt && !ramp) {
      const gap = now - this._lastSendAt;
      if (gap < 500) this._gapMs = this._gapMs ? this._gapMs * 0.9 + gap * 0.1 : gap;
      if (this._stats) this._stats.maxGapMs = Math.max(this._stats.maxGapMs, gap);
    }
    this._lastSendAt = ramp ? 0 : now; // the pause after a ramp is not frame spacing
    const st = this._stats || (this._stats = { since: now, frames: 0, writeMs: 0, maxGapMs: 0 });
    st.frames++;
    if (now - st.since >= 1000) {
      this.set({
        stats: {
          fps: Math.round((st.frames * 1000) / (now - st.since)),
          writeMs: Math.round(st.writeMs),
          maxGapMs: Math.round(st.maxGapMs),
          writeErrors: st.writeErrors || 0,
          readErrors: st.readErrors || 0,
        },
      });
      this._stats = { since: now, frames: 0, writeMs: 0, maxGapMs: 0 };
    }
  }

  /* ---------- tests ---------- */

  /** Sweep one axis through [lo, hi] (device values 0..1) to identify direction & limits. */
  async test(axis: string, lowHigh: [number, number]): Promise<void> {
    if (!this.hasOutput() || this.state.testing) return;
    const ax = this.state.profile.axes[axis as Axis];
    if (!ax) return;
    this.set({ testing: true });
    this.updateLoop();
    const [lo, hi] = lowHigh;
    const home = homeOf(axis) === 0 ? 0 : (lo + hi) / 2;
    const seq: [number, number][] = [[lo, 700], [hi, 900], [lo, 900], [home, 700]];
    const sleep = (ms: number) => new Promise<void>((r) => this.timers.setTimeout(r, ms));
    for (const [x, ms] of seq) {
      // wait for any in-flight write, then send
      for (let i = 0; i < 20 && this._writing; i++) await sleep(10);
      this.sendTargets({ [axis]: x }, ms);
      this._last[axis] = x;
      if (axis === LUBE_AXIS) this._setLube(x > LUBE_THRESHOLD);
      await sleep(ms + 50);
    }
    if (axis === LUBE_AXIS) this._setLube(false);
    this._rampPending = true;
    this.set({ testing: false });
    this.updateLoop();
  }

  /** Sweep a channel's axis through its mapped range (channel id or name). */
  testChannel(channelId: string): Promise<void> {
    const i = this.state.channels.findIndex((c) => c.id === channelId || c.name === channelId);
    const entry = i >= 0 ? this.state.mapping[i] : undefined;
    if (!entry || entry.axis === "off") return Promise.resolve();
    const ax = this.state.profile.axes[entry.axis as Axis];
    if (!ax) return Promise.resolve();
    const inv = this.state.channels[i]!.inverted;
    const lo = applyAxisCaps(applyChannelMap(0, entry, inv), ax);
    const hi = applyAxisCaps(applyChannelMap(100, entry, inv), ax);
    return this.test(entry.axis, [lo, hi]);
  }

  /** Sweep an axis through (possibly unsaved) caps from the settings panel. */
  testAxisCfg(axis: string, axCfg: AxisCfg): Promise<void> {
    return this.test(axis, [applyAxisCaps(0, axCfg), applyAxisCaps(100, axCfg)]);
  }

  dispose(): void {
    if (this._port) this.claims.release(portClaimKey(this._port));
    this._unbindClock();
    this._stopTimer();
    if (this.serial && this._onSerialDisconnect) this.serial.removeEventListener?.("disconnect", this._onSerialDisconnect);
    this._listeners.clear();
  }
}
