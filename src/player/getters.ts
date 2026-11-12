// Ways to find stash's video.js player besides root.player (see playback.ts):
// stash's InteractiveUtils.getPlayer() and window.videojs.getPlayer(). Looked
// up lazily on every call.
import { pluginApi } from "../ui/pluginApi.ts";
import { VIDEO_PLAYER_ID } from "./playback.ts";

export function playerGetters(): (() => unknown)[] {
  return [
    () => pluginApi()?.utils?.InteractiveUtils?.getPlayer?.(),
    () => (globalThis as unknown as { videojs?: { getPlayer?: (id: string) => unknown } }).videojs?.getPlayer?.(VIDEO_PLAYER_ID),
  ];
}
