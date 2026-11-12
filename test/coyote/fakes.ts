// Fake Coyote 2.0 / 3.0 devices on top of the Web Bluetooth fakes
// (test/fakes/bluetooth.ts): binary characteristics that can be read and
// notify bytes, a shared counter that proves GATT operations never overlap,
// and devices that answer like the real ones (B1 acks, BE echo, strength
// notifications).
import { decodeB0, V3_BATTERY, V3_BATTERY_SERVICE, V3_NOTIFY, V3_SERVICE, V3_WRITE, type B0 } from "../../src/coyote/protocol-v3.ts";
import {
  decodeStrength,
  decodeWave,
  encodeStrength,
  V2_BATTERY,
  V2_BATTERY_SERVICE,
  V2_CONFIG,
  V2_SERVICE,
  V2_STRENGTH,
  V2_WAVE_A,
  V2_WAVE_B,
  type V2Wave,
} from "../../src/coyote/protocol-v2.ts";
import type { Calibration } from "../../src/devices/types.ts";
import type { BluetoothCharacteristicProperties } from "../../src/lovense/bluetooth.d.ts";
import { domError, FakeCharacteristic, FakeDevice, FakeService, props } from "../fakes/bluetooth.ts";

/** a valid calibration: A 20/60/80/100, B 10/50/70/90 */
export const CAL: Calibration = {
  a: { firstFelt: 20, comfortMax: 60, nudge: 80, hardMax: 100 },
  b: { firstFelt: 10, comfortMax: 50, nudge: 70, hardMax: 90 },
  updatedAt: "2026-11-01T00:00:00Z",
};

/** counts GATT operations in flight across all characteristics of a device */
export class GattCounter {
  inFlight = 0;
  max = 0;
  /** the characteristic of every operation, in start order */
  log: string[] = [];
  enter(what = ""): void {
    this.log.push(what);
    this.inFlight++;
    this.max = Math.max(this.max, this.inFlight);
  }
  leave(): void {
    this.inFlight--;
  }
}

export const bytesOfCmd = (cmd: string): number[] => [...cmd].map((c) => c.charCodeAt(0));

export class BinCharacteristic extends FakeCharacteristic {
  /** what readValue() returns; undefined = reading fails */
  readBytes: number[] | undefined;
  reads = 0;
  readonly counter: GattCounter | undefined;
  constructor(uuid: string, p: BluetoothCharacteristicProperties, counter?: GattCounter) {
    super(uuid, p);
    this.counter = counter;
    if (counter) {
      const wrap = (fn: (b: BufferSource) => Promise<void>) => async (b: BufferSource) => {
        counter.enter(this.uuid);
        try {
          await fn(b);
        } finally {
          counter.leave();
        }
      };
      this.writeValueWithoutResponse = wrap(this.writeValueWithoutResponse);
      this.writeValueWithResponse = wrap(this.writeValueWithResponse);
      this.writeValue = wrap(this.writeValue);
    }
  }
  async readValue(): Promise<DataView> {
    this.counter?.enter(`read:${this.uuid}`);
    try {
      await Promise.resolve();
      this.reads++;
      if (!this.readBytes) throw domError("NotSupportedError", "GATT operation not permitted.");
      const dv = new DataView(new Uint8Array(this.readBytes).buffer);
      this.value = dv;
      return dv;
    } finally {
      this.counter?.leave();
    }
  }
  /** every write as bytes */
  packets(): number[][] {
    return this.writes.map((w) => bytesOfCmd(w.cmd));
  }
  notifyBytes(bytes: number[]): void {
    this.value = new DataView(new Uint8Array(bytes).buffer);
    this.dispatch("characteristicvaluechanged");
  }
}

// --- Coyote 3.0 -------------------------------------------------------------------------

export interface FakeCoyote3Options {
  id?: string;
  name?: string | null;
  battery?: number;
  /** answer B0 packets with a seq with B1 (default true) */
  ack?: boolean;
  /** leave out the pulse service (e.g. update mode) */
  noPulseService?: boolean;
}

export function fakeCoyote3(opts: FakeCoyote3Options = {}) {
  const counter = new GattCounter();
  const tx = new BinCharacteristic(V3_WRITE, props({ writeWithoutResponse: true }), counter);
  const rx = new BinCharacteristic(V3_NOTIFY, props({ notify: true }), counter);
  const bat = new BinCharacteristic(V3_BATTERY, props({ read: true, notify: true }), counter);
  bat.readBytes = [opts.battery ?? 77];
  const services = [new FakeService(V3_BATTERY_SERVICE, [bat])];
  if (!opts.noPulseService) services.unshift(new FakeService(V3_SERVICE, [tx, rx]));
  const dev = new FakeDevice(opts.id ?? "c3", opts.name === undefined ? "47L121000" : opts.name, services);
  const state = { a: 0, b: 0, limitA: 200, limitB: 200, ack: opts.ack ?? true };
  const apply = (mode: number, value: number, cur: number, limit: number) => {
    const v = mode === 3 ? value : mode === 1 ? cur + value : mode === 2 ? cur - value : cur;
    return Math.max(0, Math.min(limit, v));
  };
  tx.onWrite = (cmd) => {
    const b = bytesOfCmd(cmd);
    if (b[0] === 0xbf) {
      state.limitA = b[1]!;
      state.limitB = b[2]!;
      queueMicrotask(() => rx.notifying && rx.notifyBytes([0xbe, ...b.slice(1)]));
      return;
    }
    const p = decodeB0(b);
    if (!p) return;
    state.a = apply(p.modeA, p.strengthA, state.a, state.limitA);
    state.b = apply(p.modeB, p.strengthB, state.b, state.limitB);
    if (p.seq !== 0 && state.ack) {
      const reply = [0xb1, p.seq, state.a, state.b];
      queueMicrotask(() => rx.notifying && rx.notifyBytes(reply));
    }
  };
  return {
    dev,
    tx,
    rx,
    bat,
    counter,
    state,
    /** every B0 written, decoded, with its time */
    b0s(): (B0 & { t: number })[] {
      return tx.writes
        .map((w) => ({ p: decodeB0(bytesOfCmd(w.cmd)), t: w.t ?? 0 }))
        .filter((x): x is { p: B0; t: number } => x.p !== undefined)
        .map((x) => ({ ...x.p, t: x.t }));
    },
    /** every BF written */
    bfs(): number[][] {
      return tx.packets().filter((p) => p[0] === 0xbf);
    },
    /** the user turns the wheels: the device reports seq 0 */
    wheel(a: number, b: number): void {
      state.a = a;
      state.b = b;
      rx.notifyBytes([0xb1, 0, a, b]);
    },
  };
}

// --- Coyote 2.0 -------------------------------------------------------------------------

export interface FakeCoyote2Options {
  id?: string;
  name?: string;
  battery?: number;
  /** what 1507 reads; undefined = reading fails */
  config?: number[];
  /** notify the strength back after each strength write (default true) */
  echo?: boolean;
}

export function fakeCoyote2(opts: FakeCoyote2Options = {}) {
  const counter = new GattCounter();
  const rw = { read: true, write: true, writeWithoutResponse: true };
  const strength = new BinCharacteristic(V2_STRENGTH, props({ ...rw, notify: true }), counter);
  const waveA = new BinCharacteristic(V2_WAVE_A, props(rw), counter);
  const waveB = new BinCharacteristic(V2_WAVE_B, props(rw), counter);
  const config = new BinCharacteristic(V2_CONFIG, props({ read: true }), counter);
  if (opts.config) config.readBytes = opts.config;
  const bat = new BinCharacteristic(V2_BATTERY, props({ read: true, notify: true }), counter);
  bat.readBytes = [opts.battery ?? 64];
  const dev = new FakeDevice(opts.id ?? "c2", opts.name ?? "D-LAB ESTIM01", [
    new FakeService(V2_SERVICE, [strength, waveB, waveA, config]),
    new FakeService(V2_BATTERY_SERVICE, [bat]),
  ]);
  const state = { a: 0, b: 0, echo: opts.echo ?? true };
  strength.onWrite = (cmd) => {
    const s = decodeStrength(bytesOfCmd(cmd));
    if (!s) return;
    state.a = s.a;
    state.b = s.b;
    const bytes = bytesOfCmd(cmd);
    if (state.echo) queueMicrotask(() => strength.notifying && strength.notifyBytes(bytes));
  };
  return {
    dev,
    strength,
    waveA,
    waveB,
    config,
    bat,
    counter,
    state,
    strengths(): { a: number; b: number; t: number }[] {
      return strength.writes.map((w) => ({ ...decodeStrength(bytesOfCmd(w.cmd))!, t: w.t ?? 0 }));
    },
    waves(ch: "a" | "b"): (V2Wave & { t: number })[] {
      return (ch === "a" ? waveA : waveB).writes.map((w) => ({ ...decodeWave(bytesOfCmd(w.cmd)), t: w.t ?? 0 }));
    },
    /** the user turns the wheels */
    wheel(a: number, b: number): void {
      state.a = a;
      state.b = b;
      strength.notifyBytes(Array.from(encodeStrength(a, b)));
    },
  };
}
