// What the devices page shows, as plain data. Pure, tested.
import type { DeviceEntry } from "../devices/manager.ts";
import type { Calibration, ChannelCalibration, DeviceKind, DeviceStatus } from "../devices/types.ts";
import type { AxisTarget } from "../sync/axes.ts";
import type { EffectiveMapping } from "../sync/engine.ts";
import type { Mode, Settings } from "../sync/settings.ts";

export function connectionText(s: DeviceStatus): string {
  switch (s.connection) {
    case "connected":
      return "Connected";
    case "connecting":
      return "Connecting…";
    case "error":
      return "Error";
    default:
      return "Not connected";
  }
}

/** the device instances grouped by kind, in `kinds` order (a kind without instances keeps an empty group) */
export function instanceGroups(kinds: readonly DeviceKind[], entries: readonly DeviceEntry[]): { kind: DeviceKind; entries: DeviceEntry[] }[] {
  return kinds.map((kind) => ({ kind, entries: entries.filter((e) => e.kind === kind) }));
}

function channelText(ch: ChannelCalibration): string {
  return `${ch.firstFelt}–${ch.comfortMax}, nudge ${ch.nudge}, hard max ${ch.hardMax}`;
}

/** "A: 12–40, nudge 55, hard max 60 · B: …" or "Not calibrated" */
export function calibrationSummary(c: Calibration | undefined): string {
  if (!c) return "Not calibrated";
  const parts = [`A: ${channelText(c.a)}`];
  if (c.b) parts.push(`B: ${channelText(c.b)}`);
  return parts.join(" · ");
}

export interface MappingRow {
  target: AxisTarget;
  label: string;
  source: string;
}

const TARGET_LABELS: Record<AxisTarget, string> = {
  intensity: "Intensity",
  balance: "Balance (A ↔ B)",
  speed: "Speed (e-stim frequency)",
  a: "Channel A",
  b: "Channel B",
};

function strokeSource(target: AxisTarget, mode: Mode): string {
  if (target === "intensity") return mode === "position" ? "stroke depth (position mode)" : "stroke speed (speed mode)";
  if (target === "balance") return "stroke depth (out = A, deep = B)";
  if (target === "speed") return "stroke speed";
  return "stroke";
}

/** one row per target: which axis (or the stroke) feeds it for the scene's script */
export function mappingRows(m: EffectiveMapping, mode: Mode): MappingRow[] {
  const targets: AxisTarget[] = ["intensity", "balance", "speed", "a", "b"];
  return targets.map((target) => {
    const src = m.targets[target];
    let source: string;
    if (src === undefined) {
      source =
        target === "a" || target === "b"
          ? "— (intensity × balance)"
          : target === "intensity"
            ? "strongest of channel A / B"
            : target === "balance"
              ? "— (even, 0.5)"
              : "— (slowest)";
    } else if (src === "stroke") {
      source = strokeSource(target, mode);
    } else {
      source = `axis “${src}”`;
    }
    return { target, label: TARGET_LABELS[target], source };
  });
}

/** the settings as label/value pairs */
export function settingsRows(s: Settings): [string, string][] {
  return [
    ["Mode", s.mode],
    ["Full-power speed", `${s.speedFull} units/s`],
    ["Latency compensation", `${s.latencyMs} ms`],
    ["Invert position mode", s.invert ? "on" : "off"],
    ["Snap pulses", s.snapPulse ? "on" : "off"],
    ["Axis mapping", s.axisMap || "auto-detect"],
    ["Nudges", s.nudgesPerMinute === 0 ? "off" : `at most 1 per ${s.nudgeCooldownSec} s and ${s.nudgesPerMinute} per minute`],
    ["E-stim frequency range", `${s.estimSpeedMinHz}–${s.estimSpeedMaxHz} Hz`],
    ["Lovense strength", `${s.strength} %`],
    ["Lovense minimum level", String(s.minLevel)],
    ["Lovense name filter", s.namePrefix || "—"],
  ];
}
