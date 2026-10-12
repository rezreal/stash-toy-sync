// A manual clock with timers (same as Skilltree's test/gaze/fakes.ts).
import type { Timers } from "../../src/util/timers.ts";

export class FakeClock implements Timers {
  t = 0;
  private seq = 0;
  private queue: { id: number; at: number; fn: () => void }[] = [];

  now = (): number => this.t;

  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.queue.push({ id, at: this.t + ms, fn });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.queue = this.queue.filter((q) => q.id !== handle);
  }

  /** advances time, running due timers in order */
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      this.queue.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = this.queue[0];
      if (next === undefined || next.at > end) break;
      this.queue.shift();
      this.t = next.at;
      next.fn();
    }
    this.t = end;
  }

  get pending(): number {
    return this.queue.length;
  }
}

/** lets pending promise callbacks run */
export async function flush(n = 30): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}
