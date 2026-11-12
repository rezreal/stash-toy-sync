// Lazy loader for the 3D preview, osr-emu 0.7.0 (MIT, ayvajs; bundles three.js,
// MIT), vendored unmodified in plugin/vendor/ and served by stash at
// /plugin/toysync/assets/vendor/… (ui.assets in toysync.yml). ~8 MB, so it is
// only fetched when a preview is first shown, and only once.
//
// The non-module dist copies its exports onto window (OSREmulator, default)
// and defines a non-configurable window.__esModule. Keep only OSREmulator so
// other plugins' scripts don't see stray globals.
import { stashUrl } from "../stash/url.ts";
import type { Emulator } from "./engine.ts";

export const EMU_ASSET = "plugin/toysync/assets/vendor/osr-emu.dist.min.js";

export interface EmulatorOptions {
  model: "OSR2" | "SR6" | "SSR1";
}
export type EmulatorCtor = new (element: unknown, options: EmulatorOptions) => Emulator & { destroy(): void };

interface ScriptEl {
  src: string;
  async: boolean;
  onload: (() => void) | null;
  onerror: (() => void) | null;
  remove(): void;
}

export interface LoaderEnv {
  window: Record<string, unknown>;
  document: { createElement(tag: "script"): unknown; head: { appendChild(el: unknown): unknown } };
  /** default: the vendored dist under stash's base URL */
  src?: string;
}

const loading = new WeakMap<object, Promise<EmulatorCtor>>();

export function emulatorUrl(): string {
  return stashUrl(EMU_ASSET);
}

/** Loads the emulator bundle once per window and resolves window.OSREmulator. */
export function loadEmulator(env?: LoaderEnv): Promise<EmulatorCtor> {
  const win = env?.window ?? (globalThis as unknown as Record<string, unknown>);
  const doc = env?.document ?? (globalThis as unknown as { document: LoaderEnv["document"] }).document;
  if (typeof win.OSREmulator === "function") return Promise.resolve(win.OSREmulator as EmulatorCtor);
  const pending = loading.get(win);
  if (pending) return pending;
  const p = new Promise<EmulatorCtor>((resolve, reject) => {
    const hadDefault = "default" in win, prevDefault = win.default;
    const hadEsModule = "__esModule" in win;
    if (!hadEsModule) {
      try {
        Object.defineProperty(win, "__esModule", { value: undefined, configurable: true, writable: true });
      } catch {
        /* ignore */
      }
    }
    const tidy = () => {
      try {
        if (hadDefault) win.default = prevDefault;
        else delete win.default;
      } catch {
        /* ignore */
      }
      try {
        if (!hadEsModule) delete win.__esModule;
      } catch {
        /* ignore */
      }
    };
    const el = doc.createElement("script") as ScriptEl;
    el.src = env?.src ?? emulatorUrl();
    el.async = true;
    el.onload = () => {
      tidy();
      if (typeof win.OSREmulator === "function") resolve(win.OSREmulator as EmulatorCtor);
      else reject(new Error("3D preview failed to initialise"));
    };
    el.onerror = () => {
      tidy();
      loading.delete(win);
      el.remove();
      reject(new Error("Could not load the 3D preview files"));
    };
    doc.head.appendChild(el);
  });
  loading.set(win, p);
  return p;
}
