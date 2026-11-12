// What the compact bar under the player shows. Pure, tested.
import type { DeviceEntry } from "../devices/manager.ts";
import type { DeviceStatus } from "../devices/types.ts";
import type { ScriptState } from "../sync/scene.ts";

export type { ScriptState };

const live = (s: DeviceStatus) => s.connection === "connected" || s.connection === "connecting";

/** the bar shows for interactive scenes, and on any scene while a device is connected or connecting */
export function shouldRender(interactive: boolean, entries: readonly DeviceEntry[]): boolean {
  return interactive || entries.some((e) => live(e.status));
}

/** devices connected or connecting, for the bar */
export function liveEntries(entries: readonly DeviceEntry[]): DeviceEntry[] {
  return entries.filter((e) => live(e.status));
}

/** the first connected device that needs calibration, if any */
export function needingCalibration(entries: readonly DeviceEntry[]): DeviceEntry | undefined {
  return entries.find((e) => e.status.connection === "connected" && e.status.needsCalibration === true);
}

/** meter width 0..100 for an output 0..1 */
export function meterPercent(v: number | undefined): number {
  if (v === undefined || !Number.isFinite(v)) return 0;
  return Math.round(Math.max(0, Math.min(1, v)) * 100);
}

/** the muted note about the script, if any */
export function scriptNote(interactive: boolean, state: ScriptState): string | undefined {
  if (!interactive || state === "missing") return "No funscript for this scene: the devices stay off.";
  if (state === "loading") return "Loading the funscript…";
  if (state === "error") return "Couldn't load the funscript: the devices stay off.";
  return undefined;
}

/** "gain 50 %" while other plugins turn it down */
export function gainNote(gain: number): string | undefined {
  if (!(gain < 1)) return undefined;
  return `gain ${Math.round(gain * 100)} %`;
}

/** messages worth showing under the bar: errors always, other messages of live devices */
export function deviceMessages(entries: readonly DeviceEntry[], label: (e: DeviceEntry) => string): { text: string; error: boolean }[] {
  const out: { text: string; error: boolean }[] = [];
  for (const e of entries) {
    const m = e.status.message;
    if (!m) continue;
    if (e.status.connection === "error" || live(e.status)) out.push({ text: `${label(e)}: ${m}`, error: e.status.connection === "error" });
  }
  return out;
}
