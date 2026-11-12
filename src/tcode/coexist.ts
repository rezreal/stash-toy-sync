// Is the old TCode Player plugin (stash-interactive-tcode) active in this
// page? While it is, Toy Sync must not reconnect the TCode device or the lube
// launcher on its own: the stroker would be driven by both plugins.
//
// TCode Player leaves three traces: window.TCodePlayer (its debug handle, set
// when its script runs), its navbar menu (.tcp-nav) and scene tab (.tcp-panel),
// and the <script> stash adds for plugin/TCodePlayer/….

interface DocLike {
  querySelector(sel: string): unknown;
}

export interface PageLike {
  TCodePlayer?: unknown;
  document?: DocLike;
}

export const OLD_PLUGIN_SELECTORS = [".tcp-nav", ".tcp-panel", 'script[src*="plugin/TCodePlayer/"]'];

export function tcodePlayerPresent(page: PageLike | undefined = globalThis as PageLike): boolean {
  if (!page) return false;
  if (page.TCodePlayer) return true;
  const doc = page.document;
  if (!doc || typeof doc.querySelector !== "function") return false;
  try {
    return OLD_PLUGIN_SELECTORS.some((sel) => !!doc.querySelector(sel));
  } catch {
    return false;
  }
}
