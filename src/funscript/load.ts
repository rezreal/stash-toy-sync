// Fetches a scene's funscript from stash (`/scene/:id/funscript`, the file
// stash serves next to the video) and parses it. Cached per scene id for the
// page's lifetime, including "has none".
import { stashUrl } from "../stash/url.ts";
import { parseFunscript, type Funscript } from "./parse.ts";

const cache = new Map<string, Promise<Funscript | undefined>>();

/**
 * The scene's funscript, or undefined when it has none (404) or the file
 * isn't JSON. Other HTTP errors and network failures reject and are not
 * cached, so a later call retries.
 */
export function loadFunscript(sceneId: string, fetchImpl?: typeof fetch): Promise<Funscript | undefined> {
  const hit = cache.get(sceneId);
  if (hit) return hit;
  const doFetch: typeof fetch = fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  const p = (async () => {
    const res = await doFetch(stashUrl(`scene/${encodeURIComponent(sceneId)}/funscript`), {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    if (res.status === 404) return undefined;
    if (!res.ok) throw new Error(`Funscript request failed: HTTP ${res.status}`);
    const text = await res.text();
    try {
      return parseFunscript(JSON.parse(text));
    } catch {
      return undefined;
    }
  })();
  cache.set(sceneId, p);
  p.catch(() => cache.delete(sceneId));
  return p;
}

/** for tests */
export function clearFunscriptCache(): void {
  cache.clear();
}
