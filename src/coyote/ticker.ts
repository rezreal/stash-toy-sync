// The 100 ms packet clock. Background tabs throttle setTimeout/setInterval
// to about once a second, which would starve the Coyote (each packet is
// good for 100 ms), but timers inside a Web Worker keep running. So the
// clock is a tiny worker built from a Blob (stash's CSP allows worker-src
// blob:) that posts a message per tick; without Worker (tests, very old
// browsers) or when it fails, the injected timers do the job.
import type { Timers } from "../util/timers.ts";

export interface Ticker {
  /** starts (or restarts, re-phasing) ticking every interval; the first tick comes one interval from now */
  start(): void;
  stop(): void;
  running(): boolean;
  /** stops and releases the worker */
  dispose(): void;
}

/** the parts of a Worker the ticker uses */
export interface WorkerLike {
  postMessage(msg: unknown): void;
  terminate(): void;
  onmessage: ((e: { data: unknown }) => void) | null;
  onerror: ((e: unknown) => void) | null;
}
export type WorkerCtor = new (url: string) => WorkerLike;

export const WORKER_SOURCE =
  "let h;onmessage=function(e){if(h!==undefined)clearInterval(h);h=undefined;" +
  "var ms=+e.data;if(ms>0)h=setInterval(function(){postMessage(0)},ms)};";

/** ticks from the injected timers (a setTimeout chain) */
export function createTimerTicker(onTick: () => void, intervalMs: number, timers: Timers): Ticker {
  let handle: unknown;
  let on = false;
  const schedule = () => {
    handle = timers.setTimeout(() => {
      handle = undefined;
      if (!on) return;
      schedule();
      onTick();
    }, intervalMs);
  };
  const stop = () => {
    on = false;
    if (handle !== undefined) timers.clearTimeout(handle);
    handle = undefined;
  };
  return {
    start() {
      stop();
      on = true;
      schedule();
    },
    stop,
    running: () => on,
    dispose: stop,
  };
}

export interface TickerOptions {
  timers: Timers;
  /** the Worker constructor; default globalThis.Worker; null = never use a worker */
  worker?: WorkerCtor | null;
  createObjectURL?: (b: Blob) => string;
  revokeObjectURL?: (url: string) => void;
}

/** ticks from a Blob worker when possible, else from the timers */
export function createTicker(onTick: () => void, intervalMs: number, opts: TickerOptions): Ticker {
  const fallback = createTimerTicker(onTick, intervalMs, opts.timers);
  const Ctor = opts.worker === null ? undefined : (opts.worker ?? (globalThis as { Worker?: WorkerCtor }).Worker);
  const createUrl = opts.createObjectURL ?? (typeof URL !== "undefined" ? URL.createObjectURL?.bind(URL) : undefined);
  const revokeUrl = opts.revokeObjectURL ?? (typeof URL !== "undefined" ? URL.revokeObjectURL?.bind(URL) : undefined);
  if (typeof Ctor !== "function" || typeof createUrl !== "function" || typeof Blob !== "function") return fallback;

  let worker: WorkerLike | undefined;
  let url: string | undefined;
  try {
    url = createUrl(new Blob([WORKER_SOURCE], { type: "text/javascript" }));
    worker = new Ctor(url);
  } catch {
    if (url) revokeUrl?.(url);
    return fallback;
  }
  let on = false;
  let broken = false;
  const w = worker;
  w.onmessage = () => {
    if (on && !broken) onTick();
  };
  w.onerror = () => {
    // e.g. a CSP that forbids blob: workers: carry on with the timers
    if (broken) return;
    broken = true;
    try {
      w.terminate();
    } catch {
      // gone already
    }
    if (on) fallback.start();
  };
  return {
    start() {
      on = true;
      if (broken) fallback.start();
      else w.postMessage(intervalMs);
    },
    stop() {
      on = false;
      fallback.stop();
      if (!broken) w.postMessage(0);
    },
    running: () => on,
    dispose() {
      on = false;
      fallback.dispose();
      try {
        w.terminate();
      } catch {
        // gone already
      }
      if (url) revokeUrl?.(url);
      url = undefined;
    },
  };
}
