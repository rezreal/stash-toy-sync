// Sends the wanted vibration level to the toy without flooding it.
//
// - Only a change is sent: setting the level the toy already has does nothing.
// - At most one write every minIntervalMs (default 100 ms). Levels set in
//   between are coalesced: when the window opens, the latest one is sent.
// - Writes never overlap: the next one starts after the last one settled.
// - While disabled (no link) levels are only recorded; enabling after a
//   reset() sends the current wanted level, so a fresh link starts in step
//   (usually with an explicit 0).
// - A failed write forgets what the toy has, so the wanted level is retried
//   after the interval. That is what makes a final 0 reliable.
// Time and timers are injected; no DOM.
import { clampLevel, vibrateCommand } from "./protocol.ts";
import { createListeners, defaultNow, GLOBAL_TIMERS, type Timers } from "../util/timers.ts";

export const DEFAULT_MIN_INTERVAL_MS = 100;

export interface LevelSenderOptions {
  /** writes one command; resolves when written, rejects on failure */
  write: (cmd: string) => Promise<void>;
  timers?: Timers;
  now?: () => number;
  minIntervalMs?: number;
  /** start enabled (default false: the device enables it once linked) */
  enabled?: boolean;
}

export interface LevelSender {
  /** the level the toy should have (rounded and clamped to 0..20) */
  set(level: number): void;
  wanted(): number;
  /** the level last written successfully; undefined while unknown */
  sent(): number | undefined;
  /** forget the toy's level (a new link): the wanted level is sent again */
  reset(): void;
  setEnabled(on: boolean): void;
  enabled(): boolean;
  /** resolves once nothing is in flight and the toy has the wanted level (or sending is disabled) */
  idle(): Promise<void>;
  onSent(cb: (level: number) => void): () => void;
  onError(cb: (err: unknown) => void): () => void;
  dispose(): void;
}

export function createLevelSender(opts: LevelSenderOptions): LevelSender {
  const timers = opts.timers ?? GLOBAL_TIMERS;
  const now = opts.now ?? defaultNow;
  const interval = opts.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  const sentListeners = createListeners<number>();
  const errorListeners = createListeners<unknown>();

  let wanted = 0;
  let sent: number | undefined;
  let on = opts.enabled ?? false;
  let busy = false;
  let timer: unknown;
  let lastWriteAt = -Infinity;
  let disposed = false;
  let waiters: (() => void)[] = [];

  function settled(): boolean {
    return !busy && (!on || sent === wanted);
  }

  function wake(): void {
    if (!settled() || waiters.length === 0) return;
    const w = waiters;
    waiters = [];
    for (const fn of w) fn();
  }

  function clearTimer(): void {
    if (timer !== undefined) timers.clearTimeout(timer);
    timer = undefined;
  }

  function pump(): void {
    if (disposed || busy || timer !== undefined || !on) return wake();
    if (sent === wanted) return wake();
    const wait = lastWriteAt + interval - now();
    if (wait > 0) {
      timer = timers.setTimeout(() => {
        timer = undefined;
        pump();
      }, wait);
      return;
    }
    const level = wanted;
    busy = true;
    lastWriteAt = now();
    let p: Promise<void>;
    try {
      p = opts.write(vibrateCommand(level));
    } catch (e) {
      p = Promise.reject(e);
    }
    p.then(
      () => {
        busy = false;
        if (disposed) return;
        const changed = sent !== level;
        sent = level;
        if (changed) sentListeners.emit(level);
        pump();
      },
      (e: unknown) => {
        busy = false;
        if (disposed) return;
        sent = undefined;
        errorListeners.emit(e);
        pump();
      },
    );
  }

  return {
    set(level) {
      wanted = clampLevel(level);
      pump();
    },
    wanted: () => wanted,
    sent: () => sent,
    reset() {
      sent = undefined;
      pump();
    },
    setEnabled(v) {
      on = v;
      if (!v) clearTimer();
      pump();
    },
    enabled: () => on,
    idle() {
      if (settled()) return Promise.resolve();
      return new Promise<void>((resolve) => waiters.push(resolve));
    },
    onSent: (cb) => sentListeners.add(cb),
    onError: (cb) => errorListeners.add(cb),
    dispose() {
      disposed = true;
      on = false;
      clearTimer();
      busy = false;
      wake();
      sentListeners.clear();
      errorListeners.clear();
    },
  };
}
