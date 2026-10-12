// Injectable time and timers (globalThis by default, a fake clock in tests),
// and a listener set. Same pattern as Skilltree's src/gaze/rate.ts. No DOM.

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const GLOBAL_TIMERS: Timers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
};

export function defaultNow(): number {
  return globalThis.performance.now();
}

export interface Listeners<T> {
  add(cb: (v: T) => void): () => void;
  emit(v: T): void;
  clear(): void;
}

/** A set of callbacks; a throwing listener doesn't stop the others. */
export function createListeners<T>(): Listeners<T> {
  const set = new Set<(v: T) => void>();
  return {
    add(cb) {
      set.add(cb);
      return () => {
        set.delete(cb);
      };
    },
    emit(v) {
      for (const cb of [...set]) {
        try {
          cb(v);
        } catch (err) {
          console.error("[lovense] listener failed", err);
        }
      }
    },
    clear() {
      set.clear();
    },
  };
}
