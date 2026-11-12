// The page-wide objects: the settings, the devices (one per registered
// driver), one gain combiner and one sync engine. They outlive scene changes
// (stash keeps the scene player mounted across scenes) and are shared with
// the hook contract and the pages.
import { createDeviceManager, type DeviceManager } from "./devices/manager.ts";
import type { DriverContext } from "./devices/registry.ts";
import type { LovenseToy } from "./lovense/toy.ts";
import { createSyncEngine, type SyncEngine } from "./sync/engine.ts";
import { createGainCombiner, type GainCombiner } from "./sync/gain.ts";
import { createNudgeLimiter, type NudgeLimiter } from "./sync/nudge.ts";
import { createSceneTracker, type SceneTracker } from "./sync/scene.ts";
import { createSettingsStore, type Settings, type SettingsStore } from "./sync/settings.ts";
import { defaultNow, GLOBAL_TIMERS } from "./util/timers.ts";

export interface Runtime {
  settings: SettingsStore;
  manager: DeviceManager;
  gains: GainCombiner;
  engine: SyncEngine;
  /** the nudge limits of the hook contract (cooldown, per minute, scene open) */
  nudges: NudgeLimiter;
  /** the scene open in the player, and the last one */
  scene: SceneTracker;
  /** applies new settings everywhere (engine, drivers); a no-op when nothing changed */
  setSettings(s: Settings): void;
  /** the Lovense driver, when registered (legacy status and the deprecated window.stashLovense) */
  lovense(): LovenseToy | undefined;
}

let runtime: Runtime | undefined;

export function getRuntime(): Runtime {
  if (runtime) return runtime;
  const settings = createSettingsStore();
  const context: DriverContext = {
    settings: () => settings.get(),
    onSettings: (cb) => settings.onChange(cb),
    timers: GLOBAL_TIMERS,
    now: defaultNow,
  };
  const manager = createDeviceManager({ context });
  const gains = createGainCombiner();
  const engine = createSyncEngine({ output: { drive: (f) => manager.driveAll(f) }, gain: () => gains.gain() });
  const nudges = createNudgeLimiter(defaultNow);
  const scene = createSceneTracker();
  settings.onChange((s) => {
    engine.setSettings(s);
    nudges.setLimits({ cooldownMs: s.nudgeCooldownSec * 1000, perMinute: s.nudgesPerMinute });
  });
  // a new gain applies right away (the drivers still rate-limit)
  gains.onChange(() => engine.refresh());
  runtime = {
    settings,
    manager,
    gains,
    engine,
    nudges,
    scene,
    setSettings: (s) => settings.set(s),
    lovense: () => manager.device("lovense") as LovenseToy | undefined,
  };
  return runtime;
}
