// What the scene tab shows, as plain data. Pure, tested.
import type { ChannelMapping, DeviceStatus, MappingTarget, ToyDevice } from "../devices/types.ts";
import { STROKE_CHANNEL } from "../mapping/channels.ts";
import { isSelfTimed } from "../mapping/effective.ts";
import type { SceneMapSource } from "../mapping/sceneMap.ts";
import { ESTIM_TARGETS, OFF_TARGET } from "../mapping/targets.ts";

/** a device's targets for the picker (DriveFrame devices that name none get every frame part) */
export function targetsFor(device: ToyDevice | undefined): readonly MappingTarget[] {
  if (!device) return [];
  try {
    const t = device.mappingTargets?.();
    if (t && t.length > 0) return t;
  } catch (err) {
    console.error(`[toysync] ${device.kind} mappingTargets failed`, err);
  }
  return isSelfTimed(device) ? [] : ESTIM_TARGETS;
}

export interface TargetGroup {
  /** undefined: ungrouped */
  label: string | undefined;
  targets: MappingTarget[];
}

/** targets grouped by `group`, groups in first-seen order */
export function groupTargets(targets: readonly MappingTarget[]): TargetGroup[] {
  const out: TargetGroup[] = [];
  for (const t of targets) {
    let g = out.find((x) => x.label === t.group);
    if (!g) out.push((g = { label: t.group, targets: [] }));
    g.targets.push(t);
  }
  return out;
}

/** the picker's label of a target id ("Off", the target's label, or the raw id when the device doesn't know it) */
export function targetLabel(id: string, targets: readonly MappingTarget[]): string {
  if (id === OFF_TARGET) return "Off";
  return targets.find((t) => t.id === id)?.label ?? `${id} (unknown)`;
}

/** "stroke (main)" / the channel id */
export function channelLabel(id: string): string {
  return id === STROKE_CHANNEL ? "stroke (main)" : id;
}

export function sourceText(source: SceneMapSource, dirty: boolean): string {
  const base =
    source === "toysync"
      ? "Saved in this scene."
      : source === "tcode"
        ? "Read from TCode Player's tcode_map; Save stores it as toysync_map (tcode_map is kept)."
        : "Using the defaults.";
  return dirty ? `${base} Unsaved changes apply live.` : base;
}

/** the 0..100 number typed into a min / max field, undefined when it isn't one */
export function readPercent(raw: string): number | undefined {
  if (raw.trim() === "") return undefined;
  const n = Number(raw.replace(",", "."));
  if (!Number.isFinite(n)) return undefined;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/** an options value for the read-only key/value list */
export function optionText(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

/** a short summary of a mapping entry for screen readers / titles */
export function mappingSummary(m: ChannelMapping, targets: readonly MappingTarget[]): string {
  if (m.target === OFF_TARGET) return "off";
  const parts = [targetLabel(m.target, targets)];
  if (m.invert) parts.push("inverted");
  if ((m.min ?? 0) !== 0 || (m.max ?? 100) !== 100) parts.push(`${m.min ?? 0}–${m.max ?? 100}`);
  return parts.join(", ");
}

/** the navbar dot: off (nothing connected), connected, live (something outputs) */
export type NavDot = "off" | "connected" | "live";

const OUTPUT_EPSILON = 0.005;

export function navDot(statuses: readonly DeviceStatus[]): NavDot {
  const connected = statuses.filter((s) => s.connection === "connected");
  if (connected.length === 0) return "off";
  const live = connected.some((s) => (s.output?.a ?? 0) > OUTPUT_EPSILON || (s.output?.b ?? 0) > OUTPUT_EPSILON);
  return live ? "live" : "connected";
}

export function navTitle(dot: NavDot, connected: number): string {
  if (dot === "off") return "Toy Sync: no device connected";
  const n = `${connected} device${connected === 1 ? "" : "s"} connected`;
  return dot === "live" ? `Toy Sync: ${n}, outputting` : `Toy Sync: ${n}`;
}
