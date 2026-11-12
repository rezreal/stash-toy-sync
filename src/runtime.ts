// The page-wide objects: the settings, the devices (one per device instance:
// by default one per registered driver), one gain combiner, one sync engine,
// the playback clock, the open scene's mapping and the binder that applies
// it. They outlive scene changes
// (stash keeps the scene player mounted across scenes) and are shared with
// the hook contract, the scene tab, the navbar menu and the pages.
import { createDeviceManager, type DeviceManager } from "./devices/manager.ts";
import type { DriverBaseContext } from "./devices/registry.ts";
import type { LovenseToy } from "./lovense/toy.ts";
import { createSceneBinder, type SceneBinder } from "./mapping/binder.ts";
import { SCENE_FIELD } from "./mapping/sceneMap.ts";
import { createSceneMapStore, type SceneMapStore } from "./mapping/store.ts";
import { createVideoClock, type VideoClock } from "./player/clock.ts";
import { playerGetters } from "./player/getters.ts";
import { saveSceneCustomField } from "./stash/sceneFields.ts";
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
  /** stash's scene player as a PlaybackClock (self-timed drivers read it) */
  clock: VideoClock;
  /** the open scene's mapping: saved and working copy (the scene tab edits it) */
  sceneMaps: SceneMapStore;
  /** applies the open scene's script and mapping to the engine and the devices */
  binder: SceneBinder;
  /** applies new settings everywhere (engine, drivers); a no-op when nothing changed */
  setSettings(s: Settings): void;
  /** the first Lovense instance, when registered (legacy status and the deprecated window.stashLovense) */
  lovense(): LovenseToy | undefined;
}

let runtime: Runtime | undefined;

export function getRuntime(): Runtime {
  if (runtime) return runtime;
  const settings = createSettingsStore();
  const context: DriverBaseContext = {
    settings: () => settings.get(),
    onSettings: (cb) => settings.onChange(cb),
    timers: GLOBAL_TIMERS,
    now: defaultNow,
  };
  const manager = createDeviceManager({ context });
  const gains = createGainCombiner();
  const engine = createSyncEngine({ output: { drive: (f, perKind) => manager.driveAll(f, perKind) }, gain: () => gains.gain() });
  const nudges = createNudgeLimiter(defaultNow);
  const scene = createSceneTracker();
  const clock = createVideoClock({ getters: playerGetters(), latencyMs: () => settings.get().latencyMs });
  const sceneMaps = createSceneMapStore({ saveField: (id, value) => saveSceneCustomField(id, SCENE_FIELD, value) });
  const binder = createSceneBinder({ manager, engine, store: sceneMaps, settings, clock, gain: () => gains.gain() });
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
    clock,
    sceneMaps,
    binder,
    setSettings: (s) => settings.set(s),
    lovense: () => manager.device("lovense") as LovenseToy | undefined,
  };
  return runtime;
}
