// Calibration helpers for e-stim style devices: validation, the
// intensity -> raw level mapping, and storage in localStorage (per device
// kind and physical device id). Pure apart from the injectable storage.
//
// A channel's calibration is four raw device levels:
//   firstFelt < comfortMax < nudge <= hardMax
// Script output lives in [firstFelt, comfortMax]; a nudge goes to `nudge`;
// nothing, ever, goes above hardMax.
import type { Calibration, CalibratableDevice, ChannelCalibration, DeviceKind, ToyDevice } from "./types.ts";

export interface LevelRange {
  min: number;
  max: number;
}

const CHANNEL_FIELDS = ["firstFelt", "comfortMax", "nudge", "hardMax"] as const;

const FIELD_LABELS: Record<(typeof CHANNEL_FIELDS)[number], string> = {
  firstFelt: "First felt",
  comfortMax: "Comfort max",
  nudge: "Nudge",
  hardMax: "Hard max",
};

/** problems with one channel ("" prefix for a single-channel message) */
export function validateChannel(ch: ChannelCalibration | undefined, range: LevelRange, label = ""): string[] {
  const p = label ? `${label}: ` : "";
  if (!ch || typeof ch !== "object") return [`${p}not calibrated.`];
  const out: string[] = [];
  for (const f of CHANNEL_FIELDS) {
    const v = ch[f];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      out.push(`${p}${FIELD_LABELS[f]} is missing.`);
      continue;
    }
    if (v < range.min || v > range.max) out.push(`${p}${FIELD_LABELS[f]} (${v}) is outside the device range ${range.min}–${range.max}.`);
  }
  if (out.length > 0) return out;
  if (!(ch.firstFelt < ch.comfortMax)) out.push(`${p}Comfort max (${ch.comfortMax}) must be above First felt (${ch.firstFelt}).`);
  if (!(ch.comfortMax < ch.nudge)) out.push(`${p}Nudge (${ch.nudge}) must be above Comfort max (${ch.comfortMax}).`);
  if (!(ch.nudge <= ch.hardMax)) out.push(`${p}Hard max (${ch.hardMax}) must be at least Nudge (${ch.nudge}).`);
  return out;
}

/**
 * Problems with a calibration (empty = valid): channel A is required, B
 * optional; every level within `range`, and
 * firstFelt < comfortMax < nudge <= hardMax on each channel.
 */
export function validateCalibration(c: Calibration | undefined, range: LevelRange): string[] {
  if (!c || typeof c !== "object") return ["Not calibrated."];
  const out = validateChannel(c.a, range, "Channel A");
  if (c.b !== undefined) out.push(...validateChannel(c.b, range, "Channel B"));
  return out;
}

/** intensities at or below this are silence */
export const SILENT_INTENSITY = 0.005;

/**
 * The raw level for an intensity 0..1 on a calibrated channel: 0 when the
 * intensity is <= 0.005 (or not a number), else
 * firstFelt + intensity × (comfortMax − firstFelt), rounded and clamped to
 * at most hardMax (and at least 0).
 */
export function levelFor(intensity01: number, ch: ChannelCalibration): number {
  if (!Number.isFinite(intensity01) || intensity01 <= SILENT_INTENSITY) return 0;
  const i = intensity01 > 1 ? 1 : intensity01;
  const raw = Math.round(ch.firstFelt + i * (ch.comfortMax - ch.firstFelt));
  return Math.max(0, Math.min(ch.hardMax, raw));
}

// --- storage --------------------------------------------------------------------------

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function calibrationKey(kind: DeviceKind, id: string): string {
  return `toysync.calibration.${kind}.${id}`;
}

function defaultStorage(): StorageLike | undefined {
  try {
    return globalThis.localStorage ?? undefined;
  } catch {
    return undefined;
  }
}

function isChannel(v: unknown): v is ChannelCalibration {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return CHANNEL_FIELDS.every((f) => typeof o[f] === "number" && Number.isFinite(o[f]));
}

/** the stored calibration, undefined when none, unreadable or malformed */
export function loadCalibration(kind: DeviceKind, id: string, storage: StorageLike | undefined = defaultStorage()): Calibration | undefined {
  try {
    const raw = storage?.getItem(calibrationKey(kind, id));
    if (!raw) return undefined;
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (!v || typeof v !== "object" || !isChannel(v.a)) return undefined;
    if (v.b !== undefined && !isChannel(v.b)) return undefined;
    const out: Calibration = { a: pick(v.a), updatedAt: typeof v.updatedAt === "string" ? v.updatedAt : "" };
    if (v.b !== undefined) out.b = pick(v.b as ChannelCalibration);
    return out;
  } catch {
    return undefined;
  }
}

function pick(ch: ChannelCalibration): ChannelCalibration {
  return { firstFelt: ch.firstFelt, comfortMax: ch.comfortMax, nudge: ch.nudge, hardMax: ch.hardMax };
}

/** stores (or with undefined removes) a calibration; false when storage failed */
export function saveCalibration(
  kind: DeviceKind,
  id: string,
  c: Calibration | undefined,
  storage: StorageLike | undefined = defaultStorage(),
): boolean {
  try {
    if (!storage) return false;
    if (c === undefined) storage.removeItem(calibrationKey(kind, id));
    else storage.setItem(calibrationKey(kind, id), JSON.stringify(c));
    return true;
  } catch {
    return false;
  }
}

/** the device also offers the calibration page's interface */
export function isCalibratable(d: ToyDevice | undefined): d is CalibratableDevice {
  if (!d) return false;
  const c = d as Partial<CalibratableDevice>;
  return (
    Array.isArray(c.channels) &&
    typeof c.calibration === "function" &&
    typeof c.setCalibration === "function" &&
    typeof c.probe === "function" &&
    typeof c.levelRange === "function"
  );
}
