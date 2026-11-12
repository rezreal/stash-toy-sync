import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { appendSlot, type ReactLike } from "../../src/player/appendSlot.ts";
import { findPlayer, readPlayback, type RootLike, type VideoLike } from "../../src/player/playback.ts";
import type { DeviceEntry } from "../../src/devices/manager.ts";
import type { DeviceStatus } from "../../src/devices/types.ts";
import {
  deviceMessages,
  gainNote,
  liveEntries,
  meterPercent,
  needingCalibration,
  scriptNote,
  shouldRender,
} from "../../src/player/view.ts";

function video(p: Partial<VideoLike> = {}): VideoLike {
  return { paused: false, ended: false, seeking: false, readyState: 4, currentTime: 12, ...p };
}

function root(v: VideoLike | null, player?: unknown): RootLike {
  return { tagName: "VIDEO-JS", querySelector: (sel: string) => (sel === "video" ? v : null), player };
}

function player(p: { time?: number; paused?: boolean; ended?: boolean; seeking?: boolean; el?: unknown; disposed?: boolean } = {}) {
  return {
    currentTime: () => p.time ?? 100,
    paused: () => p.paused ?? false,
    ended: () => p.ended ?? false,
    seeking: () => p.seeking ?? false,
    el: () => p.el,
    isDisposed: () => p.disposed ?? false,
  };
}

describe("readPlayback", () => {
  it("is playing only when not paused, ended or seeking, with data", () => {
    assert.deepEqual(readPlayback(root(video())), { playing: true, timeSec: 12 });
    assert.equal(readPlayback(root(video({ paused: true }))).playing, false);
    assert.equal(readPlayback(root(video({ ended: true }))).playing, false);
    assert.equal(readPlayback(root(video({ seeking: true }))).playing, false);
    assert.equal(readPlayback(root(video({ readyState: 2 }))).playing, false);
    assert.deepEqual(readPlayback(root(null)), { playing: false, timeSec: 0 });
    assert.deepEqual(readPlayback(null), { playing: false, timeSec: 0 });
  });

  it("prefers video.js time (transcode offset) and state", () => {
    assert.deepEqual(readPlayback(root(video(), player({ time: 345 }))), { playing: true, timeSec: 345 });
    assert.equal(readPlayback(root(video(), player({ paused: true }))).playing, false);
    assert.equal(readPlayback(root(video(), player({ seeking: true }))).playing, false);
  });

  it("finds the player through getters when the root has none", () => {
    const r = root(video());
    const p = player({ time: 50, el: r });
    assert.equal(findPlayer(r, [() => undefined, () => p]), p);
    assert.equal(readPlayback(r, [() => p]).timeSec, 50);
    // a player of another element, or a disposed one, doesn't count
    assert.equal(findPlayer(r, [() => player({ el: {} })]), null);
    assert.equal(findPlayer(root(video(), player({ disposed: true }))), null);
    assert.equal(findPlayer(r, [() => { throw new Error("boom"); }]), null);
  });

  it("treats a non-finite time as not playing", () => {
    assert.deepEqual(readPlayback(root(video({ currentTime: Number.NaN }))), { playing: false, timeSec: 0 });
  });
});

describe("appendSlot", () => {
  const Fragment = Symbol("Fragment");
  const R: ReactLike = {
    Fragment,
    createElement: (type, props, ...children) => ({ type, key: (props as { key?: unknown } | null)?.key ?? null, props: { ...(props as object), children } }),
  };
  const div = { type: "div", key: null, props: {} };
  const slot = { type: "Slot", key: "toysync", props: {} };

  it("puts the slot after stash's element in an unkeyed fragment", () => {
    const out = appendSlot(div, slot, R) as { type: unknown; props: { children: unknown[] } };
    assert.equal(out.type, Fragment);
    assert.deepEqual(out.props.children, [div, slot]);
  });

  it("flattens another plugin's fragment so stash's element stays first", () => {
    const other = { type: "SkilltreeSlot", key: "skilltree:1", props: {} };
    const theirs = R.createElement(Fragment, null, div, other);
    const out = appendSlot(theirs, slot, R) as { props: { children: unknown[] } };
    assert.deepEqual(out.props.children, [div, other, slot]);
    const single = { type: Fragment, key: null, props: { children: div } };
    assert.deepEqual((appendSlot(single, slot, R) as { props: { children: unknown[] } }).props.children, [div, slot]);
  });

  it("leaves keyed fragments and null results alone", () => {
    const keyed = { type: Fragment, key: "k", props: { children: [div] } };
    assert.deepEqual((appendSlot(keyed, slot, R) as { props: { children: unknown[] } }).props.children, [keyed, slot]);
    assert.deepEqual((appendSlot(null, slot, R) as { props: { children: unknown[] } }).props.children, [null, slot]);
  });
});

const entry = (kind: DeviceEntry["kind"], status: DeviceStatus): DeviceEntry => ({ kind, id: `${kind}-1`, status });

describe("bar view", () => {
  it("renders for interactive scenes, or while a device is connected", () => {
    assert.equal(shouldRender(true, []), true);
    assert.equal(shouldRender(false, []), false);
    assert.equal(shouldRender(false, [entry("lovense", { connection: "error" })]), false);
    assert.equal(shouldRender(false, [entry("lovense", { connection: "disconnected" }), entry("coyote-v3", { connection: "connected" })]), true);
    assert.equal(shouldRender(false, [entry("lovense", { connection: "connecting" })]), true);
  });

  it("lists live devices and the one needing calibration", () => {
    const es = [
      entry("lovense", { connection: "disconnected" }),
      entry("coyote-v3", { connection: "connected", needsCalibration: true }),
      entry("coyote-v2", { connection: "connecting", needsCalibration: true }),
    ];
    assert.deepEqual(liveEntries(es).map((e) => e.kind), ["coyote-v3", "coyote-v2"]);
    assert.equal(needingCalibration(es)?.kind, "coyote-v3");
    assert.equal(needingCalibration([es[0]!]), undefined);
  });

  it("sizes meters", () => {
    assert.equal(meterPercent(0.5), 50);
    assert.equal(meterPercent(2), 100);
    assert.equal(meterPercent(undefined), 0);
    assert.equal(meterPercent(Number.NaN), 0);
  });

  it("shows errors always and other messages of live devices", () => {
    const es = [
      entry("lovense", { connection: "error", message: "No toy chosen." }),
      entry("coyote-v3", { connection: "disconnected", message: "Turn it on." }),
      entry("coyote-v2", { connection: "connecting", message: "Reconnecting…" }),
    ];
    assert.deepEqual(deviceMessages(es, (e) => e.kind), [
      { text: "lovense: No toy chosen.", error: true },
      { text: "coyote-v2: Reconnecting…", error: false },
    ]);
  });

  it("explains a missing script", () => {
    assert.match(scriptNote(true, "missing")!, /No funscript/);
    assert.match(scriptNote(false, "none")!, /No funscript/);
    assert.match(scriptNote(true, "error")!, /Couldn't load/);
    assert.equal(scriptNote(true, "ready"), undefined);
  });

  it("shows a reduced gain", () => {
    assert.equal(gainNote(1), undefined);
    assert.equal(gainNote(0.5), "gain 50 %");
    assert.equal(gainNote(0), "gain 0 %");
  });
});
