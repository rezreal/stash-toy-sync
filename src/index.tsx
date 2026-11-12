// Plugin entry: the scene player patch, the hook contract for other
// plugins, and a best-effort stop when the page goes away.
// Drivers register themselves with the device registry on import.
import "./lovense/register.ts";
// import "./coyote/register.ts";
import { installHook } from "./hook.ts";
import { registerScenePlayerPatch } from "./player/patch.tsx";
import { getRuntime } from "./runtime.ts";

const rt = getRuntime();
installHook(window, {
  device: {
    status: () => rt.lovense()?.legacyStatus() ?? { connection: "disconnected" },
    connect: () => rt.manager.connect("lovense"),
    onStatus: (cb) => rt.lovense()?.onLegacyStatus(cb) ?? (() => undefined),
  },
  gains: rt.gains,
});
registerScenePlayerPatch();

// tab closed or navigated away: stop the toy (best effort, the page may be gone before the write)
const stopOnUnload = () => {
  rt.engine.stop();
  rt.manager.stopAll();
};
window.addEventListener("pagehide", stopOnUnload);
window.addEventListener("beforeunload", stopOnUnload);
