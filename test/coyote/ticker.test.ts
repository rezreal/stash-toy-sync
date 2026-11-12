import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createTicker, createTimerTicker, WORKER_SOURCE, type WorkerLike } from "../../src/coyote/ticker.ts";
import { FakeClock } from "../fakes/clock.ts";

class FakeWorker implements WorkerLike {
  static last: FakeWorker | undefined;
  static failNew = false;
  url: string;
  posted: unknown[] = [];
  terminated = false;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  constructor(url: string) {
    if (FakeWorker.failNew) throw new Error("blocked by CSP");
    this.url = url;
    FakeWorker.last = this;
  }
  postMessage(msg: unknown): void {
    this.posted.push(msg);
  }
  terminate(): void {
    this.terminated = true;
  }
  tick(): void {
    this.onmessage?.({ data: 0 });
  }
}

describe("timer ticker", () => {
  it("ticks every interval until stopped; start() re-phases", () => {
    const clock = new FakeClock();
    const ticks: number[] = [];
    const t = createTimerTicker(() => ticks.push(clock.t), 100, clock);
    t.start();
    clock.advance(350);
    assert.deepEqual(ticks, [100, 200, 300]);
    t.start();
    clock.advance(150);
    assert.deepEqual(ticks, [100, 200, 300, 450]);
    t.stop();
    clock.advance(500);
    assert.equal(ticks.length, 4);
    assert.equal(t.running(), false);
    assert.equal(clock.pending, 0);
  });
});

describe("worker ticker", () => {
  it("runs a Blob worker and ticks on its messages", () => {
    const clock = new FakeClock();
    let n = 0;
    const urls: string[] = [];
    const revoked: string[] = [];
    const t = createTicker(() => n++, 100, {
      timers: clock,
      worker: FakeWorker,
      createObjectURL: () => {
        urls.push("blob:x");
        return "blob:x";
      },
      revokeObjectURL: (u) => revoked.push(u),
    });
    const w = FakeWorker.last!;
    assert.equal(w.url, "blob:x");
    assert.match(WORKER_SOURCE, /setInterval/);
    w.tick();
    assert.equal(n, 0, "no ticks before start");
    t.start();
    assert.deepEqual(w.posted, [100]);
    w.tick();
    w.tick();
    assert.equal(n, 2);
    t.stop();
    assert.deepEqual(w.posted, [100, 0]);
    w.tick();
    assert.equal(n, 2, "a late message after stop is ignored");
    // the timers aren't used meanwhile
    clock.advance(1000);
    assert.equal(n, 2);
    t.dispose();
    assert.equal(w.terminated, true);
    assert.deepEqual(revoked, ["blob:x"]);
  });

  it("falls back to the timers when the worker can't be created or errors", () => {
    const clock = new FakeClock();
    let n = 0;
    FakeWorker.failNew = true;
    const t = createTicker(() => n++, 100, { timers: clock, worker: FakeWorker, createObjectURL: () => "blob:y", revokeObjectURL: () => undefined });
    FakeWorker.failNew = false;
    t.start();
    clock.advance(300);
    assert.equal(n, 3);
    t.dispose();

    let m = 0;
    const t2 = createTicker(() => m++, 100, { timers: clock, worker: FakeWorker, createObjectURL: () => "blob:z", revokeObjectURL: () => undefined });
    const w = FakeWorker.last!;
    t2.start();
    w.onerror?.(new Error("csp"));
    assert.equal(w.terminated, true);
    clock.advance(200);
    assert.equal(m, 2);
    t2.stop();
    clock.advance(200);
    assert.equal(m, 2);
  });

  it("uses the timers when Worker is unavailable (null)", () => {
    const clock = new FakeClock();
    let n = 0;
    const t = createTicker(() => n++, 100, { timers: clock, worker: null });
    t.start();
    clock.advance(100);
    assert.equal(n, 1);
  });
});
