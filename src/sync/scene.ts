// Which scene the player has open (for the nudge rule "never without a
// scene") and what the last one was (for the devices page's mapping view).
// The player slot reports it; pure, no DOM.
import type { EffectiveMapping } from "./engine.ts";

export type ScriptState = "none" | "loading" | "ready" | "missing" | "error";

export interface SceneInfo {
  id: string;
  title?: string;
  interactive: boolean;
  scriptState: ScriptState;
  /** what drives what, once the script is loaded */
  mapping?: EffectiveMapping;
}

export interface SceneTracker {
  /** the scene open in the player right now */
  open(): SceneInfo | undefined;
  /** the open scene, else the last one that was open */
  last(): SceneInfo | undefined;
  /** the player opened / updated a scene (undefined = the player closed) */
  set(info: SceneInfo | undefined): void;
  onChange(cb: () => void): () => void;
}

export function createSceneTracker(): SceneTracker {
  let open: SceneInfo | undefined;
  let last: SceneInfo | undefined;
  let key = "";
  const listeners = new Set<() => void>();
  return {
    open: () => open,
    last: () => open ?? last,
    set(info) {
      const k = JSON.stringify(info ?? null);
      if (k === key) return;
      key = k;
      open = info;
      if (info) last = info;
      for (const cb of [...listeners]) {
        try {
          cb();
        } catch (err) {
          console.error("[toysync] scene listener failed", err);
        }
      }
    },
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}
