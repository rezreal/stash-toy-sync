// DG-LAB Coyote 2.0 ("D-LAB ESTIM01") wire format. Pure.
//
// Service 955a180b-…: strength (1504, read/write/notify), channel B
// waveform (1505), channel A waveform (1506; the official doc's PWM_A34 /
// PWM_B34 names suggest the opposite, every working implementation uses
// 1506 = A), an undocumented config characteristic (1507). Battery level
// lives in its own service 955a180a-… (1500, one byte 0..100).
//
// Strength: 3 bytes little-endian of (A << 11) | B, raw 0..2047 per channel;
// the device keeps it until it is changed. The rest of the plugin uses the
// same level range 0..200 as the Coyote 3.0; raw = round(level / 200 ×
// maxPower), with maxPower read from 1507 when plausible, else 1400 (= the
// level × 7 the DG-LAB app and Howl use).
//
// Waveform: 3 bytes little-endian of (Z << 15) | (Y << 5) | X: X pulses of
// 1 ms (0..31), then Y ms idle (0..1023), Z = pulse width × 5 µs (0..31;
// above 20 stings). One write is good for 100 ms.

const v2uuid = (short: string) => `955a${short}-0fe2-f5aa-a094-84b8d4f3e8ad`;

export const V2_SERVICE = v2uuid("180b");
export const V2_BATTERY_SERVICE = v2uuid("180a");
export const V2_BATTERY = v2uuid("1500");
export const V2_STRENGTH = v2uuid("1504");
export const V2_WAVE_B = v2uuid("1505");
export const V2_WAVE_A = v2uuid("1506");
export const V2_CONFIG = v2uuid("1507");

export const V2_NAME_PREFIX = "D-LAB";

/** the level range the plugin uses for both Coyote versions */
export const LEVEL_MAX = 200;
/** the 11-bit raw strength ceiling */
export const RAW_MAX = 2047;
/** maxPower when 1507 can't be read: level × 7, like the DG-LAB app */
export const DEFAULT_MAX_POWER = 1400;

/** pulse width for the feel-good waveform (60 µs) */
export const Z_SOFT = 12;
/** pulse width for nudges (100 µs) */
export const Z_SHARP = 20;

export const PERIOD_MIN_MS = 10;
export const PERIOD_MAX_MS = 1000;

const clampInt = (v: number, lo: number, hi: number): number => {
  if (!Number.isFinite(v)) return lo;
  const r = Math.round(v);
  return r < lo ? lo : r > hi ? hi : r;
};

/** the channel's waveform characteristic */
export function waveCharacteristic(channel: "a" | "b"): string {
  return channel === "a" ? V2_WAVE_A : V2_WAVE_B;
}

/** a 24-bit value as 3 bytes, least significant first */
export function le24(v: number): Uint8Array<ArrayBuffer> {
  const n = v >>> 0;
  return new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff]);
}

/** reads 3 bytes little-endian (missing bytes count as 0) */
export function readLe24(bytes: ArrayLike<number>): number {
  return ((bytes[0] ?? 0) & 0xff) | (((bytes[1] ?? 0) & 0xff) << 8) | (((bytes[2] ?? 0) & 0xff) << 16);
}

/** the strength packet for raw strengths (each clamped to 0..2047) */
export function encodeStrength(rawA: number, rawB: number): Uint8Array<ArrayBuffer> {
  const a = clampInt(rawA, 0, RAW_MAX);
  const b = clampInt(rawB, 0, RAW_MAX);
  return le24(a * 2048 + b);
}

export function decodeStrength(bytes: ArrayLike<number>): { a: number; b: number } | undefined {
  if (bytes.length < 3) return undefined;
  const v = readLe24(bytes);
  return { a: (v >>> 11) & 0x7ff, b: v & 0x7ff };
}

export interface V2Wave {
  x: number;
  y: number;
  z: number;
}

/** the waveform packet (each field clamped to its range) */
export function encodeWave(w: V2Wave): Uint8Array<ArrayBuffer> {
  const x = clampInt(w.x, 0, 31);
  const y = clampInt(w.y, 0, 1023);
  const z = clampInt(w.z, 0, 31);
  return le24(z * 32768 + y * 32 + x);
}

export function decodeWave(bytes: ArrayLike<number>): V2Wave {
  const v = readLe24(bytes);
  return { x: v & 0x1f, y: (v >>> 5) & 0x3ff, z: (v >>> 15) & 0x1f };
}

/**
 * X and Y for a pulse period in ms (clamped to 10..1000): the doc's
 * X = round(sqrt(period / 1000) × 15) (1..31), Y = period − X.
 */
export function waveForPeriod(periodMs: number, z: number): V2Wave {
  const period = clampInt(periodMs, PERIOD_MIN_MS, PERIOD_MAX_MS);
  const x = clampInt(Math.sqrt(period / 1000) * 15, 1, 31);
  return { x, y: period - x, z: clampInt(z, 0, 31) };
}

/** a valid 100 ms period with zero pulse width: no output */
export const SILENT_WAVE: V2Wave = { x: 1, y: 99, z: 0 };

/**
 * maxPower from the 1507 config bytes (byte 0 = power step, bytes 1–2 =
 * max power, 11 bits); the default when unreadable or implausible (< 200).
 */
export function parseMaxPower(bytes: ArrayLike<number> | undefined): number {
  if (!bytes || bytes.length < 3) return DEFAULT_MAX_POWER;
  const max = (((bytes[1] ?? 0) & 0xff) | (((bytes[2] ?? 0) & 0xff) << 8)) & 0x7ff;
  return max >= LEVEL_MAX ? max : DEFAULT_MAX_POWER;
}

/** raw strength for a level 0..200: round(level / 200 × maxPower), never above 2047 */
export function levelToRaw(level: number, maxPower: number): number {
  const l = clampInt(level, 0, LEVEL_MAX);
  const max = clampInt(maxPower, 0, RAW_MAX);
  return Math.min(RAW_MAX, Math.round((l / LEVEL_MAX) * max));
}

/** the highest level whose raw strength is at most `raw` */
export function rawToLevelFloor(raw: number, maxPower: number): number {
  if (!(maxPower > 0)) return 0;
  let l = clampInt(Math.floor((raw / maxPower) * LEVEL_MAX), 0, LEVEL_MAX);
  while (l > 0 && levelToRaw(l, maxPower) > raw) l--;
  while (l < LEVEL_MAX && levelToRaw(l + 1, maxPower) <= raw) l++;
  return l;
}

/** battery percent from the battery characteristic */
export function parseBattery(bytes: ArrayLike<number>): number | undefined {
  if (bytes.length < 1) return undefined;
  const v = (bytes[0] ?? 0) & 0xff;
  return v > 100 ? 100 : v;
}
