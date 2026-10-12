import { test } from "node:test";
import assert from "node:assert/strict";
import { snapCursor, snapEvents } from "../../src/funscript/snap.ts";

const a = (at: number, pos: number) => ({ at, pos });

test("snapEvents: rising edges only", () => {
  assert.deepEqual(snapEvents([a(0, 0), a(100, 100), a(200, 0), a(300, 100), a(400, 0)]), [100, 300]);
});

test("snapEvents: staying high doesn't repeat; a high first point counts", () => {
  assert.deepEqual(snapEvents([a(0, 100), a(50, 80), a(100, 100), a(150, 0), a(200, 60)]), [0, 200]);
});

test("snapEvents: threshold is inclusive and configurable", () => {
  const acts = [a(0, 0), a(100, 50), a(200, 49), a(300, 70), a(400, 0)];
  assert.deepEqual(snapEvents(acts), [100, 300]);
  assert.deepEqual(snapEvents(acts, { threshold: 60 }), [300]);
  assert.deepEqual(snapEvents(acts, { threshold: 80 }), []);
});

test("snapEvents: unsorted input is sorted first", () => {
  assert.deepEqual(snapEvents([a(300, 100), a(0, 0), a(200, 0), a(100, 100)]), [100, 300]);
  assert.deepEqual(snapEvents([]), []);
});

test("snapCursor: normal forward play returns each snap once, in [prev, cur)", () => {
  const c = snapCursor([0, 500, 1000, 1010, 3000]);
  assert.deepEqual(c.crossed(0, 0.016), [0]);
  assert.deepEqual(c.crossed(0.016, 0.4), []);
  assert.deepEqual(c.crossed(0.4, 0.5), []); // 500 is at cur: next step
  assert.deepEqual(c.crossed(0.5, 0.6), [500]);
  assert.deepEqual(c.crossed(0.6, 1.1), [1000, 1010]);
  assert.deepEqual(c.crossed(1.1, 2.5), []);
  assert.deepEqual(c.crossed(2.5, 3.2), [3000]);
  assert.deepEqual(c.crossed(3.2, 9), []);
});

test("snapCursor: paused video returns nothing", () => {
  const c = snapCursor([1000]);
  assert.deepEqual(c.crossed(0.9, 0.9), []);
  assert.deepEqual(c.crossed(0.9, 0.9), []);
  assert.deepEqual(c.crossed(0.9, 1.05), [1000]);
});

test("snapCursor: backward seek returns nothing and resyncs", () => {
  const c = snapCursor([1000, 2000]);
  assert.deepEqual(c.crossed(0.5, 1.5), [1000]);
  assert.deepEqual(c.crossed(1.5, 0.2), []); // seek back / loop restart
  assert.deepEqual(c.crossed(0.2, 1.2), [1000]); // plays again normally
});

test("snapCursor: forward jump over 1.5 s returns nothing and resyncs", () => {
  const c = snapCursor([1000, 2000, 5000, 5200]);
  assert.deepEqual(c.crossed(0, 4.9), []);
  assert.deepEqual(c.crossed(4.9, 5.1), [5000]);
  assert.deepEqual(c.crossed(5.1, 6.5), [5200]); // 1.4 s is still playback
});

test("snapCursor: a prev that isn't the last cur re-seeks the hint", () => {
  const c = snapCursor([1000, 2000]);
  assert.deepEqual(c.crossed(1.9, 2.1), [2000]);
  assert.deepEqual(c.crossed(0.9, 1.1), [1000]); // the given prev is trusted
});
