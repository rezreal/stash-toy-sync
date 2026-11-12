// Nudge requests from other plugins ("toysync:nudge") pass this limiter
// before reaching the devices. However often it is asked, it lets through:
// - nothing while no scene is open in the player,
// - at most one nudge per cooldown (default 4 s, never below 2 s),
// - at most N nudges in any rolling minute (default 6, never above 10;
//   0 = nudges off).
// Dropped requests are never queued or replayed: a nudge is a moment, not a
// debt. Only accepted nudges count towards the limits. Time is injected.
import { NUDGE_COOLDOWN_MIN_SEC, NUDGES_PER_MINUTE_MAX } from "./settings.ts";

export type NudgeDrop = "no-scene" | "disabled" | "cooldown" | "rate";

export type NudgeDecision = { ok: true } | { ok: false; dropped: NudgeDrop };

export interface NudgeLimits {
  cooldownMs: number;
  perMinute: number;
}

export interface NudgeLimiter {
  /** decides one request now; an accepted one counts towards the limits */
  request(sceneOpen: boolean): NudgeDecision;
  setLimits(l: NudgeLimits): void;
  limits(): NudgeLimits;
}

export const MINUTE_MS = 60_000;
export const DEFAULT_NUDGE_LIMITS: NudgeLimits = { cooldownMs: 4000, perMinute: 6 };

/** the hard bounds, whatever the settings say */
export function clampLimits(l: NudgeLimits): NudgeLimits {
  const cooldownMs = Number.isFinite(l.cooldownMs) ? Math.max(NUDGE_COOLDOWN_MIN_SEC * 1000, l.cooldownMs) : DEFAULT_NUDGE_LIMITS.cooldownMs;
  const perMinute = Number.isFinite(l.perMinute) ? Math.max(0, Math.min(NUDGES_PER_MINUTE_MAX, Math.floor(l.perMinute))) : DEFAULT_NUDGE_LIMITS.perMinute;
  return { cooldownMs, perMinute };
}

export function createNudgeLimiter(now: () => number, initial: NudgeLimits = DEFAULT_NUDGE_LIMITS): NudgeLimiter {
  let limits = clampLimits(initial);
  /** times of accepted nudges within the last minute */
  let accepted: number[] = [];

  return {
    request(sceneOpen) {
      if (!sceneOpen) return { ok: false, dropped: "no-scene" };
      if (limits.perMinute <= 0) return { ok: false, dropped: "disabled" };
      const t = now();
      accepted = accepted.filter((at) => t - at < MINUTE_MS);
      const lastAt = accepted.at(-1);
      if (lastAt !== undefined && t - lastAt < limits.cooldownMs) return { ok: false, dropped: "cooldown" };
      if (accepted.length >= limits.perMinute) return { ok: false, dropped: "rate" };
      accepted.push(t);
      return { ok: true };
    },
    setLimits(l) {
      limits = clampLimits(l);
    },
    limits: () => limits,
  };
}
