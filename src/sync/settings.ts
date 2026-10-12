// The plugin settings (plugin/lovense.yml), read leniently: anything missing,
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
  /** extra Bluetooth name filter for the picker; "" = none */
  namePrefix: string;
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
};

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
  return {
    mode,
    strength,
    speedFull,
    minLevel,
    latencyMs,
    invert: bool(r.invert, DEFAULT_SETTINGS.invert),
    snapPulse: bool(r.snapPulse, DEFAULT_SETTINGS.snapPulse),
    namePrefix: str(r.namePrefix),
  };
}
