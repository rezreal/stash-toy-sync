// The per-scene mapping stored in the scene custom field `toysync_map`, and
// the one-way migration from TCode Player's `tcode_map`. Pure.
//
//   { "v": 1, "offsetMs": 40,
//     "devices": {
//       "coyote-v3": { "mapping": { "stroke": { "target": "auto" }, "e1": { "target": "a", "max": 80 } } },
//       "tcode":     { "mapping": { "pitch": { "target": "R2", "invert": true, "min": 20, "max": 80 } },
//                      "options": { "generate": "gentle" } } } }
//
// A device's mapping holds overrides per script channel: a channel listed
// there uses that entry (missing fields come from the device's default for
// the channel; no target at all = the default target, "off" switches it
// off), every other channel keeps the default (src/mapping/effective.ts).
//
// Reading: `toysync_map` when present; else `tcode_map` (TCode Player) is
// migrated in memory: its per-channel { axis, invert, min, max } diffs become
// devices.tcode.mapping (axis -> target), offsetMs -> offsetMs, generate ->
// devices.tcode.options.generate; the legacy { files: { <fileKey>: … } }
// form picks the entry of the scene's first file, else the first entry.
// tcode_map is never written or removed.
import type { ChannelMapping } from "../devices/types.ts";

export const SCENE_FIELD = "toysync_map";
export const TCODE_FIELD = "tcode_map";
export const SCENE_MAP_VERSION = 1;
/** offsets beyond this are surely a typo */
export const MAX_OFFSET_MS = 60_000;

/** a stored channel entry: every field optional (missing ones come from the default) */
export type ChannelOverride = Partial<ChannelMapping>;

export interface DeviceSceneMap {
  mapping: Record<string, ChannelOverride>;
  options?: Record<string, unknown>;
}

export interface SceneMap {
  v: 1;
  offsetMs: number;
  devices: Record<string, DeviceSceneMap>;
}

/** where a scene's map came from */
export type SceneMapSource = "toysync" | "tcode" | "none";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function num(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export function emptySceneMap(): SceneMap {
  return { v: SCENE_MAP_VERSION, offsetMs: 0, devices: {} };
}

function readJson(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  if (raw.trim() === "") return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** one channel entry, leniently: unknown fields dropped, min / max clamped to 0..100; undefined when nothing usable */
export function parseChannelOverride(raw: unknown): ChannelOverride | undefined {
  if (!isObj(raw)) return undefined;
  const out: ChannelOverride = {};
  if (typeof raw.target === "string" && raw.target.trim() !== "") out.target = raw.target.trim();
  if (typeof raw.invert === "boolean") out.invert = raw.invert;
  else if (raw.invert === "true") out.invert = true;
  else if (raw.invert === "false") out.invert = false;
  const min = num(raw.min);
  const max = num(raw.max);
  if (min !== undefined) out.min = clamp(min, 0, 100);
  if (max !== undefined) out.max = clamp(max, 0, 100);
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseDevice(raw: unknown): DeviceSceneMap | undefined {
  if (!isObj(raw)) return undefined;
  const mapping: Record<string, ChannelOverride> = {};
  if (isObj(raw.mapping)) {
    for (const [ch, entry] of Object.entries(raw.mapping)) {
      const id = ch.trim().toLowerCase();
      const m = parseChannelOverride(entry);
      if (id && m) mapping[id] = m;
    }
  }
  const out: DeviceSceneMap = { mapping };
  if (isObj(raw.options) && Object.keys(raw.options).length > 0) out.options = { ...raw.options };
  if (Object.keys(mapping).length === 0 && !out.options) return undefined;
  return out;
}

/** a `toysync_map` value (JSON string or object); undefined when absent or not an object */
export function parseSceneMap(raw: unknown): SceneMap | undefined {
  const o = readJson(raw);
  if (!isObj(o)) return undefined;
  const out = emptySceneMap();
  out.offsetMs = clamp(num(o.offsetMs) ?? 0, -MAX_OFFSET_MS, MAX_OFFSET_MS);
  if (isObj(o.devices)) {
    for (const [kind, d] of Object.entries(o.devices)) {
      const dev = parseDevice(d);
      if (kind.trim() && dev) out.devices[kind.trim()] = dev;
    }
  }
  return out;
}

// TCode Player's DEFAULT_CHANNEL_MAP (channel name -> TCode axis), for
// migrated entries that only change invert / range of the default axis.
const TCODE_DEFAULT_CHANNEL_MAP: Record<string, string> = {
  stroke: "L0", main: "L0",
  surge: "L1", sway: "L2",
  twist: "R0", roll: "R1", pitch: "R2",
  vib: "V0", vibe: "V0", vibrate: "V0", pump: "V1",
  valve: "A0", suck: "A1", suction: "A1", lube: "A2",
};
const TCODE_GENERATE_LEVELS = ["off", "gentle", "medium", "strong"];

/** TCode Player's default axis for a channel name ("roll" -> "R1", "r1" -> "R1"), undefined when it has none */
export function tcodeDefaultAxis(channel: string): string | undefined {
  const key = channel.trim();
  if (/^[LRVA]\d$/i.test(key)) return key.toUpperCase();
  return TCODE_DEFAULT_CHANNEL_MAP[key.toLowerCase()];
}

/**
 * A `tcode_map` value as a SceneMap (devices.tcode only); undefined when it is
 * absent or unreadable. Channel names become channel ids (lowercased: TCode's
 * "R1" is our "r1"); { axis, invert, min, max } become { target, invert, min,
 * max } (an entry without axis keeps the default axis, so it is migrated
 * without a target).
 */
export function migrateTcodeMap(raw: unknown, fileKey?: string): SceneMap | undefined {
  let o = readJson(raw);
  if (!isObj(o)) return undefined;
  if (isObj(o.files)) {
    const files = o.files;
    const pick = (fileKey !== undefined ? files[fileKey] : undefined) ?? Object.values(files)[0];
    o = isObj(pick) ? pick : {};
  }
  const cfg = o as Obj;
  const out = emptySceneMap();
  out.offsetMs = clamp(num(cfg.offsetMs) ?? 0, -MAX_OFFSET_MS, MAX_OFFSET_MS);
  const mapping: Record<string, ChannelOverride> = {};
  if (isObj(cfg.channels)) {
    for (const [name, entry] of Object.entries(cfg.channels)) {
      if (!isObj(entry)) continue;
      const id = name.trim().toLowerCase();
      if (!id) continue;
      const m = parseChannelOverride({ target: entry.axis, invert: entry.invert, min: entry.min, max: entry.max });
      if (m) mapping[id] = m;
    }
  }
  const options: Record<string, unknown> = {};
  if (typeof cfg.generate === "string" && TCODE_GENERATE_LEVELS.includes(cfg.generate)) options.generate = cfg.generate;
  if (Object.keys(mapping).length > 0 || Object.keys(options).length > 0) {
    out.devices.tcode = { mapping, ...(Object.keys(options).length > 0 ? { options } : {}) };
  }
  return out;
}

/**
 * The scene's map from its custom fields: `toysync_map`, else a migrated
 * `tcode_map`, else empty. `fileKey` (fileKeyOf the scene's first file) picks
 * the entry of TCode Player's legacy per-file form.
 */
export function readSceneMap(customFields: Readonly<Record<string, unknown>> | null | undefined, fileKey?: string): { map: SceneMap; source: SceneMapSource } {
  const fields = customFields ?? {};
  const own = fields[SCENE_FIELD] !== undefined && fields[SCENE_FIELD] !== null ? parseSceneMap(fields[SCENE_FIELD]) : undefined;
  if (own) return { map: own, source: "toysync" };
  const tcode = fields[TCODE_FIELD] !== undefined && fields[TCODE_FIELD] !== null ? migrateTcodeMap(fields[TCODE_FIELD], fileKey) : undefined;
  if (tcode) return { map: tcode, source: "tcode" };
  return { map: emptySceneMap(), source: "none" };
}

export function isEmptySceneMap(m: SceneMap): boolean {
  return !m.offsetMs && Object.keys(m.devices).length === 0;
}

/** drops device entries left with neither mapping nor options */
export function compactSceneMap(m: SceneMap): SceneMap {
  const out: SceneMap = { v: SCENE_MAP_VERSION, offsetMs: m.offsetMs || 0, devices: {} };
  for (const [kind, d] of Object.entries(m.devices)) {
    const mapping: Record<string, ChannelOverride> = {};
    for (const [ch, entry] of Object.entries(d.mapping)) if (entry && Object.keys(entry).length > 0) mapping[ch] = { ...entry };
    const options = d.options && Object.keys(d.options).length > 0 ? { ...d.options } : undefined;
    if (Object.keys(mapping).length === 0 && !options) continue;
    out.devices[kind] = options ? { mapping, options } : { mapping };
  }
  return out;
}

/** the JSON string stored in `toysync_map` (stable key order: as built) */
export function serializeSceneMap(m: SceneMap): string {
  return JSON.stringify(compactSceneMap(m));
}

export function cloneSceneMap(m: SceneMap): SceneMap {
  return JSON.parse(JSON.stringify(m)) as SceneMap;
}

export interface StashFileLike {
  id?: string | number;
  fingerprints?: readonly { type?: string; value?: unknown }[] | null;
}

/** TCode Player's per-file key: oshash, else md5, else "file-<id>", else "default" */
export function fileKeyOf(file: StashFileLike | null | undefined): string {
  if (!file) return "default";
  const fps = file.fingerprints ?? [];
  const pick = (t: string) => {
    const v = fps.find((f) => f?.type === t)?.value;
    return typeof v === "string" && v ? v : undefined;
  };
  return pick("oshash") ?? pick("md5") ?? (file.id !== undefined && file.id !== null && file.id !== "" ? `file-${file.id}` : "default");
}
