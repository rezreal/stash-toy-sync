// The Coyote 3.0 strength handshake. Pure, time passed in.
//
// A B0 packet either keeps the strengths (seq 0, mode 0b00) or sets a
// channel absolutely (mode 0b11) under a sequence number 1..15. The device
// answers the latter with B1 [0xB1, seq, actualA, actualB]. Until that
// answer arrives (or ACK_TIMEOUT_MS pass, then the change is retried) no
// further strength change is sent, so changes never pile up.
//
// A B1 with seq 0 means the strength changed on the device itself (the
// wheels). A lower value than the device last had is the user turning it
// down: it becomes that channel's ceiling until the tracker is reset (on
// reconnect). Higher values are simply corrected back on the next packet.
import { MODE_ABSOLUTE, MODE_KEEP, STRENGTH_MAX } from "./protocol-v3.ts";

export const ACK_TIMEOUT_MS = 500;

export type Channel = "a" | "b";
export interface Pair {
  a: number;
  b: number;
}

/** the strength part of one B0 packet */
export interface StrengthCommand {
  seq: number;
  modeA: number;
  modeB: number;
  strengthA: number;
  strengthB: number;
}

export const KEEP: StrengthCommand = Object.freeze({ seq: 0, modeA: MODE_KEEP, modeB: MODE_KEEP, strengthA: 0, strengthB: 0 });

export interface StrengthTracker {
  /** the strength part of the next packet for these wanted strengths (ceilings applied) */
  next(wanted: Pair, now: number): StrengthCommand;
  /** an absolute 0 / 0 right away, regardless of a pending change */
  zero(now: number): StrengthCommand;
  /** a B1 notification; returns the channels the user turned down on the device */
  onB1(seq: number, a: number, b: number): Channel[];
  /** per channel: the most the device may be at right now (actual or pending, 200 when unknown) */
  upperBound(): Pair;
  /** the strengths the device last reported (undefined until the first B1) */
  actual(): { a?: number; b?: number };
  ceiling(): Pair;
  /** the device is known to be at 0 / 0 with nothing pending */
  settled(): boolean;
  /** forget everything (new connection): the next packet sets both channels absolutely */
  reset(): void;
}

const clampLevel = (v: number): number => (!Number.isFinite(v) ? 0 : Math.max(0, Math.min(STRENGTH_MAX, Math.round(v))));

export function createStrengthTracker(timeoutMs = ACK_TIMEOUT_MS): StrengthTracker {
  let actualA: number | undefined;
  let actualB: number | undefined;
  let ceil: Pair = { a: STRENGTH_MAX, b: STRENGTH_MAX };
  let pending: { seq: number; a?: number; b?: number; at: number } | undefined;
  let lastSeq = 0;

  function nextSeq(): number {
    lastSeq = (lastSeq % 15) + 1;
    return lastSeq;
  }

  function send(a: number | undefined, b: number | undefined, now: number): StrengthCommand {
    const seq = nextSeq();
    pending = { seq, at: now };
    if (a !== undefined) pending.a = a;
    if (b !== undefined) pending.b = b;
    return {
      seq,
      modeA: a !== undefined ? MODE_ABSOLUTE : MODE_KEEP,
      modeB: b !== undefined ? MODE_ABSOLUTE : MODE_KEEP,
      strengthA: a ?? 0,
      strengthB: b ?? 0,
    };
  }

  return {
    next(wanted, now) {
      if (pending) {
        if (now - pending.at < timeoutMs) return KEEP;
        pending = undefined; // no answer: retry below
      }
      const a = Math.min(clampLevel(wanted.a), ceil.a);
      const b = Math.min(clampLevel(wanted.b), ceil.b);
      const changeA = actualA !== a;
      const changeB = actualB !== b;
      if (!changeA && !changeB) return KEEP;
      return send(changeA ? a : undefined, changeB ? b : undefined, now);
    },
    zero(now) {
      return send(0, 0, now);
    },
    onB1(seq, a, b) {
      const va = clampLevel(a);
      const vb = clampLevel(b);
      const down: Channel[] = [];
      if (seq === 0) {
        if (actualA !== undefined && va < actualA) {
          ceil = { ...ceil, a: Math.min(ceil.a, va) };
          down.push("a");
        }
        if (actualB !== undefined && vb < actualB) {
          ceil = { ...ceil, b: Math.min(ceil.b, vb) };
          down.push("b");
        }
      } else if (pending && seq === pending.seq) {
        pending = undefined;
      }
      actualA = va;
      actualB = vb;
      return down;
    },
    upperBound() {
      const up = (actual: number | undefined, pend: number | undefined) =>
        Math.max(actual ?? STRENGTH_MAX, pend ?? 0);
      return { a: up(actualA, pending?.a), b: up(actualB, pending?.b) };
    },
    actual() {
      const out: { a?: number; b?: number } = {};
      if (actualA !== undefined) out.a = actualA;
      if (actualB !== undefined) out.b = actualB;
      return out;
    },
    ceiling: () => ({ ...ceil }),
    settled: () => pending === undefined && actualA === 0 && actualB === 0,
    reset() {
      actualA = undefined;
      actualB = undefined;
      ceil = { a: STRENGTH_MAX, b: STRENGTH_MAX };
      pending = undefined;
    },
  };
}
