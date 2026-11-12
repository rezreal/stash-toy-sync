// The pure core of the TCode driver, ported from the TCode Player plugin
// (stash-interactive-tcode, plugin/TCodePlayer.js, MIT, same author): the
// device profile and its presets, the per-channel and per-axis stages of the
// signal chain, TCode formatting, and the old per-scene config format. No
// DOM, no timers.
//
// Signal chain per output frame:
//   pos 0..100 (linear interpolation of the actions at t)          valueAt()
//   -> channel stage: invert, lerp into [min, max]  (scene mapping) applyChannelMap()
//   -> device stage: axis invert, lerp into the axis' [min, max]    applyAxisCaps()
//   -> speed limit against the last value sent (engine.ts)
//   -> TCode "L05166I17 R17583I17\n" (4 digits, I = move time ms)   tcodeCommand()
import type { ChannelMapping, MappingTarget, ScriptChannel } from "../devices/types.ts";

export const AXES = ["L0", "L1", "L2", "R0", "R1", "R2", "V0", "V1", "A0", "A1", "A2"] as const;
export type Axis = (typeof AXES)[number];

export const AXIS_LABELS: Record<Axis, string> = {
  L0: "Stroke", L1: "Surge", L2: "Sway",
  R0: "Twist", R1: "Roll", R2: "Pitch",
  V0: "Vibe", V1: "Vibe 2/Pump",
  A0: "Valve", A1: "Suction", A2: "Lube",
};

/** picker groups for the scene tab */
export function axisGroup(axis: string): string {
  return axis[0] === "L" ? "Linear" : axis[0] === "R" ? "Rotation" : "Auxiliary";
}

/** channel name (lower case) -> TCode axis */
export const DEFAULT_CHANNEL_MAP: Readonly<Record<string, string>> = {
  stroke: "L0", main: "L0",
  surge: "L1", sway: "L2",
  twist: "R0", roll: "R1", pitch: "R2",
  vib: "V0", vibe: "V0", vibrate: "V0", pump: "V1",
  valve: "A0", suck: "A1", suction: "A1", lube: "A2",
};

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
export function num(v: unknown, d: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}
/** a deep copy (profiles are plain JSON) */
export function cloneProfile(p: Profile): Profile {
  return JSON.parse(JSON.stringify(p)) as Profile;
}
const hasOwn = (o: object, k: unknown): boolean => typeof k === "string" && Object.prototype.hasOwnProperty.call(o, k);

export function isAxis(a: unknown): a is Axis {
  return typeof a === "string" && (AXES as readonly string[]).includes(a);
}

/** where an axis rests: L/R axes in the middle, V/A axes (vibe, valve, suction, lube) at 0 */
export function homeOf(axis: string): number {
  return axis[0] === "V" || axis[0] === "A" ? 0 : 0.5;
}

// Device presets define which axes the hardware has. Auxiliary V/A axes (vibe, valve,
// suction, lube add-ons) are included – they are only sent when a channel maps to them.
const AUX_AXES: Axis[] = ["V0", "V1", "A0", "A1", "A2"];
export type Model = "osr2" | "sr6" | "ssr1" | "custom";
export const DEVICE_PRESETS: Record<Model, { label: string; axes: readonly Axis[] | null }> = {
  osr2: { label: "OSR2 / OSR2+", axes: (["L0", "R0", "R1", "R2"] as Axis[]).concat(AUX_AXES) },
  sr6: { label: "SR6", axes: (["L0", "L1", "L2", "R0", "R1", "R2"] as Axis[]).concat(AUX_AXES) },
  ssr1: { label: "SSR1 (stroke only)", axes: (["L0"] as Axis[]).concat(AUX_AXES) },
  custom: { label: "Custom", axes: null },
};
export const MODELS = Object.keys(DEVICE_PRESETS) as Model[];

export function isModel(m: unknown): m is Model {
  return hasOwn(DEVICE_PRESETS, m);
}

// --- generated axes: levels (the generators are in generate.ts) ---------------------

export type GenerateLevel = "off" | "gentle" | "medium" | "strong";
/** level -> how far generated motion may swing (0..1 of half the range) and the vibe ceiling */
export const GENERATE_LEVELS: Record<GenerateLevel, { motion: number; vibe: number } | null> = {
  off: null,
  gentle: { motion: 0.3, vibe: 0.5 },
  medium: { motion: 0.55, vibe: 0.75 },
  strong: { motion: 0.85, vibe: 1 },
};
export const LEVEL_LABELS: Record<GenerateLevel, string> = { off: "Off", gentle: "Gentle", medium: "Medium", strong: "Strong" };

export function isLevel(v: unknown): v is GenerateLevel {
  return hasOwn(GENERATE_LEVELS, v);
}

// --- profile -------------------------------------------------------------------------

export interface AxisCfg {
  enabled: boolean;
  /** 0..100 window the full range is lerped into */
  min: number;
  max: number;
  invert: boolean;
  /** max change in % of range per second, 0 = off */
  speed: number;
}

export interface SidecarMapping {
  fs: string;
  url: string;
}

/** The device profile, stored as JSON in the plugin config (key tcodeProfile). Same shape as TCode Player's. */
export interface Profile {
  v: 1;
  model: Model;
  baud: number;
  rateHz: number;
  rampMs: number;
  /** device-specific offset on top of the scene offset and the latency setting */
  offsetMs: number;
  autoConnect: boolean;
  homeOnPause: boolean;
  /** fill in missing axes from the stroke */
  generate: GenerateLevel;
  /** also make vibration (V0) from stroke speed */
  generateVibe: boolean;
  axes: Record<Axis, AxisCfg>;
  channelMap: Record<string, string>;
  /** kept from TCode Player profiles; separate axis files are not loaded by Toy Sync */
  sidecar: { enabled: boolean; mappings: SidecarMapping[] };
}

export function defaultAxisCfg(axis: Axis): AxisCfg {
  return { enabled: DEVICE_PRESETS.osr2.axes!.indexOf(axis) >= 0, min: 0, max: 100, invert: false, speed: 0 };
}

/** Switch the device model; presets set which axes are enabled, tuning (range/invert/speed) is kept. */
export function applyPreset(profile: Profile, model: string): Profile {
  const m: Model = isModel(model) ? model : "custom";
  const preset = DEVICE_PRESETS[m];
  const out: Profile = { ...profile, model: m, axes: {} as Record<Axis, AxisCfg> };
  for (const a of AXES) {
    const ax = { ...profile.axes[a] };
    if (preset.axes) ax.enabled = preset.axes.indexOf(a) >= 0;
    out.axes[a] = ax;
  }
  return out;
}

/** Detect which preset matches a set of enabled axes (for profiles saved before presets existed). */
export function detectModel(axes: Partial<Record<string, { enabled?: boolean } | undefined>>): Model {
  const enabled = AXES.filter((a) => axes[a] && axes[a]!.enabled).join(",");
  for (const k of MODELS) {
    const pa = DEVICE_PRESETS[k].axes;
    if (pa && AXES.filter((a) => pa.indexOf(a) >= 0).join(",") === enabled) return k;
  }
  return "custom";
}

export function defaultProfile(): Profile {
  const axes = {} as Record<Axis, AxisCfg>;
  for (const a of AXES) axes[a] = defaultAxisCfg(a);
  return {
    v: 1,
    model: "osr2",
    baud: 115200,
    rateHz: 60,
    rampMs: 400,
    offsetMs: 0,
    autoConnect: true,
    homeOnPause: false,
    generate: "off",
    generateVibe: false,
    axes,
    channelMap: { ...DEFAULT_CHANNEL_MAP },
    sidecar: { enabled: false, mappings: [] },
  };
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null;

/** Any stored profile (or nothing) -> a complete, clamped profile. */
export function normalizeProfile(input: unknown): Profile {
  const d = defaultProfile();
  if (!isObj(input)) return d;
  const p = input;
  const out = { ...d, ...p } as Profile;
  const axesIn = isObj(p.axes) ? p.axes : {};
  out.axes = {} as Record<Axis, AxisCfg>;
  for (const a of AXES) out.axes[a] = Object.assign(defaultAxisCfg(a), isObj(axesIn[a]) ? axesIn[a] : {});
  out.channelMap = { ...(isObj(p.channelMap) ? (p.channelMap as Record<string, string>) : d.channelMap) };
  out.sidecar = Object.assign({}, d.sidecar, isObj(p.sidecar) ? p.sidecar : {});
  out.sidecar.mappings = Array.isArray(out.sidecar.mappings) ? out.sidecar.mappings : [];
  out.rateHz = clamp(num(out.rateHz, 60), 10, 200);
  out.baud = num(out.baud, 115200);
  out.rampMs = clamp(num(out.rampMs, 400), 0, 3000);
  out.offsetMs = num(out.offsetMs, 0);
  if (!isLevel(out.generate)) out.generate = "off";
  out.generateVibe = !!out.generateVibe;
  const model = isModel(p.model) ? p.model : detectModel(out.axes);
  return applyPreset(out, model); // a preset is authoritative for which axes are enabled
}

// --- channels --------------------------------------------------------------------------

export interface Action {
  at: number;
  pos: number;
}

/** A script channel as the driver uses it. */
export interface Channel {
  /** normalized: TCode ids upper case ("R1"), names lower case ("roll") */
  name: string;
  /** the id the program uses for it (key of the scene mapping); absent for generated channels */
  id?: string;
  actions: readonly Action[];
  inverted: boolean;
  /** "embedded" | "script" | "file" | "generated" */
  source?: string;
}

export function sanitizeActions(list: unknown): Action[] {
  if (!Array.isArray(list)) return [];
  const out: Action[] = [];
  for (const a of list) {
    if (!a) continue;
    const at = Number(a.at), pos = Number(a.pos);
    if (!Number.isFinite(at) || !Number.isFinite(pos)) continue;
    out.push({ at, pos: clamp(pos, 0, 100) });
  }
  out.sort((x, y) => x.at - y.at);
  return out;
}

/** Normalize a channel identifier: TCode IDs upper case, names lower case. */
export function normalizeChannelName(name: unknown): string {
  const s = String(name || "").trim();
  if (/^[LRVA]\d$/i.test(s)) return s.toUpperCase();
  return s.toLowerCase();
}

/** Collects channels: names normalized, actions sanitized, a later channel of the same name replaces the earlier. */
function channelList() {
  const channels: Channel[] = [];
  const add = (rawName: unknown, actions: unknown, inverted: unknown, source: string, id?: string) => {
    const acts = sanitizeActions(actions);
    if (!acts.length) return;
    const name = normalizeChannelName(rawName);
    if (!name) return;
    const existing = channels.findIndex((c) => c.name === name);
    const ch: Channel = { name, actions: acts, inverted: !!inverted, source };
    if (id !== undefined) ch.id = id;
    if (existing >= 0) channels[existing] = ch;
    else channels.push(ch);
  };
  return { channels, add };
}

/**
 * Parse any funscript flavour into a flat channel list (TCode Player's parser;
 * Toy Sync loads scripts itself and hands the driver ScriptChannels, which go
 * through the same normalization in channelsFromScript).
 *   1.0 : { actions }
 *   1.1 : { actions, axes: [{ id, actions }] }
 *   2.0 : { actions, channels: { name: { actions } } }
 *   also tolerated: channels as array, additional_axes (HereSphere-style)
 */
export function parseFunscript(json: unknown, source = "embedded"): { version: string | null; channels: Channel[] } {
  const { channels, add } = channelList();
  if (!isObj(json)) return { version: null, channels };
  const addList = (list: unknown) => {
    if (!Array.isArray(list)) return;
    for (const ax of list) {
      if (!ax) continue;
      add(ax.id || ax.name || ax.axis || ax.channel, ax.actions, ax.inverted, source);
    }
  };
  add("stroke", json.actions, json.inverted, source);
  addList(json.axes);
  addList(json.additional_axes);
  if (Array.isArray(json.channels)) {
    addList(json.channels);
  } else if (isObj(json.channels)) {
    const chs = json.channels;
    for (const key of Object.keys(chs)) {
      const val = chs[key];
      if (Array.isArray(val)) add(key, val, false, source);
      else if (isObj(val)) add(key, val.actions, val.inverted, source);
    }
  }
  return { version: json.version != null ? String(json.version) : null, channels };
}

/** The program's channels as driver channels (names normalized, the program id kept for the mapping). */
export function channelsFromScript(script: readonly ScriptChannel[]): Channel[] {
  const { channels, add } = channelList();
  // the main axis carries the file's own `inverted` flag (embedded axes come with it applied)
  for (const c of script) add(c.id, c.actions, c.inverted === true, "script", c.id);
  return channels;
}

/** Linear interpolation of a sorted action list at time t (ms). */
export function valueAt(actions: readonly Action[], t: number): number | null {
  const n = actions.length;
  if (!n) return null;
  if (t <= actions[0]!.at) return actions[0]!.pos;
  if (t >= actions[n - 1]!.at) return actions[n - 1]!.pos;
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (actions[mid]!.at <= t) lo = mid;
    else hi = mid;
  }
  const a = actions[lo]!, b = actions[hi]!;
  const dt = b.at - a.at;
  if (dt <= 0) return b.pos;
  return a.pos + ((b.pos - a.pos) * (t - a.at)) / dt;
}

// --- mapping ---------------------------------------------------------------------------

/** How one channel drives one axis ("off" = not at all). */
export interface MapEntry {
  axis: string;
  invert: boolean;
  min: number;
  max: number;
  name?: string;
  custom?: boolean;
}

/** Default mapping for a channel, derived from the profile's channel map. */
export function defaultEntry(name: string, profile: Pick<Profile, "channelMap">): MapEntry {
  const key = normalizeChannelName(name);
  let axis = (profile.channelMap || {})[key.toLowerCase()];
  if (!axis && isAxis(key)) axis = key;
  return { axis: axis || "off", invert: false, min: 0, max: 100 };
}

/** Effective mapping for every channel (profile defaults + per-scene overrides of the old tcode_map format). */
export function resolveMapping(channels: readonly Channel[], profile: Profile, fileCfg?: { channels?: Record<string, Partial<MapEntry>> } | null): MapEntry[] {
  const overrides = (fileCfg && fileCfg.channels) || {};
  return channels.map((ch) => {
    const base = defaultEntry(ch.name, profile);
    const ov = overrides[ch.name] || {};
    const m = { ...base, ...ov } as MapEntry;
    m.min = clamp(num(m.min, 0), 0, 100);
    m.max = clamp(num(m.max, 100), 0, 100);
    return Object.assign(m, { name: ch.name, custom: Object.keys(ov).length > 0 });
  });
}

/**
 * The effective mapping for the driver's channels from a program's mapping
 * (channel id -> target). A script channel absent from it is off; a generated
 * channel absent from it follows the profile's channel map.
 */
export function mappingFromProgram(
  channels: readonly Channel[],
  mapping: Readonly<Record<string, ChannelMapping>>,
  profile: Profile,
): MapEntry[] {
  return channels.map((ch) => {
    const m = (ch.id !== undefined ? mapping[ch.id] : undefined) ?? mapping[ch.name];
    let entry: MapEntry;
    if (m) {
      entry = {
        axis: isAxis(m.target) ? m.target : "off",
        invert: !!m.invert,
        min: clamp(num(m.min, 0), 0, 100),
        max: clamp(num(m.max, 100), 0, 100),
      };
    } else if (ch.source === "generated") {
      entry = defaultEntry(ch.name, profile);
    } else {
      entry = { axis: "off", invert: false, min: 0, max: 100 };
    }
    if (entry.min > entry.max) [entry.min, entry.max] = [entry.max, entry.min];
    return Object.assign(entry, { name: ch.name, custom: !!m });
  });
}

/** Keep only the properties that differ from the defaults. */
export function stripDefaults(name: string, entry: Partial<MapEntry>, profile: Profile): Partial<MapEntry> {
  const base = defaultEntry(name, profile);
  const out: Partial<MapEntry> = {};
  for (const k of ["axis", "invert", "min", "max"] as const) {
    if (entry[k] !== undefined && entry[k] !== base[k]) (out as Record<string, unknown>)[k] = entry[k];
  }
  return out;
}

/** Channel stage: 0..100 -> 0..100 (invert, then lerp into [min, max]). */
export function applyChannelMap(pos: number, m: { invert?: boolean; min: number; max: number }, scriptInverted?: boolean): number {
  let v = clamp(pos, 0, 100) / 100;
  if (!!m.invert !== !!scriptInverted) v = 1 - v;
  const lo = m.min / 100, hi = m.max / 100;
  return clamp(lo + (hi - lo) * v, 0, 1) * 100;
}

/** Device stage: 0..100 -> 0..1 (per-axis invert + caps, lerped). */
export function applyAxisCaps(v: number, ax: { invert?: boolean; min?: number; max?: number }): number {
  let x = clamp(v, 0, 100) / 100;
  if (ax.invert) x = 1 - x;
  const lo = clamp(num(ax.min, 0), 0, 100) / 100;
  const hi = clamp(num(ax.max, 100), 0, 100) / 100;
  return clamp(lo + (hi - lo) * x, 0, 1);
}

export function tcodeValue(x: number): string {
  return String(Math.round(clamp(x, 0, 1) * 9999)).padStart(4, "0");
}

export function tcodeCommand(axis: string, x: number, intervalMs: number): string {
  let s = axis + tcodeValue(x);
  if (intervalMs > 0) s += "I" + Math.max(1, Math.round(intervalMs));
  return s;
}

/**
 * Device targets (0..1) per axis for time t.
 * Later mapping entries win when two channels target the same axis.
 */
export function computeTargets(channels: readonly Channel[], mapping: readonly MapEntry[], profile: Profile, t: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (let i = 0; i < mapping.length; i++) {
    const m = mapping[i]!;
    if (m.axis === "off") continue;
    const ax = profile.axes[m.axis as Axis];
    if (!ax || !ax.enabled) continue;
    const ch = channels[i];
    if (!ch) continue;
    const raw = valueAt(ch.actions, t);
    if (raw == null) continue;
    out[m.axis] = applyAxisCaps(applyChannelMap(raw, m, ch.inverted), ax);
  }
  return out;
}

/** Axes targeted by more than one channel. */
export function findConflicts(mapping: readonly MapEntry[]): Record<string, true> {
  const seen: Record<string, true> = {}, dup: Record<string, true> = {};
  for (const m of mapping) {
    if (m.axis === "off") continue;
    if (seen[m.axis]) dup[m.axis] = true;
    seen[m.axis] = true;
  }
  return dup;
}

// --- what the scene tab gets -------------------------------------------------------------

/** The profile's active axes as mapping targets, grouped Linear / Rotation / Auxiliary. */
export function axisTargets(profile: Profile): MappingTarget[] {
  return AXES.filter((a) => profile.axes[a].enabled).map((a) => ({ id: a, label: `${a} ${AXIS_LABELS[a]}`, group: axisGroup(a) }));
}

/** The default mapping for a scene's channels: by the profile's channel map (stroke -> L0, roll -> R1, R1 -> R1 …), active axes only. */
export function defaultChannelMapping(channels: readonly ScriptChannel[], profile: Profile): Record<string, ChannelMapping> {
  const out: Record<string, ChannelMapping> = {};
  for (const c of channels) {
    const axis = defaultEntry(c.id, profile).axis;
    if (isAxis(axis) && profile.axes[axis].enabled) out[c.id] = { target: axis };
  }
  return out;
}

/** osr-emu model for a profile (Custom: SR6 when surge or sway is on). */
export function emuModelFor(profile: Profile): "OSR2" | "SR6" | "SSR1" {
  if (profile.model === "sr6") return "SR6";
  if (profile.model === "ssr1") return "SSR1";
  if (profile.model === "osr2") return "OSR2";
  return profile.axes.L1.enabled || profile.axes.L2.enabled ? "SR6" : "OSR2";
}

// --- TCode Player's per-scene config (scene custom field tcode_map) --------------------

export interface SceneCfg {
  v: 2;
  offsetMs: number;
  channels: Record<string, Partial<MapEntry>>;
  generate?: GenerateLevel;
}

/**
 * Scene custom field -> { v: 2, offsetMs, channels }.
 * Also reads the old per-file format { v: 1, files: { <hash>: {...} } } (prefers legacyKey, else first entry).
 */
export function parseSceneCfg(value: unknown, legacyKey?: string): SceneCfg {
  const empty: SceneCfg = { v: 2, offsetMs: 0, channels: {} };
  if (!value) return empty;
  let o: unknown;
  try {
    o = typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    return empty;
  }
  if (!isObj(o)) return empty;
  if (isObj(o.files)) {
    const files = o.files;
    o = (legacyKey !== undefined ? files[legacyKey] : undefined) || Object.values(files)[0] || {};
  }
  const cfg = o as Obj;
  const channels = isObj(cfg.channels) ? (cfg.channels as SceneCfg["channels"]) : {};
  const out: SceneCfg = { v: 2, offsetMs: num(cfg.offsetMs, 0), channels };
  if (isLevel(cfg.generate)) out.generate = cfg.generate; // absent = use the device setting
  return out;
}

export function isEmptyFileCfg(fc: { offsetMs?: number; generate?: string; channels?: object } | null | undefined): boolean {
  return !fc || (!num(fc.offsetMs, 0) && !fc.generate && Object.keys(fc.channels || {}).length === 0);
}

/**
 * A TCode Player tcode_map value as a Toy Sync scene mapping for this
 * device: every channel of the scene with its effective axis (profile
 * defaults + the stored overrides), plus the per-scene generate level and
 * offset. For migrating scenes; channels that end up "off" are left out.
 */
export function legacySceneMapping(
  value: unknown,
  channels: readonly ScriptChannel[],
  profile: Profile,
): { mapping: Record<string, ChannelMapping>; options: { generate?: GenerateLevel }; offsetMs: number } {
  const cfg = parseSceneCfg(value);
  const chs = channelsFromScript(channels);
  const resolved = resolveMapping(chs, profile, cfg);
  const mapping: Record<string, ChannelMapping> = {};
  resolved.forEach((m, i) => {
    if (!isAxis(m.axis)) return;
    const out: ChannelMapping = { target: m.axis };
    if (m.invert) out.invert = true;
    if (m.min !== 0) out.min = m.min;
    if (m.max !== 100) out.max = m.max;
    mapping[chs[i]!.id!] = out;
  });
  const options: { generate?: GenerateLevel } = {};
  if (cfg.generate) options.generate = cfg.generate;
  return { mapping, options, offsetMs: cfg.offsetMs };
}
