// Reads stash's scene player: is it playing, and where is it?
//
// Findings (stash v0.31.0, video.js 7.21; see Skilltree's
// src/stashplayer/videoHandle.ts for the long version):
// - The player root is <video-js id="VideoJsPlayer">; video.js puts
//   `el.player = player` on it. Stash also exposes the same player as
//   PluginApi.utils.InteractiveUtils.getPlayer(), and video.js itself as
//   window.videojs when present.
// - The <video> inside is replaced on some player re-inits, so nothing is
//   cached: every tick re-queries.
// - Time must come from video.js when it is there: for transcoded streams
//   stash's offset middleware seeks by reloading the source with ?start=, so
//   the raw element's currentTime restarts at 0 after such a seek;
//   player.currentTime() adds the offset back.
// DOM access is limited to the root passed in; testable with plain objects.
import type { PlaybackState } from "../sync/engine.ts";

export const VIDEO_PLAYER_ID = "VideoJsPlayer";
/** HTMLMediaElement.HAVE_FUTURE_DATA: playback can advance */
const HAVE_FUTURE_DATA = 3;

export interface VideoLike {
  paused: boolean;
  ended: boolean;
  seeking: boolean;
  readyState: number;
  currentTime: number;
}

export interface PlayerLike {
  currentTime(): number;
  paused(): boolean;
  ended(): boolean;
  seeking?(): boolean;
  el?(): unknown;
  isDisposed?(): boolean;
}

export interface RootLike {
  tagName?: string;
  querySelector(sel: string): unknown;
  player?: unknown;
}

function isPlayer(p: unknown): p is PlayerLike {
  if (!p || typeof p !== "object") return false;
  const v = p as Partial<PlayerLike>;
  if (typeof v.currentTime !== "function" || typeof v.paused !== "function" || typeof v.ended !== "function") return false;
  return !(typeof v.isDisposed === "function" && v.isDisposed());
}

/** the video.js player of this root: its own `player`, else one of the getters whose el() is the root */
export function findPlayer(root: RootLike | null, getters: (() => unknown)[] = []): PlayerLike | null {
  if (!root) return null;
  if (isPlayer(root.player)) return root.player;
  for (const get of getters) {
    let p: unknown;
    try {
      p = get();
    } catch {
      continue;
    }
    if (isPlayer(p) && (typeof p.el !== "function" || p.el() === root)) return p;
  }
  return null;
}

export function findVideo(root: RootLike | null): VideoLike | null {
  if (!root) return null;
  if (root.tagName?.toLowerCase() === "video") return root as unknown as VideoLike;
  return (root.querySelector("video") as VideoLike | null) ?? null;
}

/** playing = not paused, not ended, not seeking, with data to play; time from video.js when possible */
export function readPlayback(root: RootLike | null, getters: (() => unknown)[] = []): PlaybackState {
  const video = findVideo(root);
  if (!video) return { playing: false, timeSec: 0 };
  const player = findPlayer(root, getters);
  let timeSec = video.currentTime;
  let playing = !video.paused && !video.ended && !video.seeking && video.readyState >= HAVE_FUTURE_DATA;
  if (player) {
    try {
      timeSec = player.currentTime();
      playing = playing && !player.paused() && !player.ended() && !(player.seeking?.() ?? false);
    } catch {
      // a player between dispose and removal: the element's view stands
    }
  }
  if (!Number.isFinite(timeSec)) return { playing: false, timeSec: 0 };
  return { playing, timeSec };
}
