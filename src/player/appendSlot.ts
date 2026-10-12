// Adds our slot after stash's ScenePlayer output without disturbing it.
//
// The result of an `after` patch is what ScenePlayer renders. React unwraps a
// top-level unkeyed fragment, so <>{result}<Slot/></> keeps stash's
// <div class="VideoPlayer"> (and the imperatively created video.js player
// inside) at child index 0. When another plugin's after-patch (Skilltree)
// already returned such a fragment, its children are flattened into ours
// instead of nesting the fragment, so stash's element stays at index 0
// whether or not that plugin added something this render.
// Pure: React is passed in, so it can be tested without React.

export interface ElementLike {
  type?: unknown;
  key?: unknown;
  props?: { children?: unknown };
}

export interface ReactLike {
  Fragment: unknown;
  createElement(type: unknown, props: unknown, ...children: unknown[]): unknown;
}

function isUnkeyedFragment(node: unknown, R: ReactLike): node is ElementLike {
  if (!node || typeof node !== "object") return false;
  const el = node as ElementLike;
  return el.type === R.Fragment && el.key == null;
}

export function appendSlot(result: unknown, slot: unknown, R: ReactLike): unknown {
  if (isUnkeyedFragment(result, R)) {
    const kids = result.props?.children;
    const list = Array.isArray(kids) ? kids : kids === undefined ? [] : [kids];
    return R.createElement(R.Fragment, null, ...list, slot);
  }
  return R.createElement(R.Fragment, null, result, slot);
}
