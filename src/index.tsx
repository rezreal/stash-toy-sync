// Plugin entry: the drivers, the scene player patch, the pages, the hook
// contract for other plugins, and a best-effort stop when the page goes away.
// Drivers register themselves with the device registry on import
// (registerDriver in src/devices/registry.ts), before the runtime is made.
import "./lovense/register.ts";
// DG-Lab Coyote e-stim drivers (branch "coyote"): uncomment once src/coyote/ exists.
// import "./coyote/register.ts";
import { installHook } from "./hook.ts";
import { registerScenePlayerPatch } from "./player/patch.tsx";
import { getRuntime } from "./runtime.ts";

const rt = getRuntime();
const lovense = rt.lovense();
installHook(window, {
  manager: rt.manager,
  engine: rt.engine,
  gains: rt.gains,
  nudges: rt.nudges,
  sceneOpen: () => rt.scene.open() !== undefined,
  legacy: lovense && {
    status: () => lovense.legacyStatus(),
    onStatus: (cb) => lovense.onLegacyStatus(cb),
    connect: () => void rt.manager.connect("lovense"),
  },
});
registerScenePlayerPatch();

// tab closed or navigated away: stop the toy (best effort, the page may be gone before the write)
const stopOnUnload = () => {
  rt.engine.stop();
  rt.manager.stopAll();
};
window.addEventListener("pagehide", stopOnUnload);
window.addEventListener("beforeunload", stopOnUnload);
