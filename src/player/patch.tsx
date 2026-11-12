// Hooks the slot onto stash's own scene player:
// PluginApi.patch.after("ScenePlayer", (props, result) => <>{result}<Slot/></>).
// The after-fn runs inside ScenePlayer's render, so it must not call hooks;
// all state lives in the ToySyncSlot component. Coexists with Skilltree's
// patch on the same component (see appendSlot.ts).
import { pluginApi } from "../ui/pluginApi.ts";
import { appendSlot, type ReactLike } from "./appendSlot.ts";
import { ToySyncSlot, type StashScene } from "./ToySyncSlot.tsx";

let registered = false;

export function registerScenePlayerPatch(): void {
  if (registered) return;
  registered = true;
  pluginApi().patch.after("ScenePlayer", (...args: unknown[]) => {
    const props = args[0] as { scene?: StashScene } | undefined;
    const result = args[args.length - 1];
    return appendSlot(result, <ToySyncSlot key="toysync" scene={props?.scene} />, React as unknown as ReactLike);
  });
}
