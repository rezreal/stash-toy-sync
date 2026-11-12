// Gain from other plugins: each source (e.g. "skilltree") sets a factor in
// 0..1 with a "toysync:gain" event (or the legacy "lovense:gain"); the effective gain is the product of all
// present factors (1 when there are none). A null gain removes the source.
// See README.md, "Hook contract". DOM-free apart from the event shape.
import { createListeners } from "../util/timers.ts";

export const GAIN_EVENT = "toysync:gain";
/** the Lovense Sync 0.1 name, still accepted */
export const LEGACY_GAIN_EVENT = "lovense:gain";

export interface GainDetail {
  source: string;
  gain: number | null;
}

export interface GainCombiner {
  /** sets (or with null removes) a source's factor; false when the input was invalid */
  set(source: unknown, gain: unknown): boolean;
  /** product of all factors, 1 when none */
  gain(): number;
  sources(): ReadonlyMap<string, number>;
  onChange(cb: (gain: number) => void): () => void;
}

export function createGainCombiner(): GainCombiner {
  const gains = new Map<string, number>();
  const listeners = createListeners<number>();
  let product = 1;

  function recompute(): void {
    let p = 1;
    for (const g of gains.values()) p *= g;
    const changed = p !== product;
    product = p;
    if (changed) listeners.emit(p);
  }

  return {
    set(source, gain) {
      if (typeof source !== "string" || source.trim() === "") return false;
      const key = source.trim();
      if (gain === null) {
        if (gains.delete(key)) recompute();
        return true;
      }
      if (typeof gain !== "number" || !Number.isFinite(gain)) return false;
      gains.set(key, gain < 0 ? 0 : gain > 1 ? 1 : gain);
      recompute();
      return true;
    },
    gain: () => product,
    sources: () => gains,
    onChange: (cb) => listeners.add(cb),
  };
}

export interface EventTargetLike {
  addEventListener(type: string, listener: (e: Event) => void): void;
  removeEventListener(type: string, listener: (e: Event) => void): void;
}

/** applies every "toysync:gain" (and legacy "lovense:gain") event on `target` to the combiner; returns an unsubscribe */
export function listenGainEvents(target: EventTargetLike, combiner: GainCombiner): () => void {
  const onGain = (e: Event) => {
    const detail = (e as CustomEvent<Partial<GainDetail> | undefined>).detail;
    if (!detail || typeof detail !== "object") return;
    combiner.set(detail.source, detail.gain === undefined ? undefined : detail.gain);
  };
  target.addEventListener(GAIN_EVENT, onGain);
  target.addEventListener(LEGACY_GAIN_EVENT, onGain);
  return () => {
    target.removeEventListener(GAIN_EVENT, onGain);
    target.removeEventListener(LEGACY_GAIN_EVENT, onGain);
  };
}
