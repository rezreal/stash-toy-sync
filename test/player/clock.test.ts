import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { PlaybackEvent } from "../../src/devices/types.ts";
import { createVideoClock, mediaEventToPlayback } from "../../src/player/clock.ts";

function fakeRoot(video: Record<string, unknown> | null, player?: Record<string, unknown>) {
  return { tagName: "VIDEO-JS", querySelector: () => video, player };
}

describe("video clock", () => {
  it("is video time + scene offset + latency, undefined without a video", () => {
    const video = { paused: false, ended: false, seeking: false, readyState: 4, currentTime: 12.5 };
    let root: ReturnType<typeof fakeRoot> | null = fakeRoot(video);
    let latency = 100;
    const clock = createVideoClock({ root: () => root, latencyMs: () => latency });
    assert.equal(clock.scriptMs(), 12_600);
    assert.equal(clock.videoMs(), 12_500);
    assert.equal(clock.playing(), true);
    clock.setOffsetMs(-50);
    latency = 0;
    assert.equal(clock.scriptMs(), 12_450);
    video.paused = true;
    assert.equal(clock.playing(), false);
    root = null;
    assert.equal(clock.scriptMs(), undefined);
    assert.equal(clock.playing(), false);
  });

  it("prefers video.js time (stash's transcode offset)", () => {
    const video = { paused: false, ended: false, seeking: false, readyState: 4, currentTime: 1 };
    const player = { currentTime: () => 301, paused: () => false, ended: () => false };
    const clock = createVideoClock({ root: () => fakeRoot(video, player) });
    assert.equal(clock.scriptMs(), 301_000);
  });

  it("passes events to listeners until they unsubscribe", () => {
    const clock = createVideoClock({ root: () => null });
    const seen: PlaybackEvent[] = [];
    const off = clock.onChange((e) => seen.push(e));
    clock.notify("play");
    clock.notify("scene");
    off();
    clock.notify("pause");
    assert.deepEqual(seen, ["play", "scene"]);
  });

  it("maps media events", () => {
    assert.equal(mediaEventToPlayback("playing"), "play");
    assert.equal(mediaEventToPlayback("waiting"), "pause");
    assert.equal(mediaEventToPlayback("seeked"), "seek");
    assert.equal(mediaEventToPlayback("ended"), "ended");
    assert.equal(mediaEventToPlayback("timeupdate"), undefined);
  });
});
