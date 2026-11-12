// Multi-axis scripts: which embedded funscript axis drives which part of the
// DriveFrame. Pure and DOM-free.
//
// The `axisMap` setting maps axis ids to targets, e.g.
//   "volume=intensity, alpha=balance, e1=a, e2=b, pulse_frequency=speed"
// (entries separated by commas, semicolons or new lines; "id=target" or
// "id:target"; case-insensitive). When it is empty the built-in
// auto-detection applies:
//   volume -> intensity, alpha -> balance, e1 / a / channel_a -> a,
//   e2 / b / channel_b -> b, pulse_frequency / frequency -> speed.
// A non-empty axisMap replaces auto-detection entirely. An entry naming an
// axis the script doesn't have is ignored (that target falls back to the
// stroke). The first axis mapped to a target wins.
import type { Action, Funscript } from "../funscript/parse.ts";
import { canonicalAxis, findAxis } from "../funscript/parse.ts";

export type AxisTarget = "intensity" | "balance" | "speed" | "a" | "b";
export const AXIS_TARGETS: readonly AxisTarget[] = ["intensity", "balance", "speed", "a", "b"];

export interface AxisMapEntry {
  axis: string;
  target: AxisTarget;
}

export interface ParsedAxisMap {
  entries: AxisMapEntry[];
  /** entries that couldn't be read, as messages */
  problems: string[];
}

/** auto-detection: target -> axis ids it looks for, in order */
export const AUTO_AXES: Record<AxisTarget, readonly string[]> = {
  intensity: ["volume"],
  balance: ["alpha"],
  speed: ["pulse_frequency", "frequency"],
  a: ["e1", "a", "channel_a"],
  b: ["e2", "b", "channel_b"],
};

const TARGET_ALIASES: Record<string, AxisTarget> = {
  intensity: "intensity",
  volume: "intensity",
  balance: "balance",
  speed: "speed",
  frequency: "speed",
  a: "a",
  b: "b",
};

/** reads the axisMap setting; unknown targets and malformed entries become problems */
export function parseAxisMap(raw: string | undefined): ParsedAxisMap {
  const entries: AxisMapEntry[] = [];
  const problems: string[] = [];
  for (const part of (raw ?? "").split(/[,;\n]/)) {
    const text = part.trim();
    if (!text) continue;
    const m = /^([^=:]+)[=:](.*)$/.exec(text);
    if (!m) {
      problems.push(`“${text}” isn't axis=target.`);
      continue;
    }
    const axis = m[1]!.trim().toLowerCase();
    const targetRaw = m[2]!.trim().toLowerCase();
    const target = TARGET_ALIASES[targetRaw];
    if (!axis) {
      problems.push(`“${text}” names no axis.`);
      continue;
    }
    if (!target) {
      problems.push(`“${text}”: the target must be one of ${AXIS_TARGETS.join(", ")}.`);
      continue;
    }
    entries.push({ axis, target });
  }
  return { entries, problems };
}

/** one resolved axis feeding a target */
export interface MappedAxis {
  /** the axis id as found in the script (lowercased) */
  axis: string;
  /** positions 0..100 (per-axis range / inverted already applied by the parser) */
  actions: Action[];
}

export type ResolvedAxes = Partial<Record<AxisTarget, MappedAxis>>;

function lookup(f: Funscript, id: string): MappedAxis | undefined {
  const key = id.trim().toLowerCase();
  const hit = findAxis(f, [key]);
  if (hit && hit.length > 0) {
    // report the name as the script spells it
    let name = key;
    for (const [k, v] of f.axes) if (v === hit) name = k;
    return { axis: name, actions: hit };
  }
  // the main stroke axis can be mapped too ("stroke=speed")
  if (canonicalAxis(key) === "L0" && f.actions.length > 0) return { axis: key, actions: f.actions };
  return undefined;
}

/**
 * Which axis drives which target for this script: the axisMap entries when
 * there are any, else auto-detection. Targets without an axis are absent
 * (they fall back to the stroke).
 */
export function resolveAxes(f: Funscript, entries: readonly AxisMapEntry[]): ResolvedAxes {
  const out: ResolvedAxes = {};
  if (entries.length > 0) {
    for (const e of entries) {
      if (out[e.target]) continue;
      const hit = lookup(f, e.axis);
      if (hit) out[e.target] = hit;
    }
    return out;
  }
  for (const target of AXIS_TARGETS) {
    for (const id of AUTO_AXES[target]) {
      const actions = f.axes.get(id);
      if (actions && actions.length > 0) {
        out[target] = { axis: id, actions };
        break;
      }
    }
  }
  return out;
}

/** "volume → intensity, e1 → a" for display; "" when nothing is mapped */
export function describeAxes(axes: ResolvedAxes): string {
  return AXIS_TARGETS.filter((t) => axes[t])
    .map((t) => `${axes[t]!.axis} → ${t}`)
    .join(", ");
}
