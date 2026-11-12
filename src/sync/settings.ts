// The plugin settings (plugin/toysync.yml), read leniently: anything missing,
// empty or out of range falls back to the default or is clamped. Pure.

export type Mode = "speed" | "position";

export interface Settings {
  mode: Mode;
  /** 0..100 % */
  strength: number;
  /** position units per second that count as full intensity in speed mode */
  speedFull: number;
  /** 0..20; the lowest level while there is any intensity */
  minLevel: number;
  /** ms the script is read ahead of the video (negative = behind) */
  latencyMs: number;
  invert: boolean;
  snapPulse: boolean;
  /** extra Bluetooth name filter for the Lovense picker; "" = none */
  namePrefix: string;
  /** axis id -> target mapping for multi-axis scripts (see sync/axes.ts); "" = auto-detect */
  axisMap: string;
  /** seconds between two nudges, at least NUDGE_COOLDOWN_MIN_SEC */
  nudgeCooldownSec: number;
  /** nudges per rolling minute, 0..NUDGES_PER_MINUTE_MAX (0 = nudges off) */
  nudgesPerMinute: number;
  /** e-stim pulse frequency (Hz) at speed 0; for the e-stim drivers */
  estimSpeedMinHz: number;
  /** e-stim pulse frequency (Hz) at speed 1; for the e-stim drivers; > estimSpeedMinHz */
  estimSpeedMaxHz: number;
}

export const DEFAULT_SETTINGS: Settings = {
  mode: "speed",
  strength: 100,
  speedFull: 300,
  minLevel: 0,
  latencyMs: 0,
  invert: false,
  snapPulse: true,
  namePrefix: "",
  axisMap: "",
  nudgeCooldownSec: 4,
  nudgesPerMinute: 6,
  estimSpeedMinHz: 10,
  estimSpeedMaxHz: 100,
};

export const NUDGE_COOLDOWN_MIN_SEC = 2;
/** a cooldown beyond this is surely a typo; also keeps the limiter's arithmetic sane */
export const NUDGE_COOLDOWN_MAX_SEC = 600;
export const NUDGES_PER_MINUTE_MAX = 10;
/** the e-stim frequency settings are clamped to this range (Hz) */
export const ESTIM_HZ_MIN = 1;
export const ESTIM_HZ_MAX = 1000;

/** latency beyond this is surely a typo (seconds instead of ms) */
export const MAX_LATENCY_MS = 5000;

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : typeof v === "number" && Number.isFinite(v) ? String(v) : "";
}

function num(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v.trim().replace(",", ".").replace(/%$/, ""));
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function bool(v: unknown, fallback: boolean): boolean {
  if (v === true || v === false) return v;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "true" || s === "1" || s === "yes" || s === "on") return true;
    if (s === "false" || s === "0" || s === "no" || s === "off") return false;
  }
  return fallback;
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export function parseSettings(raw: Record<string, unknown> | null | undefined): Settings {
  const r = raw ?? {};
  const modeRaw = str(r.mode).toLowerCase();
  const mode: Mode = modeRaw === "position" || modeRaw === "pos" || modeRaw === "depth" ? "position" : "speed";
  const strength = clamp(num(r.strength) ?? DEFAULT_SETTINGS.strength, 0, 100);
  const sf = num(r.speedFull);
  const speedFull = sf !== undefined && sf > 0 ? sf : DEFAULT_SETTINGS.speedFull;
  const minLevel = Math.round(clamp(num(r.minLevel) ?? DEFAULT_SETTINGS.minLevel, 0, 20));
  const latencyMs = clamp(num(r.latencyMs) ?? DEFAULT_SETTINGS.latencyMs, -MAX_LATENCY_MS, MAX_LATENCY_MS);
  const nudgeCooldownSec = clamp(num(r.nudgeCooldownSec) ?? DEFAULT_SETTINGS.nudgeCooldownSec, NUDGE_COOLDOWN_MIN_SEC, NUDGE_COOLDOWN_MAX_SEC);
  const nudgesPerMinute = Math.round(clamp(num(r.nudgesPerMinute) ?? DEFAULT_SETTINGS.nudgesPerMinute, 0, NUDGES_PER_MINUTE_MAX));
  let estimSpeedMinHz = clamp(num(r.estimSpeedMinHz) ?? DEFAULT_SETTINGS.estimSpeedMinHz, ESTIM_HZ_MIN, ESTIM_HZ_MAX);
  let estimSpeedMaxHz = clamp(num(r.estimSpeedMaxHz) ?? DEFAULT_SETTINGS.estimSpeedMaxHz, ESTIM_HZ_MIN, ESTIM_HZ_MAX);
  if (!(estimSpeedMinHz < estimSpeedMaxHz)) {
    // a crossed or empty range: the defaults, rather than guessing which value was meant
    estimSpeedMinHz = DEFAULT_SETTINGS.estimSpeedMinHz;
    estimSpeedMaxHz = DEFAULT_SETTINGS.estimSpeedMaxHz;
  }
  return {
    mode,
    strength,
    speedFull,
    minLevel,
    latencyMs,
    invert: bool(r.invert, DEFAULT_SETTINGS.invert),
    snapPulse: bool(r.snapPulse, DEFAULT_SETTINGS.snapPulse),
    namePrefix: str(r.namePrefix),
    axisMap: str(r.axisMap),
    nudgeCooldownSec,
    nudgesPerMinute,
    estimSpeedMinHz,
    estimSpeedMaxHz,
  };
}

export interface SettingsStore {
  get(): Settings;
  /** replaces the settings; listeners hear only real changes */
  set(s: Settings): void;
  onChange(cb: (s: Settings) => void): () => void;
}

/** the page-wide current settings, shared by the engine, the drivers and the pages */
export function createSettingsStore(initial: Settings = DEFAULT_SETTINGS): SettingsStore {
  let current = initial;
  let key = JSON.stringify(initial);
  const listeners = new Set<(s: Settings) => void>();
  return {
    get: () => current,
    set(s) {
      const k = JSON.stringify(s);
      if (k === key) return;
      current = s;
      key = k;
      for (const cb of [...listeners]) {
        try {
          cb(s);
        } catch (err) {
          console.error("[toysync] settings listener failed", err);
        }
      }
    },
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}
