import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { clampLimits, createNudgeLimiter, MINUTE_MS } from "../../src/sync/nudge.ts";
import { FakeClock } from "../fakes/clock.ts";

describe("nudge limiter", () => {
  it("allows one nudge per cooldown", () => {
    const clock = new FakeClock();
    const l = createNudgeLimiter(clock.now);
    assert.deepEqual(l.request(true), { ok: true });
    assert.deepEqual(l.request(true), { ok: false, dropped: "cooldown" });
    clock.advance(3999);
    assert.deepEqual(l.request(true), { ok: false, dropped: "cooldown" });
    clock.advance(1);
    assert.deepEqual(l.request(true), { ok: true });
  });

  it("dropped requests don't extend the cooldown", () => {
    const clock = new FakeClock();
    const l = createNudgeLimiter(clock.now);
    l.request(true);
    for (let i = 0; i < 39; i++) {
      clock.advance(100);
      assert.equal(l.request(true).ok, false);
    }
    clock.advance(100);
    assert.equal(l.request(true).ok, true);
  });

  it("caps nudges per rolling minute", () => {
    const clock = new FakeClock();
    const l = createNudgeLimiter(clock.now, { cooldownMs: 2000, perMinute: 6 });
    const accepted: number[] = [];
    // ask every second for three minutes
    for (let t = 0; t < 3 * MINUTE_MS; t += 1000) {
      if (l.request(true).ok) accepted.push(clock.t);
      clock.advance(1000);
    }
    for (let i = 0; i < accepted.length; i++) {
      const inWindow = accepted.filter((t) => t >= accepted[i]! && t < accepted[i]! + MINUTE_MS).length;
      assert.ok(inWindow <= 6, `${inWindow} nudges in the minute from ${accepted[i]}`);
    }
    assert.equal(accepted.length, 18);
    for (let i = 1; i < accepted.length; i++) assert.ok(accepted[i]! - accepted[i - 1]! >= 2000);
  });

  it("never nudges without an open scene, and nothing counts then", () => {
    const clock = new FakeClock();
    const l = createNudgeLimiter(clock.now);
    assert.deepEqual(l.request(false), { ok: false, dropped: "no-scene" });
    assert.deepEqual(l.request(true), { ok: true }, "the dropped request didn't start a cooldown");
  });

  it("perMinute 0 turns nudges off", () => {
    const clock = new FakeClock();
    const l = createNudgeLimiter(clock.now, { cooldownMs: 4000, perMinute: 0 });
    assert.deepEqual(l.request(true), { ok: false, dropped: "disabled" });
  });

  it("enforces the hard bounds whatever it is given", () => {
    assert.deepEqual(clampLimits({ cooldownMs: 100, perMinute: 60 }), { cooldownMs: 2000, perMinute: 10 });
    assert.deepEqual(clampLimits({ cooldownMs: Number.NaN, perMinute: Number.NaN }), { cooldownMs: 4000, perMinute: 6 });
    const clock = new FakeClock();
    const l = createNudgeLimiter(clock.now);
    l.setLimits({ cooldownMs: 0, perMinute: 100 });
    assert.deepEqual(l.limits(), { cooldownMs: 2000, perMinute: 10 });
    l.request(true);
    clock.advance(1999);
    assert.equal(l.request(true).ok, false);
  });
});
