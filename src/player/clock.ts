// The PlaybackClock self-timed drivers read (TCode at 50–100 Hz): stash's
// scene player, read the same way the slot's engine tick reads it
// (playback.ts: video.js time when there is a player, the element's state).
// One page-wide clock (runtime.ts); the player slot feeds it the media
// events, the scene binder scene changes and offset changes.
//
//   scriptMs() = video time × 1000 + scene offset + latency setting
//
// Each call re-reads the DOM (one getElementById and a querySelector inside
// the player root): the <video> is replaced on some player re-inits, and it
// is cheap enough for 100 calls a second.
import type { PlaybackClock, PlaybackEvent } from "../devices/types.ts";
import { createListeners } from "../util/timers.ts";
import { findPlayer, findVideo, readPlayback, VIDEO_PLAYER_ID, type RootLike } from "./playback.ts";

export interface VideoClock extends PlaybackClock {
  /** the video's own time in ms (no offset, no latency); undefined without a video */
  videoMs(): number | undefined;
  /** the scene offset in ms (the binder sets it from the scene's mapping) */
  setOffsetMs(ms: number): void;
  offsetMs(): number;
  /** tells every listener about a playback event (media events, scene changes) */
  notify(e: PlaybackEvent): void;
}

export interface VideoClockOptions {
  /** the player root; default: document.getElementById("VideoJsPlayer") */
  root?: () => RootLike | null;
  /** extra ways to find the video.js player (see playback.ts findPlayer) */
  getters?: (() => unknown)[];
  /** the latency setting in ms */
  latencyMs?: () => number;
}

function defaultRoot(): RootLike | null {
  const doc = (globalThis as { document?: { getElementById(id: string): unknown } }).document;
  return (doc?.getElementById(VIDEO_PLAYER_ID) as RootLike | null) ?? null;
}

/** the PlaybackEvent of a DOM media event, undefined for events that don't matter */
export function mediaEventToPlayback(type: string): PlaybackEvent | undefined {
  switch (type) {
    case "play":
    case "playing":
      return "play";
    case "pause":
    case "waiting":
    case "emptied":
      return "pause";
    case "seeking":
    case "seeked":
      return "seek";
    case "ended":
      return "ended";
    default:
      return undefined;
  }
}

export function createVideoClock(opts: VideoClockOptions = {}): VideoClock {
  const root = opts.root ?? defaultRoot;
  const getters = opts.getters ?? [];
  const latency = opts.latencyMs ?? (() => 0);
  const listeners = createListeners<PlaybackEvent>();
  let offset = 0;

  function videoMs(): number | undefined {
    const r = root();
    const video = findVideo(r);
    if (!video) return undefined;
    let sec = video.currentTime;
    const player = findPlayer(r, getters);
    if (player) {
      try {
        sec = player.currentTime();
      } catch {
        // a player between dispose and removal: the element's time stands
      }
    }
    return Number.isFinite(sec) ? sec * 1000 : undefined;
  }

  return {
    scriptMs() {
      const v = videoMs();
      if (v === undefined) return undefined;
      const l = latency();
      return v + offset + (Number.isFinite(l) ? l : 0);
    },
    videoMs,
    playing: () => readPlayback(root(), getters).playing,
    onChange: (cb) => listeners.add(cb),
    setOffsetMs(ms) {
      offset = Number.isFinite(ms) ? ms : 0;
    },
    offsetMs: () => offset,
    notify: (e) => listeners.emit(e),
  };
}
