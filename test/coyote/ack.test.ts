import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ACK_TIMEOUT_MS, createStrengthTracker, KEEP } from "../../src/coyote/ack.ts";

describe("strength tracker", () => {
  it("starts unknown, so the first packet sets both channels absolutely", () => {
    const t = createStrengthTracker();
    assert.deepEqual(t.next({ a: 0, b: 0 }, 0), { seq: 1, modeA: 3, modeB: 3, strengthA: 0, strengthB: 0 });
    assert.equal(t.settled(), false);
    t.onB1(1, 0, 0);
    assert.equal(t.settled(), true);
    assert.deepEqual(t.next({ a: 0, b: 0 }, 100), KEEP);
  });

  it("sends only the changed channel, then waits for the matching B1", () => {
    const t = createStrengthTracker();
    t.next({ a: 0, b: 0 }, 0);
    t.onB1(1, 0, 0);
    assert.deepEqual(t.next({ a: 40, b: 0 }, 100), { seq: 2, modeA: 3, modeB: 0, strengthA: 40, strengthB: 0 });
    // held while waiting
    assert.deepEqual(t.next({ a: 50, b: 10 }, 200), KEEP);
    // a stale ack (other seq) updates the known strengths but doesn't release
    t.onB1(1, 0, 0);
    assert.deepEqual(t.next({ a: 50, b: 10 }, 300), KEEP);
    t.onB1(2, 40, 0);
    assert.deepEqual(t.next({ a: 50, b: 10 }, 400), { seq: 3, modeA: 3, modeB: 3, strengthA: 50, strengthB: 10 });
  });

  it("retries after 500 ms without an answer", () => {
    const t = createStrengthTracker();
    assert.equal(t.next({ a: 20, b: 0 }, 0).seq, 1);
    assert.deepEqual(t.next({ a: 20, b: 0 }, ACK_TIMEOUT_MS - 1), KEEP);
    const retry = t.next({ a: 20, b: 0 }, ACK_TIMEOUT_MS);
    assert.equal(retry.seq, 2);
    assert.equal(retry.modeA, 3);
    assert.equal(retry.strengthA, 20);
  });

  it("cycles sequence numbers 1..15", () => {
    const t = createStrengthTracker();
    const seqs: number[] = [];
    for (let i = 0; i < 17; i++) {
      const c = t.next({ a: i + 1, b: 0 }, i * 1000);
      seqs.push(c.seq);
      t.onB1(c.seq, i + 1, 0);
    }
    assert.deepEqual(seqs, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 1, 2]);
  });

  it("adopts a wheel turned down (B1 seq 0) as the channel's ceiling", () => {
    const t = createStrengthTracker();
    t.next({ a: 60, b: 50 }, 0);
    t.onB1(1, 60, 50);
    assert.deepEqual(t.onB1(0, 30, 50), ["a"]);
    assert.deepEqual(t.ceiling(), { a: 30, b: 200 });
    // already there: nothing to send, and never above the ceiling again
    assert.deepEqual(t.next({ a: 60, b: 50 }, 100), KEEP);
    assert.deepEqual(t.next({ a: 100, b: 50 }, 200), KEEP);
    // lower is fine
    assert.deepEqual(t.next({ a: 10, b: 50 }, 300), { seq: 2, modeA: 3, modeB: 0, strengthA: 10, strengthB: 0 });
    t.onB1(2, 10, 50);
    assert.deepEqual(t.next({ a: 100, b: 50 }, 400), { seq: 3, modeA: 3, modeB: 0, strengthA: 30, strengthB: 0 });
  });

  it("corrects a wheel turned up instead of adopting it", () => {
    const t = createStrengthTracker();
    t.next({ a: 20, b: 0 }, 0);
    t.onB1(1, 20, 0);
    assert.deepEqual(t.onB1(0, 35, 0), []);
    assert.deepEqual(t.ceiling(), { a: 200, b: 200 });
    assert.deepEqual(t.next({ a: 20, b: 0 }, 100), { seq: 2, modeA: 3, modeB: 0, strengthA: 20, strengthB: 0 });
  });

  it("ignores seq-0 reports before the strengths are known", () => {
    const t = createStrengthTracker();
    assert.deepEqual(t.onB1(0, 5, 5), []);
    assert.deepEqual(t.ceiling(), { a: 200, b: 200 });
  });

  it("bounds what the device may be at: max(actual, pending), 200 when unknown", () => {
    const t = createStrengthTracker();
    assert.deepEqual(t.upperBound(), { a: 200, b: 200 });
    t.next({ a: 80, b: 0 }, 0);
    t.onB1(1, 80, 0);
    assert.deepEqual(t.upperBound(), { a: 80, b: 0 });
    t.next({ a: 40, b: 30 }, 100);
    assert.deepEqual(t.upperBound(), { a: 80, b: 30 });
    t.onB1(2, 40, 30);
    assert.deepEqual(t.upperBound(), { a: 40, b: 30 });
  });

  it("zero() overrides a pending change; reset() forgets ceilings", () => {
    const t = createStrengthTracker();
    t.next({ a: 80, b: 0 }, 0);
    const z = t.zero(10);
    assert.deepEqual(z, { seq: 2, modeA: 3, modeB: 3, strengthA: 0, strengthB: 0 });
    t.onB1(2, 0, 0);
    assert.equal(t.settled(), true);
    t.onB1(0, 0, 0);
    t.next({ a: 50, b: 50 }, 100);
    t.onB1(3, 50, 50);
    t.onB1(0, 20, 20);
    assert.deepEqual(t.ceiling(), { a: 20, b: 20 });
    t.reset();
    assert.deepEqual(t.ceiling(), { a: 200, b: 200 });
    assert.deepEqual(t.actual(), {});
    assert.equal(t.next({ a: 0, b: 0 }, 0).modeA, 3);
  });
});
