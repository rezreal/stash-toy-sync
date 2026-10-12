import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createLevelSender } from "../../src/lovense/sender.ts";
import { FakeClock, flush } from "../fakes/clock.ts";

function setup(opts: { manual?: boolean; enabled?: boolean } = {}) {
  const clock = new FakeClock();
  const writes: { cmd: string; t: number }[] = [];
  const pending: { resolve: () => void; reject: (e: Error) => void }[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let failNext = 0;
  const sender = createLevelSender({
    timers: clock,
    now: clock.now,
    enabled: opts.enabled ?? true,
    write: (cmd) => {
      writes.push({ cmd, t: clock.t });
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      if (opts.manual) {
        return new Promise<void>((resolve, reject) => {
          pending.push({
            resolve: () => {
              inFlight--;
              resolve();
            },
            reject: (e) => {
              inFlight--;
              reject(e);
            },
          });
        });
      }
      inFlight--;
      if (failNext > 0) {
        failNext--;
        return Promise.reject(new Error("GATT operation failed"));
      }
      return Promise.resolve();
    },
  });
  return {
    clock,
    writes,
    pending,
    sender,
    cmds: () => writes.map((w) => w.cmd),
    maxInFlight: () => maxInFlight,
    failNext: (n: number) => {
      failNext = n;
    },
  };
}

describe("createLevelSender", () => {
  it("sends only changes", async () => {
    const t = setup();
    t.sender.set(5);
    await flush();
    t.clock.advance(200);
    t.sender.set(5);
    await flush();
    assert.deepEqual(t.cmds(), ["Vibrate:5;"]);
    assert.equal(t.sender.sent(), 5);
  });

  it("rate-limits to one write per 100 ms and coalesces to the latest level", async () => {
    const t = setup();
    t.sender.set(3);
    await flush();
    t.clock.advance(10);
    t.sender.set(4);
    t.sender.set(9);
    t.clock.advance(30);
    t.sender.set(12);
    await flush();
    assert.deepEqual(t.cmds(), ["Vibrate:3;"]);
    t.clock.advance(59);
    await flush();
    assert.deepEqual(t.cmds(), ["Vibrate:3;"]);
    t.clock.advance(1);
    await flush();
    assert.deepEqual(t.cmds(), ["Vibrate:3;", "Vibrate:12;"]);
    assert.deepEqual(t.writes.map((w) => w.t), [0, 100]);
  });

  it("drops a change that is undone within the window", async () => {
    const t = setup();
    t.sender.set(6);
    await flush();
    t.sender.set(8);
    t.sender.set(6);
    t.clock.advance(150);
    await flush();
    assert.deepEqual(t.cmds(), ["Vibrate:6;"]);
  });

  it("never overlaps writes", async () => {
    const t = setup({ manual: true });
    t.sender.set(5);
    t.clock.advance(500);
    t.sender.set(10);
    t.clock.advance(500);
    await flush();
    assert.equal(t.writes.length, 1, "the second write waits for the first");
    t.pending.shift()!.resolve();
    await flush();
    assert.deepEqual(t.cmds(), ["Vibrate:5;", "Vibrate:10;"]);
    assert.equal(t.maxInFlight(), 1);
    t.pending.shift()!.resolve();
    await flush();
    assert.equal(t.sender.sent(), 10);
  });

  it("always gets the final 0 out, retrying a failed write", async () => {
    const t = setup();
    t.sender.set(15);
    await flush();
    t.clock.advance(20);
    t.failNext(1);
    t.sender.set(0);
    t.clock.advance(100);
    await flush();
    assert.equal(t.sender.sent(), undefined);
    t.clock.advance(100);
    await flush();
    assert.deepEqual(t.cmds(), ["Vibrate:15;", "Vibrate:0;", "Vibrate:0;"]);
    assert.equal(t.sender.sent(), 0);
    await t.sender.idle();
  });

  it("records levels while disabled and sends the latest after reset + enable", async () => {
    const t = setup({ enabled: false });
    t.sender.set(7);
    t.sender.set(0);
    await flush();
    assert.deepEqual(t.cmds(), []);
    await t.sender.idle(); // disabled counts as settled
    t.sender.reset();
    t.sender.setEnabled(true);
    await flush();
    assert.deepEqual(t.cmds(), ["Vibrate:0;"], "a fresh link starts with an explicit 0");
  });

  it("idle() waits for the wanted level to be written", async () => {
    const t = setup({ manual: true });
    t.sender.set(4);
    let done = false;
    void t.sender.idle().then(() => (done = true));
    await flush();
    assert.equal(done, false);
    t.pending.shift()!.resolve();
    await flush();
    assert.equal(done, true);
  });

  it("clamps and rounds levels", async () => {
    const t = setup();
    t.sender.set(33);
    await flush();
    assert.equal(t.sender.wanted(), 20);
    assert.deepEqual(t.cmds(), ["Vibrate:20;"]);
  });

  it("reports sent levels and errors", async () => {
    const t = setup();
    const sent: number[] = [];
    const errors: unknown[] = [];
    t.sender.onSent((l) => sent.push(l));
    t.sender.onError((e) => errors.push(e));
    t.sender.set(2);
    await flush();
    t.failNext(1);
    t.clock.advance(100);
    t.sender.set(3);
    await flush();
    assert.deepEqual(sent, [2]);
    assert.equal(errors.length, 1);
  });
});
