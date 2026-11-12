// One device's DriveFrame from its mapping and the script values at this
// instant. Pure; the engine (sync/engine.ts) computes the values once per tick
// and builds a frame per device kind.
//
// Values per source channel:
// - the main stroke: intensity (and a / b) = the stroke intensity of the mode
//   setting (speed or depth, smoothed), balance = depth, speed = stroke speed
// - any other channel: its position / 100 (a level), undefined outside its
//   actions
// then the mapping's invert and min/max window (applyChannelMapping).
//
// Per target the first channel mapped to it wins (in mapping order):
// - a / b: the channel's value, 0 outside it; unset when nothing maps them
// - intensity: its channel, else the "auto" channel, else max(a, b)
// - balance: its channel, falling back to the auto channel's depth, else 0.5
// - speed: its channel, falling back to the auto channel's speed, else 0
// Snap pulses lift intensity, a and b; the gain multiplies them (never
// balance or speed).
import type { ChannelMapping, DriveFrame } from "../devices/types.ts";
import { STROKE_CHANNEL } from "./channels.ts";
import { AUTO_TARGET, OFF_TARGET } from "./targets.ts";

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : Number.isFinite(v) ? v : 0);

/** what the main stroke gives at this instant */
export interface StrokeValues {
  /** 0..1 per the mode setting (speed mode: smoothed stroke speed; position mode: depth); 0 outside the script */
  intensity: number;
  /** depth 0..1 (0 = out); undefined outside the script */
  balance: number | undefined;
  /** stroke speed 0..1, lightly smoothed */
  speed: number;
}

export interface FrameSources {
  /** undefined when the script has no stroke */
  stroke?: StrokeValues;
  /** a non-stroke channel's position / 100 now, undefined outside its actions or for unknown ids */
  level(channelId: string): number | undefined;
}

/** a channel value 0..1 through a mapping: inverted first, then lerped into [min, max] / 100 */
export function applyChannelMapping(v: number, m: Pick<ChannelMapping, "invert" | "min" | "max">): number {
  let x = clamp01(v);
  if (m.invert) x = 1 - x;
  const lo = clamp01((m.min ?? 0) / 100);
  const hi = clamp01((m.max ?? 100) / 100);
  if (lo === 0 && hi === 1) return x;
  return clamp01(lo + (hi - lo) * x);
}

type Part = "intensity" | "balance" | "speed";

/** the mapping without "off" entries (a channel absent here isn't used) */
export function activeMapping(mapping: Readonly<Record<string, ChannelMapping>>): Record<string, ChannelMapping> {
  const out: Record<string, ChannelMapping> = {};
  for (const [id, m] of Object.entries(mapping)) if (m && m.target && m.target !== OFF_TARGET) out[id] = m;
  return out;
}

export function buildFrame(mapping: Readonly<Record<string, ChannelMapping>>, src: FrameSources, pulse: number, gain: number): DriveFrame {
  const first = new Map<string, [string, ChannelMapping]>();
  for (const [id, m] of Object.entries(mapping)) {
    if (!m || !m.target || m.target === OFF_TARGET || first.has(m.target)) continue;
    first.set(m.target, [id, m]);
  }
  const value = (entry: [string, ChannelMapping] | undefined, part: Part): number | undefined => {
    if (!entry) return undefined;
    const [id, m] = entry;
    const raw = id === STROKE_CHANNEL ? src.stroke?.[part] : src.level(id);
    return raw === undefined ? undefined : applyChannelMapping(raw, m);
  };
  const auto = first.get(AUTO_TARGET);
  const aEntry = first.get("a");
  const bEntry = first.get("b");
  const a = aEntry ? (value(aEntry, "intensity") ?? 0) : undefined;
  const b = bEntry ? (value(bEntry, "intensity") ?? 0) : undefined;
  const iEntry = first.get("intensity");
  let intensity: number;
  if (iEntry) intensity = value(iEntry, "intensity") ?? 0;
  else if (auto) intensity = value(auto, "intensity") ?? 0;
  else intensity = Math.max(a ?? 0, b ?? 0);
  const autoBalance = value(auto, "balance");
  const balance = value(first.get("balance"), "balance") ?? autoBalance ?? 0.5;
  const autoSpeed = value(auto, "speed");
  const speed = value(first.get("speed"), "speed") ?? autoSpeed ?? 0;

  const g = clamp01(gain);
  const lift = (v: number) => clamp01(Math.max(v, pulse) * g);
  const frame: DriveFrame = { intensity: lift(intensity), balance: clamp01(balance), speed: clamp01(speed), gain: g };
  if (a !== undefined) frame.a = lift(a);
  if (b !== undefined) frame.b = lift(b);
  return frame;
}
