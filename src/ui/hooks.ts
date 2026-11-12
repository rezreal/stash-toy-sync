// React hooks over the page-wide runtime, shared by the player bar and the
// pages. React comes from PluginApi (injected global).
import type { DeviceEntry, DeviceManager } from "../devices/manager.ts";
import type { SceneBinder } from "../mapping/binder.ts";
import type { SceneMapState, SceneMapStore } from "../mapping/store.ts";
import type { Runtime } from "../runtime.ts";
import type { GainCombiner } from "../sync/gain.ts";
import type { SceneInfo, SceneTracker } from "../sync/scene.ts";
import { parseSettings, type Settings } from "../sync/settings.ts";
import { usePluginSettings } from "./pluginApi.ts";

/** every device's kind, id and status, live */
export function useDeviceEntries(manager: DeviceManager): DeviceEntry[] {
  const [entries, setEntries] = React.useState<DeviceEntry[]>(() => manager.statuses());
  React.useEffect(() => {
    setEntries(manager.statuses());
    return manager.onChange(setEntries);
  }, [manager]);
  return entries;
}

export function useGain(gains: GainCombiner): number {
  const [gain, setGain] = React.useState(() => gains.gain());
  React.useEffect(() => {
    setGain(gains.gain());
    return gains.onChange(setGain);
  }, [gains]);
  return gain;
}

/** the open scene, else the last one */
export function useLastScene(scene: SceneTracker): SceneInfo | undefined {
  const [info, setInfo] = React.useState<SceneInfo | undefined>(() => scene.last());
  React.useEffect(() => {
    setInfo(scene.last());
    return scene.onChange(() => setInfo(scene.last()));
  }, [scene]);
  return info;
}

/**
 * The plugin settings from stash's configuration, parsed, and applied to the
 * runtime (engine, drivers, nudge limits) whenever they change.
 */
export function useSyncedSettings(rt: Runtime): Settings {
  const raw = usePluginSettings();
  const rawKey = JSON.stringify(raw);
  // the scene player re-renders on every timeupdate: parse only when the settings change
  const settings = React.useMemo(() => parseSettings(raw), [rawKey]);
  React.useEffect(() => {
    rt.setSettings(settings);
  }, [rt, settings]);
  return settings;
}

/** re-renders every `ms` while `on` (for a live view of something without events) */
export function useTicker(on: boolean, ms: number): void {
  const [, setN] = React.useState(0);
  React.useEffect(() => {
    if (!on) return;
    const id = window.setInterval(() => setN((n) => n + 1), ms);
    return () => window.clearInterval(id);
  }, [on, ms]);
}

/** the open scene's mapping state (saved, working copy, dirty, saving), live */
export function useSceneMapState(store: SceneMapStore): SceneMapState | undefined {
  const [st, setSt] = React.useState<SceneMapState | undefined>(() => store.state());
  React.useEffect(() => {
    setSt(store.state());
    return store.onChange(() => setSt(store.state()));
  }, [store]);
  return st;
}

/** re-renders whenever the binder's effective mappings or scene change; returns a change counter */
export function useBinder(binder: SceneBinder): number {
  const [n, setN] = React.useState(0);
  React.useEffect(() => binder.onChange(() => setN((x) => x + 1)), [binder]);
  return n;
}
