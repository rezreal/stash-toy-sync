// DG-LAB Coyote 3.0 ("47L121000") wire format. Pure.
//
// Service 0x180c: write characteristic 0x150a (write without response
// only) takes B0 and BF packets, notify characteristic 0x150b answers with
// B1 (strength feedback) and BE (soft limits echo). Battery: service 0x180a,
// characteristic 0x1500, one byte 0..100.
//
// B0 (20 bytes), one every 100 ms:
//   [0xB0, seq << 4 | modeA << 2 | modeB, strengthA, strengthB,
//    4 × frequency A, 4 × intensity A, 4 × frequency B, 4 × intensity B]
// Strength 0..200; mode 0b00 keep, 0b01 up, 0b10 down, 0b11 absolute. The
// four frequency/intensity pairs per channel are 25 ms each. A channel with
// any out-of-range byte is dropped by the device, so everything is clamped.
//
// BF (7 bytes): [0xBF, limitA, limitB, freqBalanceA, freqBalanceB,
// intensityBalanceA, intensityBalanceB]; persists on the device.

const sig = (short: string) => `0000${short}-0000-1000-8000-00805f9b34fb`;

export const V3_SERVICE = sig("180c");
export const V3_WRITE = sig("150a");
export const V3_NOTIFY = sig("150b");
export const V3_BATTERY_SERVICE = sig("180a");
export const V3_BATTERY = sig("1500");

export const V3_NAME_PREFIX = "47L12";
/** the name suffix of a Coyote 3.0 in firmware update (DFU) mode */
export const V3_DFU_SUFFIX = "_O3";

export const STRENGTH_MAX = 200;
export const FREQ_MIN = 10;
export const FREQ_MAX = 240;
export const INTENSITY_MAX = 100;
export const SLOTS = 4;

export const MODE_KEEP = 0b00;
export const MODE_UP = 0b01;
export const MODE_DOWN = 0b10;
export const MODE_ABSOLUTE = 0b11;

export const FREQ_BALANCE = 160;
export const INTENSITY_BALANCE = 0;

const clampInt = (v: number, lo: number, hi: number): number => {
  if (!Number.isFinite(v)) return lo;
  const r = Math.round(v);
  return r < lo ? lo : r > hi ? hi : r;
};

/**
 * The frequency byte for a pulse period in ms, by the doc's formula:
 * 10..100 → period; 101..600 → (period − 100) / 5 + 100;
 * 601..1000 → (period − 600) / 10 + 200 (integer division), always 10..240.
 */
export function frequencyByte(periodMs: number): number {
  const p = clampInt(periodMs, 10, 1000);
  let f: number;
  if (p <= 100) f = p;
  else if (p <= 600) f = Math.floor((p - 100) / 5) + 100;
  else f = Math.floor((p - 600) / 10) + 200;
  return clampInt(f, FREQ_MIN, FREQ_MAX);
}

/** the period in ms for a pulse frequency in Hz */
export function periodForHz(hz: number): number {
  if (!(hz > 0) || !Number.isFinite(hz)) return 1000;
  return Math.round(1000 / hz);
}

/** 4 × 25 ms of one channel */
export interface V3Wave {
  freq: readonly number[];
  intensity: readonly number[];
}

/** a valid frame with no output */
export const SILENT_V3_WAVE: V3Wave = { freq: [10, 10, 10, 10], intensity: [0, 0, 0, 0] };

export interface B0 {
  seq: number;
  modeA: number;
  modeB: number;
  strengthA: number;
  strengthB: number;
  a: V3Wave;
  b: V3Wave;
}

function wave(out: number[], w: V3Wave): void {
  for (let i = 0; i < SLOTS; i++) out.push(clampInt(w.freq[i] ?? FREQ_MIN, FREQ_MIN, FREQ_MAX));
  for (let i = 0; i < SLOTS; i++) out.push(clampInt(w.intensity[i] ?? 0, 0, INTENSITY_MAX));
}

/** the 20-byte B0 packet; every field clamped to its valid range */
export function encodeB0(p: B0): Uint8Array<ArrayBuffer> {
  const seq = clampInt(p.seq, 0, 15);
  const ma = clampInt(p.modeA, 0, 3);
  const mb = clampInt(p.modeB, 0, 3);
  const out = [0xb0, (seq << 4) | (ma << 2) | mb, clampInt(p.strengthA, 0, STRENGTH_MAX), clampInt(p.strengthB, 0, STRENGTH_MAX)];
  wave(out, p.a);
  wave(out, p.b);
  return new Uint8Array(out);
}

export function decodeB0(bytes: ArrayLike<number>): B0 | undefined {
  if (bytes.length !== 20 || bytes[0] !== 0xb0) return undefined;
  const b = Array.from(bytes);
  return {
    seq: b[1]! >> 4,
    modeA: (b[1]! >> 2) & 3,
    modeB: b[1]! & 3,
    strengthA: b[2]!,
    strengthB: b[3]!,
    a: { freq: b.slice(4, 8), intensity: b.slice(8, 12) },
    b: { freq: b.slice(12, 16), intensity: b.slice(16, 20) },
  };
}

/** the 7-byte BF packet (soft limits 0..200, balances 0..255) */
export function encodeBF(limitA: number, limitB: number, freqBalance = FREQ_BALANCE, intensityBalance = INTENSITY_BALANCE): Uint8Array<ArrayBuffer> {
  const fb = clampInt(freqBalance, 0, 255);
  const ib = clampInt(intensityBalance, 0, 255);
  return new Uint8Array([0xbf, clampInt(limitA, 0, STRENGTH_MAX), clampInt(limitB, 0, STRENGTH_MAX), fb, fb, ib, ib]);
}

export type V3Notify =
  | { type: "b1"; seq: number; a: number; b: number }
  | { type: "be"; limitA: number; limitB: number; freqBalanceA: number; freqBalanceB: number; intensityBalanceA: number; intensityBalanceB: number }
  | { type: "unknown"; header: number };

/** a notification from 0x150b; bytes read unsigned */
export function parseNotify(bytes: ArrayLike<number>): V3Notify | undefined {
  if (bytes.length < 1) return undefined;
  const u = (i: number) => (bytes[i] ?? 0) & 0xff;
  const header = u(0);
  if (header === 0xb1 && bytes.length >= 4) return { type: "b1", seq: u(1), a: u(2), b: u(3) };
  if (header === 0xbe && bytes.length >= 7) {
    return { type: "be", limitA: u(1), limitB: u(2), freqBalanceA: u(3), freqBalanceB: u(4), intensityBalanceA: u(5), intensityBalanceB: u(6) };
  }
  return { type: "unknown", header };
}

/** battery percent from 0x1500 */
export function parseBattery(bytes: ArrayLike<number>): number | undefined {
  if (bytes.length < 1) return undefined;
  const v = (bytes[0] ?? 0) & 0xff;
  return v > 100 ? 100 : v;
}

/** the device advertises its firmware-update name */
export function isDfuName(name: string | null | undefined): boolean {
  return !!name && name.toUpperCase().endsWith(V3_DFU_SUFFIX);
}
