// Plugin entry: the scene player patch, the hook contract for other
// plugins, and a best-effort stop when the page goes away.
import { installHook } from "./hook.ts";
import { registerScenePlayerPatch } from "./player/patch.tsx";
import { getRuntime } from "./runtime.ts";
import "./coyote/register.ts";

const rt = getRuntime();
installHook(window, { device: rt.device, gains: rt.gains });
registerScenePlayerPatch();

// tab closed or navigated away: stop the toy (best effort, the page may be gone before the write)
const stopOnUnload = () => {
  rt.engine.stop();
  rt.device.stopNow();
};
window.addEventListener("pagehide", stopOnUnload);
window.addEventListener("beforeunload", stopOnUnload);
