// URLs on the stash server the plugin runs in.
//
// Every URL is built from stash's `<base href>` so the plugin keeps working
// behind a reverse proxy that serves stash under a path prefix
// (e.g. https://host/stash/). Same helpers as Skilltree's src/stash/client.ts.

function withTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : url + "/";
}

/**
 * The stash UI's base URL with a trailing slash, from `<base href>` resolved
 * against the page origin. Falls back to "/" outside a browser.
 */
export function defaultBaseUrl(): string {
  const g = globalThis as {
    document?: { querySelector(sel: string): { getAttribute(name: string): string | null } | null };
    location?: { origin?: string };
  };
  const href = g.document?.querySelector("base")?.getAttribute("href") ?? "/";
  const origin = g.location?.origin;
  if (!origin || origin === "null") return withTrailingSlash(href);
  return withTrailingSlash(new URL(href, origin).href);
}

/** Link to a stash path, e.g. stashUrl("scene/1/funscript") -> "https://host/stash/scene/1/funscript". */
export function stashUrl(path: string, baseUrl?: string): string {
  return withTrailingSlash(baseUrl ?? defaultBaseUrl()) + path.replace(/^\/+/, "");
}
