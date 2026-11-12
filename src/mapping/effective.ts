// A device's effective mapping for a scene. Pure.
//
// Per script channel: the scene's saved entry for the device kind (merged over
// the default entry, so a saved { invert: true } keeps the default target),
// else the default entry. The default is the device's own defaultMapping(),
// else, for DriveFrame devices, the built-in one from the axisMap setting
// (targets.ts: driveDefaultMapping); self-timed devices without a default
// start with every channel off. A channel with no target ends up "off".
import type { ChannelMapping, ScriptChannel, ToyDevice } from "../devices/types.ts";
import type { ChannelOverride, SceneMap } from "./sceneMap.ts";
import { driveDefaultMapping, OFF_TARGET, targetIds } from "./targets.ts";

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** a full entry: target ("off" when missing), invert, min / max clamped to 0..100 */
export function normalizeMapping(m: ChannelOverride | undefined): ChannelMapping {
  const min = typeof m?.min === "number" && Number.isFinite(m.min) ? clamp(m.min, 0, 100) : 0;
  const max = typeof m?.max === "number" && Number.isFinite(m.max) ? clamp(m.max, 0, 100) : 100;
  return { target: m?.target || OFF_TARGET, invert: m?.invert === true, min, max };
}

export function isSelfTimed(d: ToyDevice | undefined): boolean {
  return !!d && (d as { selfTimed?: unknown }).selfTimed === true;
}

export interface EffectiveInput {
  channels: readonly ScriptChannel[];
  /** the scene's saved / edited entries for this device kind */
  saved?: Readonly<Record<string, ChannelOverride>>;
  /** the default when nothing is saved for a channel */
  defaults: Readonly<Record<string, ChannelMapping>>;
}

/** one full entry per channel, in channel order */
export function effectiveMapping(input: EffectiveInput): Record<string, ChannelMapping> {
  const out: Record<string, ChannelMapping> = {};
  for (const ch of input.channels) {
    const base = input.defaults[ch.id];
    const over = input.saved?.[ch.id];
    out[ch.id] = normalizeMapping(over ? { ...base, ...over } : base);
  }
  return out;
}

/** a device's default mapping: its own defaultMapping(), else the built-in one (DriveFrame devices) or nothing (self-timed) */
export function deviceDefaults(device: ToyDevice, channels: readonly ScriptChannel[], axisMap: string): Record<string, ChannelMapping> {
  if (typeof device.defaultMapping === "function") {
    try {
      return device.defaultMapping(channels) ?? {};
    } catch (err) {
      console.error(`[toysync] ${device.kind} defaultMapping failed`, err);
    }
  }
  if (isSelfTimed(device)) return {};
  let targets: string[];
  try {
    targets = targetIds(device.mappingTargets?.());
  } catch {
    targets = targetIds(undefined);
  }
  return driveDefaultMapping(channels, axisMap, targets);
}

/** the effective mapping of a device for a scene map (every channel, "off" included) */
export function deviceMapping(device: ToyDevice, channels: readonly ScriptChannel[], map: SceneMap | undefined, axisMap: string): Record<string, ChannelMapping> {
  return effectiveMapping({ channels, saved: map?.devices[device.kind]?.mapping, defaults: deviceDefaults(device, channels, axisMap) });
}

/** whether a channel's entry differs from the default (for "custom" badges) */
export function isCustomEntry(saved: ChannelOverride | undefined): boolean {
  return !!saved && Object.keys(saved).length > 0;
}
