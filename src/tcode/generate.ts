// Generated axes: when a script only has a stroke, make up the missing axes
// from it. Everything is derived from the stroke and calculated once per
// script, so it is the same every time, shows in the 3D preview, and stops
// when the stroke stops. Ideas from MultiFunPlayer's motion providers (MIT),
// driven by stroke travel instead of wall time. Ported unchanged from TCode
// Player (including "Make follow lean fully on densely sampled scripts").
import { clamp, defaultEntry, GENERATE_LEVELS, isLevel, type Action, type Channel, type Profile } from "./core.ts";

export { GENERATE_LEVELS };

interface Generator {
  name: string;
  kind: "follow" | "noise" | "speed";
  gain?: number;
  /** noise cycles per full-range stroke */
  rate?: number;
  seed?: number;
  vibe?: boolean;
}

// which pattern fills which channel; gain scales the level, rate = noise cycles per full-range stroke
const GENERATORS: readonly Generator[] = [
  { name: "pitch", kind: "follow", gain: 1 },
  { name: "roll", kind: "noise", gain: 1, rate: 0.5, seed: 1 },
  { name: "twist", kind: "noise", gain: 1, rate: 0.35, seed: 2 },
  { name: "surge", kind: "follow", gain: 0.5 },
  { name: "sway", kind: "noise", gain: 0.5, rate: 0.35, seed: 3 },
  { name: "vib", kind: "speed", vibe: true },
];

function hashString(s: string): number {
  let x = 2166136261;
  for (let i = 0; i < s.length; i++) x = Math.imul(x ^ s.charCodeAt(i), 16777619);
  return x >>> 0;
}

/** Deterministic value in [-1, 1] for lattice point i. */
function latticeValue(i: number, seed: number): number {
  let x = Math.imul(i | 0, 374761393) ^ Math.imul(seed | 0, 668265263);
  x = Math.imul(x ^ (x >>> 13), 1274126177);
  x ^= x >>> 16;
  return ((x >>> 0) / 4294967295) * 2 - 1;
}

/** Smooth 1D value noise, two octaves, roughly [-1, 1]. */
export function noise1(u: number, seed: number): number {
  const oct = (v: number, sd: number) => {
    const i = Math.floor(v), f = v - i, w = f * f * (3 - 2 * f);
    return latticeValue(i, sd) + (latticeValue(i + 1, sd) - latticeValue(i, sd)) * w;
  };
  return clamp(((oct(u, seed) + 0.5 * oct(u * 2.03 + 17.3, seed + 101)) / 1.5) * 1.6, -1, 1);
}

const FOLLOW_MIN_SWING = 5; // reversals smaller than this (% of range) are jitter, not a new stroke

/** Indexes of the stroke's turning points, first and last action included, ignoring small jitter. */
function turningPoints(acts: readonly Action[]): number[] {
  const idx = [0];
  let ext = 0, dir = 0; // candidate extreme of the current stroke and its direction (0 = not moving yet)
  for (let i = 1; i < acts.length; i++) {
    const d = acts[i]!.pos - acts[ext]!.pos;
    if (dir === 0) {
      if (Math.abs(d) >= FOLLOW_MIN_SWING) {
        dir = Math.sign(d);
        ext = i;
      }
    } else if (d * dir > 0) {
      ext = i; // further the same way (strictly, so a hold keeps its first point)
    } else if (-d * dir >= FOLLOW_MIN_SWING) {
      idx.push(ext); // turned back far enough: the candidate was a turning point
      dir = -dir;
      ext = i;
    }
  }
  if (ext !== idx[idx.length - 1]) idx.push(ext);
  if (idx[idx.length - 1] !== acts.length - 1) idx.push(acts.length - 1);
  return idx;
}

/**
 * Follow: leans one way while the stroke goes up and the other way while it goes down - roughly the
 * stroke a quarter cycle on. The lean depends on where the stroke is within its current stroke:
 * none at the turning points, most at the middle, so it holds whenever the stroke holds, bigger
 * strokes lean further, and it never moves faster than amp x the stroke's own speed. Works the
 * same for sparse hand-made scripts and densely sampled ones.
 */
function genFollow(acts: readonly Action[], amp: number): Action[] {
  const tp = turningPoints(acts);
  const out: Action[] = [{ at: acts[0]!.at, pos: 50 }];
  for (let k = 0; k + 1 < tp.length; k++) {
    const i0 = tp[k]!, i1 = tp[k + 1]!;
    const from = acts[i0]!.pos, span = acts[i1]!.pos - from, mid = from + span / 2;
    const lean = (p: number) => {
      if (!span) return 50;
      const u = clamp((p - from) / span, 0, 1);
      return 50 + amp * span * Math.min(u, 1 - u);
    };
    for (let j = i0; j < i1; j++) {
      const a = acts[j]!, b = acts[j + 1]!;
      if (j > i0) out.push({ at: a.at, pos: lean(a.pos) });
      // the stroke passes the middle inside this segment: that is the peak of the lean
      if ((a.pos - mid) * (b.pos - mid) < 0) {
        out.push({ at: a.at + ((b.at - a.at) * (mid - a.pos)) / (b.pos - a.pos), pos: lean(mid) });
      }
    }
    out.push({ at: acts[i1]!.at, pos: lean(acts[i1]!.pos) });
  }
  return out;
}

/**
 * Noise: wanders smoothly, but its clock is the distance the stroke has travelled, so it moves
 * faster when the stroke is busy and freezes during holds. Swings less near the stroke's ends.
 */
function genNoise(acts: readonly Action[], amp: number, rate: number, seed: number): Action[] {
  const val = (u: number, s: number) => {
    const edge = (s - 50) / 50;
    return clamp(50 + amp * 50 * noise1(u, seed) * (1 - 0.5 * edge * edge), 0, 100);
  };
  const out: Action[] = [{ at: acts[0]!.at, pos: val(0, acts[0]!.pos) }];
  let u = 0;
  for (let i = 0; i + 1 < acts.length; i++) {
    const a = acts[i]!, b = acts[i + 1]!;
    const du = (Math.abs(b.pos - a.pos) / 100) * rate;
    const steps = Math.max(1, Math.ceil(du * 4));
    for (let k = 1; k <= steps; k++) {
      const f = k / steps;
      out.push({ at: a.at + (b.at - a.at) * f, pos: val(u + du * f, a.pos + (b.pos - a.pos) * f) });
    }
    u += du;
  }
  return out;
}

/** Speed: intensity follows how fast the stroke moves, relative to this script's busy parts. */
function genSpeed(acts: readonly Action[], ceiling: number): Action[] {
  const n = acts.length;
  const speeds: number[] = [];
  for (let i = 0; i + 1 < n; i++) {
    const dt = acts[i + 1]!.at - acts[i]!.at;
    speeds.push(dt > 0 ? (Math.abs(acts[i + 1]!.pos - acts[i]!.pos) / dt) * 1000 : 0);
  }
  const moving = speeds.filter((v) => v > 0).sort((x, y) => x - y);
  if (!moving.length) return [];
  const ref = Math.max(50, moving[Math.floor((moving.length - 1) * 0.9)]!); // 90th percentile = full
  const raw = speeds.map((v) => clamp(v / ref, 0, 1));
  const lvl = raw.map((v, i) => ((raw[i - 1] != null ? raw[i - 1]! : v) + 2 * v + (raw[i + 1] != null ? raw[i + 1]! : v)) / 4);
  const out: Action[] = [{ at: acts[0]!.at, pos: 0 }];
  for (let i = 0; i + 1 < n; i++) {
    const a = acts[i]!, b = acts[i + 1]!;
    const pos = 100 * ceiling * (raw[i] ? lvl[i]! : 0);
    if (b.at - a.at > 1000) {
      // long segments (holds, slow moves) settle to their own level instead of a slow ramp
      out.push({ at: a.at + 250, pos }, { at: b.at - 250, pos });
    } else if (b.at > a.at) {
      out.push({ at: (a.at + b.at) / 2, pos });
    }
  }
  out.push({ at: acts[n - 1]!.at + 300, pos: 0 });
  return out;
}

/** The stroke channel generation works from: "stroke", else whatever maps to L0 by default. */
export function strokeChannel(channels: readonly Channel[], profile: Profile): Channel | null {
  return channels.find((c) => c.name === "stroke") || channels.find((c) => defaultEntry(c.name, profile).axis === "L0") || null;
}

/**
 * Channels to add for the axes a script doesn't cover. Only fills axes the device has enabled and
 * no script channel targets; vibration only with profile.generateVibe.
 */
export function generateChannels(scriptChannels: readonly Channel[], profile: Profile, level: unknown, seedKey?: unknown): Channel[] {
  const lv = isLevel(level) ? GENERATE_LEVELS[level] : null;
  if (!lv) return [];
  const stroke = strokeChannel(scriptChannels, profile);
  if (!stroke || stroke.actions.length < 2) return [];
  const acts = stroke.inverted ? stroke.actions.map((a) => ({ at: a.at, pos: 100 - a.pos })) : stroke.actions;
  const taken = new Set<string>();
  for (const c of scriptChannels) {
    taken.add(c.name);
    taken.add(defaultEntry(c.name, profile).axis);
  }
  const seed = hashString(String(seedKey || ""));
  const out: Channel[] = [];
  for (const g of GENERATORS) {
    const axis = defaultEntry(g.name, profile).axis;
    if (axis === "off" || taken.has(g.name) || taken.has(axis)) continue;
    const ax = profile.axes[axis as keyof Profile["axes"]];
    if (!ax || !ax.enabled) continue;
    if (g.vibe && !profile.generateVibe) continue;
    let actions: Action[];
    if (g.kind === "follow") actions = genFollow(acts, lv.motion * g.gain!);
    else if (g.kind === "noise") actions = genNoise(acts, lv.motion * g.gain!, g.rate!, (seed + g.seed!) | 0);
    else actions = genSpeed(acts, lv.vibe);
    if (!actions.length) continue;
    taken.add(axis);
    out.push({ name: g.name, actions, inverted: false, source: "generated" });
  }
  return out;
}
