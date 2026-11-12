// A scene's funscript as ScriptChannels: what the scene tab lists and what
// mappings refer to. Pure.
//
// - "stroke" is the main axis (top-level actions, or the L0 axis of a file
//   without them) with the file's `range` applied; its `inverted` flag is
//   kept as a flag, not applied.
// - every embedded axis / channel follows under its id as the parser keys it
//   (lowercased: "volume", "e1", "r1", "snap"); the parser has already
//   applied their per-axis `range` and `inverted`.
import type { ScriptChannel } from "../devices/types.ts";
import type { Funscript } from "../funscript/parse.ts";
import { canonicalAxis } from "../funscript/parse.ts";
import { strokeScript } from "../sync/mapping.ts";

export const STROKE_CHANNEL = "stroke";

export function scriptChannels(f: Funscript | undefined): ScriptChannel[] {
  if (!f) return [];
  const out: ScriptChannel[] = [];
  if (f.actions.length > 0) {
    const s = strokeScript(f);
    const stroke: ScriptChannel = { id: STROKE_CHANNEL, actions: s.actions };
    if (s.inverted) stroke.inverted = true;
    out.push(stroke);
  }
  for (const [id, actions] of f.axes) {
    // the stroke taken from an L0 axis is listed once, as "stroke"
    if (actions === f.actions || id === STROKE_CHANNEL) continue;
    if (actions.length === 0) continue;
    out.push({ id, actions });
  }
  return out;
}

/**
 * The channel a name refers to: the exact id (case-insensitive), else one with
 * the same T-Code id ("roll" finds "r1"); "stroke", "l0", "pos" … find the
 * main stroke.
 */
export function findChannel(channels: readonly ScriptChannel[], name: string): ScriptChannel | undefined {
  const key = name.trim().toLowerCase();
  if (!key) return undefined;
  const exact = channels.find((c) => c.id.toLowerCase() === key);
  if (exact) return exact;
  const id = canonicalAxis(key);
  if (!id) return undefined;
  if (id === "L0") {
    const stroke = channels.find((c) => c.id === STROKE_CHANNEL);
    if (stroke) return stroke;
  }
  return channels.find((c) => canonicalAxis(c.id) === id);
}
