// The old TCode Player plugin, still installed next to Toy Sync during the
// transition, would drive the same stroker a second time. It is detected,
// never disabled: the user uninstalls it. Signs of it: the debugging global
// it leaves (window.TCodePlayer) or its navbar menu / scene tab in the DOM.

export const TCODE_PLAYER_NOTICE =
  "TCode Player is still installed — uninstall it in Settings › Plugins so the stroker isn't driven twice.";

interface WinLike {
  TCodePlayer?: unknown;
  document?: { querySelector(sel: string): unknown };
}

export function tcodePlayerPresent(win: WinLike | undefined = globalThis as WinLike): boolean {
  if (!win) return false;
  if (win.TCodePlayer !== undefined && win.TCodePlayer !== null) return true;
  try {
    return !!win.document?.querySelector(".tcp-nav, .tcp-panel, .tcp-nav-toggle");
  } catch {
    return false;
  }
}
