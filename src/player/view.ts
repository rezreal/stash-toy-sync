// What the compact control under the player shows. Pure, tested.
import type { LovenseStatus } from "../lovense/device.ts";

export type ScriptState = "none" | "loading" | "ready" | "missing" | "error";

/** the control shows for interactive scenes, and on any scene while a toy is connected or connecting */
export function shouldRender(interactive: boolean, status: LovenseStatus): boolean {
  return interactive || status.connection === "connected" || status.connection === "connecting";
}

/** "Lush · LVS-Lush42", the name alone, or a fallback */
export function deviceLabel(status: LovenseStatus): string {
  const name = status.device;
  const model = status.model;
  if (model && name && !name.toLowerCase().includes(model.toLowerCase())) return `${model} · ${name}`;
  return name || model || "Lovense toy";
}

/** the muted note about the script, if any */
export function scriptNote(interactive: boolean, state: ScriptState): string | undefined {
  if (!interactive || state === "missing") return "No funscript for this scene: the toy stays off.";
  if (state === "loading") return "Loading the funscript…";
  if (state === "error") return "Couldn't load the funscript: the toy stays off.";
  return undefined;
}

/** "gain 50 %" while other plugins turn it down */
export function gainNote(gain: number): string | undefined {
  if (!(gain < 1)) return undefined;
  return `gain ${Math.round(gain * 100)} %`;
}
