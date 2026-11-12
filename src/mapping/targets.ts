// Mapping targets of the DriveFrame devices and their built-in default
// mapping. Pure.
//
// DriveFrame targets are the parts of the frame: intensity, balance, speed,
// a, b, plus "auto": the channel drives intensity, balance and speed the way
// the stroke always has (intensity per the mode setting, balance = depth,
// speed = stroke speed), each only while no other channel is mapped to it.
//
// The built-in default keeps the behaviour from before per-scene mappings:
// the axisMap setting (or its auto-detection) names the embedded axes for
// intensity / balance / speed / a / b, and the stroke is "auto". A device
// that offers fewer targets (Lovense: intensity) gets the part it can use.
import type { ChannelMapping, MappingTarget, ScriptChannel } from "../devices/types.ts";
import { AUTO_AXES, AXIS_TARGETS, parseAxisMap, type AxisTarget } from "../sync/axes.ts";
import { findChannel, STROKE_CHANNEL } from "./channels.ts";

export const OFF_TARGET = "off";
export const AUTO_TARGET = "auto";

/** every target a DriveFrame device can read */
export const DRIVE_TARGET_IDS: readonly string[] = [AUTO_TARGET, ...AXIS_TARGETS];

/** Lovense and other vibrators: one level */
export const VIBRATOR_TARGETS: readonly MappingTarget[] = Object.freeze([{ id: "intensity", label: "Vibration", group: "Output" }]);

/** two-channel e-stim (DG-Lab Coyote) */
export const ESTIM_TARGETS: readonly MappingTarget[] = Object.freeze([
  { id: AUTO_TARGET, label: "Auto: intensity, balance and frequency", group: "Follow the motion" },
  { id: "intensity", label: "Intensity", group: "Strength" },
  { id: "a", label: "Channel A", group: "Strength" },
  { id: "b", label: "Channel B", group: "Strength" },
  { id: "balance", label: "Balance A↔B", group: "Shape" },
  { id: "speed", label: "Pulse frequency", group: "Shape" },
]);

/** which channel feeds which target under the axisMap setting (or auto-detection); "auto" = the stroke */
export function resolveDriveSources(channels: readonly ScriptChannel[], axisMap: string): Partial<Record<AxisTarget | "auto", string>> {
  const out: Partial<Record<AxisTarget | "auto", string>> = {};
  const used = new Set<string>();
  const assign = (target: AxisTarget, id: string) => {
    if (out[target] || used.has(id)) return;
    out[target] = id;
    used.add(id);
  };
  const entries = parseAxisMap(axisMap).entries;
  if (entries.length > 0) {
    for (const e of entries) {
      const ch = findChannel(channels, e.axis);
      if (ch) assign(e.target, ch.id);
    }
  } else {
    for (const target of AXIS_TARGETS) {
      for (const id of AUTO_AXES[target]) {
        const ch = channels.find((c) => c.id === id && c.actions.length > 0);
        if (ch) {
          assign(target, ch.id);
          break;
        }
      }
    }
  }
  const stroke = channels.find((c) => c.id === STROKE_CHANNEL && c.actions.length > 0);
  if (stroke && !used.has(stroke.id)) out.auto = stroke.id;
  return out;
}

/**
 * The built-in default mapping for a DriveFrame device offering `targets`
 * (ids). With every target: the axisMap sources plus the stroke on "auto"
 * (exactly the pre-mapping frame). Without "auto" the stroke takes intensity
 * when nothing else does; with neither a stroke nor an intensity source the
 * first of channel A / B takes it (the old frame's max(a, b), roughly).
 */
export function driveDefaultMapping(channels: readonly ScriptChannel[], axisMap: string, targets: readonly string[]): Record<string, ChannelMapping> {
  const allowed = new Set(targets);
  const src = resolveDriveSources(channels, axisMap);
  const out: Record<string, ChannelMapping> = {};
  for (const t of AXIS_TARGETS) {
    const id = src[t];
    if (id && allowed.has(t)) out[id] = { target: t };
  }
  const hasIntensity = () => Object.values(out).some((m) => m.target === "intensity" || m.target === AUTO_TARGET);
  if (src.auto) {
    if (allowed.has(AUTO_TARGET)) out[src.auto] = { target: AUTO_TARGET };
    else if (allowed.has("intensity") && !hasIntensity()) out[src.auto] = { target: "intensity" };
  } else if (allowed.has("intensity") && !hasIntensity()) {
    const id = [src.a, src.b].find((c) => c !== undefined && out[c] === undefined);
    if (id) out[id] = { target: "intensity" };
  }
  return out;
}

/** the target ids of a device's mappingTargets(), or every DriveFrame target when it names none */
export function targetIds(targets: readonly MappingTarget[] | undefined): string[] {
  return targets && targets.length > 0 ? targets.map((t) => t.id) : [...DRIVE_TARGET_IDS];
}
