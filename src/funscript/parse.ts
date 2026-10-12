// Funscript parsing, single- and multi-axis. Same container conventions as
// the funscript-axis-router plugin (see its README, "Script formats"):
//
// - v1.0: top-level `actions` only, i.e. the stroke axis alone
// - v1.1: `axes: [{ id | axis | name, actions, inverted?, range? }, ...]`
// - v2.0: `channels: { <name>: { actions, inverted?, range? } | actions[] }`
//
// A file carrying the same axis in both containers collapses to one (the
// first seen wins: axes before channels). Lenient throughout: malformed
// actions are skipped, positions clamped to 0..100, actions sorted by time.
// Pure and DOM-free.

export interface Action {
  /** milliseconds from the start of the video */
  at: number;
  /** 0..100 */
  pos: number;
}

export interface Funscript {
  /** main stroke axis, sorted by `at`; raw positions, see `inverted` / `range` */
  actions: Action[];
  /** the main axis is meant to be flipped (100 - pos); kept as a flag, not applied */
  inverted?: boolean;
  /** the main axis' full-scale value when it isn't 100; kept, not applied */
  range?: number;
  /**
   * Extra axes keyed by their lowercased name as the file spells it ("snap",
   * "roll", "r1"). Per-axis `range` and `inverted` are applied here, since an
   * Action[] has nowhere to carry them.
   */
  axes: Map<string, Action[]>;
}

// Canonical T-Code ids by alias, same table as the axis router. Only used to
// recognise the stroke axis and to let findAxis match "roll" against "R1".
const AXIS_ALIASES: Record<string, string> = {
  l0: "L0", stroke: "L0", pos: "L0", position: "L0",
  l1: "L1", surge: "L1",
  l2: "L2", sway: "L2",
  r0: "R0", twist: "R0",
  r1: "R1", roll: "R1",
  r2: "R2", pitch: "R2",
  a0: "A0", valve: "A0",
  a1: "A1", suck: "A1",
  a2: "A2", lube: "A2",
};

const STROKE_AXIS = "L0";

/** T-Code id for a known axis name ("roll" -> "R1"), undefined otherwise. */
export function canonicalAxis(key: string): string | undefined {
  return AXIS_ALIASES[key.toLowerCase()];
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

const clampPos = (p: number) => (p < 0 ? 0 : p > 100 ? 100 : p);

/** valid actions only, sorted by time; `normalise` maps raw pos before clamping */
function readActions(raw: unknown, normalise: (pos: number) => number = (p) => p): Action[] {
  if (!Array.isArray(raw)) return [];
  const out: Action[] = [];
  for (const a of raw) {
    if (!isObj(a)) continue;
    const at = a.at;
    const pos = a.pos;
    if (typeof at !== "number" || typeof pos !== "number" || !Number.isFinite(at) || !Number.isFinite(pos)) continue;
    if (at < 0) continue;
    out.push({ at, pos: clampPos(normalise(pos)) });
  }
  // stable sort keeps the file's order for equal timestamps
  return out.sort((x, y) => x.at - y.at);
}

function readRange(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
}

function readInverted(v: unknown): boolean {
  return v === true || v === "true";
}

/** an axis node is `{ actions, inverted?, range? }` or a bare actions array */
function readAxisNode(node: unknown): Action[] {
  if (Array.isArray(node)) return readActions(node);
  if (!isObj(node)) return [];
  const range = readRange(node.range) ?? 100;
  const inverted = readInverted(node.inverted);
  return readActions(node.actions, (pos) => {
    const p = (pos / range) * 100;
    return inverted ? 100 - p : p;
  });
}

export function parseFunscript(json: unknown): Funscript {
  const root: Obj = isObj(json) ? json : {};
  const axes = new Map<string, Action[]>();
  const seenCanonical = new Set<string>();

  const add = (rawKey: unknown, node: unknown) => {
    if (typeof rawKey !== "string" && typeof rawKey !== "number") return;
    const key = String(rawKey).trim().toLowerCase();
    if (!key) return;
    const id = canonicalAxis(key);
    if (axes.has(key) || (id && seenCanonical.has(id))) return;
    const actions = readAxisNode(node);
    if (actions.length === 0) return;
    axes.set(key, actions);
    if (id) seenCanonical.add(id);
  };

  if (Array.isArray(root.axes)) {
    for (const a of root.axes) {
      if (isObj(a)) add(a.id ?? a.axis ?? a.name, a);
    }
  }
  if (isObj(root.channels)) {
    for (const [k, v] of Object.entries(root.channels)) add(k, v);
  }

  const out: Funscript = { actions: readActions(root.actions), axes };
  if (readInverted(root.inverted)) out.inverted = true;
  const range = readRange(root.range);
  if (range !== undefined) out.range = range;

  // a multi-axis file without top-level actions may carry stroke as an axis
  if (out.actions.length === 0) {
    for (const [k, v] of axes) {
      if (canonicalAxis(k) === STROKE_AXIS) {
        out.actions = v;
        break;
      }
    }
  }
  return out;
}

/**
 * First axis matching one of `names` (case-insensitive), in the order given.
 * A name also matches an axis with the same T-Code id ("roll" finds "r1").
 * For snaps: findAxis(f, ["snap", "snaps"]).
 */
export function findAxis(f: Funscript, names: string[]): Action[] | undefined {
  for (const name of names) {
    const key = name.trim().toLowerCase();
    const direct = f.axes.get(key);
    if (direct) return direct;
    const id = canonicalAxis(key);
    if (!id) continue;
    for (const [k, v] of f.axes) if (canonicalAxis(k) === id) return v;
  }
  return undefined;
}
