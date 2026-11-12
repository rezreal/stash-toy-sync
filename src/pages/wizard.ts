// The calibration wizard's logic, per channel: four levels picked one step
// at a time (First felt, Comfort max, Nudge, Hard max), then review & save.
// The draft survives step changes, back/forward and reloads in
// sessionStorage (the step itself lives in the URL). Pure apart from the
// injectable storage.
import { validateChannel, type LevelRange, type StorageLike } from "../devices/calibration.ts";
import type { Calibration, ChannelCalibration, DeviceKind } from "../devices/types.ts";
import type { Channel, WizardStep } from "./links.ts";

export type LevelStep = 1 | 2 | 3 | 4;
export type Field = keyof ChannelCalibration;

export const STEP_FIELD: Record<LevelStep, Field> = { 1: "firstFelt", 2: "comfortMax", 3: "nudge", 4: "hardMax" };

export interface StepInfo {
  title: string;
  /** what to do in this step */
  help: string;
  /** the probe waveform */
  probe: "steady" | "burst";
}

export const STEP_INFO: Record<LevelStep, StepInfo> = {
  1: {
    title: "First felt",
    help: "Start at the bottom. Hold the button and raise the level step by step until you can just feel it. That level is where the script's softest output starts.",
    probe: "steady",
  },
  2: {
    title: "Comfort max",
    help: "Raise the level until it is as strong as you would like the strongest parts of a scene to be: intense but comfortable for minutes. Scripts never go above it.",
    probe: "steady",
  },
  3: {
    title: "Nudge",
    help: "A nudge is a short, sharp burst other plugins can ask for. Pick a level above Comfort max that feels sharp but OK, then confirm it.",
    probe: "burst",
  },
  4: {
    title: "Hard max",
    help: "The absolute ceiling for this channel: nothing, ever, is sent above it. At least the nudge level. Leaving it at the nudge level is the safe choice.",
    probe: "steady",
  },
};

export interface Draft {
  firstFelt?: number;
  comfortMax?: number;
  nudge?: number;
  hardMax?: number;
  /** the nudge level the user confirmed as "sharp but OK" */
  nudgeConfirmed?: number;
}

export function isLevelStep(step: WizardStep): step is LevelStep {
  return step !== "review";
}

/** the draft to start from: the stored calibration of that channel, else nothing picked yet */
export function initialDraft(stored: ChannelCalibration | undefined): Draft {
  return stored ? { ...stored, nudgeConfirmed: stored.nudge } : {};
}

const clamp = (v: number, r: LevelRange) => Math.max(r.min, Math.min(r.max, Math.round(v)));

/** where a step's level starts when nothing was picked yet: just above the previous step (start low) */
export function startLevel(draft: Draft, step: LevelStep, range: LevelRange): number {
  if (step === 1) return range.min;
  if (step === 2) return clamp(valueFor(draft, 1, range) + 1, range);
  if (step === 3) return clamp(valueFor(draft, 2, range) + 1, range);
  return clamp(valueFor(draft, 3, range), range);
}

/** the level a step shows: the draft's, else the start level; always within the range */
export function valueFor(draft: Draft, step: LevelStep, range: LevelRange): number {
  const v = draft[STEP_FIELD[step]];
  return typeof v === "number" && Number.isFinite(v) ? clamp(v, range) : startLevel(draft, step, range);
}

/** the draft with a step's level set (a changed nudge needs confirming again) */
export function withLevel(draft: Draft, step: LevelStep, level: number, range: LevelRange): Draft {
  const next: Draft = { ...draft, [STEP_FIELD[step]]: clamp(level, range) };
  return next;
}

export function nudgeConfirmed(draft: Draft, range: LevelRange): boolean {
  return draft.nudgeConfirmed !== undefined && draft.nudgeConfirmed === valueFor(draft, 3, range);
}

/** why the step can't be left forward yet, or undefined */
export function stepProblem(draft: Draft, step: LevelStep, range: LevelRange): string | undefined {
  const v = valueFor(draft, step, range);
  if (step === 2 && v <= valueFor(draft, 1, range)) return `Comfort max must be above First felt (${valueFor(draft, 1, range)}).`;
  if (step === 3) {
    if (v <= valueFor(draft, 2, range)) return `The nudge must be above Comfort max (${valueFor(draft, 2, range)}).`;
    if (!nudgeConfirmed(draft, range)) return "Try the burst, then confirm that it feels sharp but OK.";
  }
  if (step === 4 && v < valueFor(draft, 3, range)) return `Hard max must be at least the nudge level (${valueFor(draft, 3, range)}).`;
  return undefined;
}

/** the channel calibration the draft describes (every step at its shown value) */
export function draftChannel(draft: Draft, range: LevelRange): ChannelCalibration {
  return {
    firstFelt: valueFor(draft, 1, range),
    comfortMax: valueFor(draft, 2, range),
    nudge: valueFor(draft, 3, range),
    hardMax: valueFor(draft, 4, range),
  };
}

/** problems before saving: the ordering and range, and the confirmed nudge */
export function reviewProblems(draft: Draft, range: LevelRange): string[] {
  const out = validateChannel(draftChannel(draft, range), range);
  if (out.length === 0 && !nudgeConfirmed(draft, range)) out.push("The nudge level hasn't been confirmed (step 3).");
  return out;
}

/**
 * The calibration to save after reviewing one channel: that channel from the
 * draft, the other kept from the stored calibration. Channel B needs a
 * stored channel A (A comes first).
 */
export function mergeCalibration(
  stored: Calibration | undefined,
  channel: Channel,
  ch: ChannelCalibration,
  updatedAt: string,
): Calibration | undefined {
  if (channel === "a") return stored?.b ? { a: ch, b: stored.b, updatedAt } : { a: ch, updatedAt };
  if (!stored) return undefined;
  return { a: stored.a, b: ch, updatedAt };
}

/** "37 %" of the range */
export function percentOfRange(level: number, range: LevelRange): number {
  const span = range.max - range.min;
  if (!(span > 0)) return 0;
  return Math.round(((level - range.min) / span) * 100);
}

// --- draft storage ----------------------------------------------------------------------

export function draftKey(kind: DeviceKind, id: string, channel: Channel): string {
  return `toysync.calibrationDraft.${kind}.${id}.${channel}`;
}

function defaultSession(): StorageLike | undefined {
  try {
    return globalThis.sessionStorage ?? undefined;
  } catch {
    return undefined;
  }
}

/** the saved draft, undefined when none or unreadable */
export function loadDraft(key: string, storage: StorageLike | undefined = defaultSession()): Draft | undefined {
  try {
    const raw = storage?.getItem(key);
    if (!raw) return undefined;
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (!v || typeof v !== "object") return undefined;
    const out: Draft = {};
    for (const f of ["firstFelt", "comfortMax", "nudge", "hardMax", "nudgeConfirmed"] as const) {
      const n = v[f];
      if (typeof n === "number" && Number.isFinite(n)) out[f] = n;
    }
    return out;
  } catch {
    return undefined;
  }
}

export function saveDraft(key: string, draft: Draft | undefined, storage: StorageLike | undefined = defaultSession()): void {
  try {
    if (draft === undefined) storage?.removeItem(key);
    else storage?.setItem(key, JSON.stringify(draft));
  } catch {
    // only this tab's convenience: the wizard still works without it
  }
}
