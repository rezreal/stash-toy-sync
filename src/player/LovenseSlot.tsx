// Mounted next to stash's ScenePlayer (see patch.tsx). Loads the scene's
// funscript, ticks the sync engine from the player every TICK_MS and shows
// the control. stash keeps ScenePlayer (and so this slot) mounted across
// scene changes; the script follows scene.id.
import { loadFunscript } from "../funscript/load.ts";
import type { Funscript } from "../funscript/parse.ts";
import type { LovenseStatus } from "../lovense/device.ts";
import type { LovenseToy } from "../lovense/toy.ts";
import { getRuntime } from "../runtime.ts";
import type { GainCombiner } from "../sync/gain.ts";
import { parseSettings } from "../sync/settings.ts";
import { pluginApi, usePluginSettings } from "../ui/pluginApi.ts";
import { LovenseControl } from "./LovenseControl.tsx";
import { readPlayback, VIDEO_PLAYER_ID } from "./playback.ts";
import { shouldRender, type ScriptState } from "./view.ts";

export const TICK_MS = 50;
const MEDIA_EVENTS = ["pause", "play", "playing", "ended", "seeking", "seeked", "waiting", "emptied"];

export interface StashScene {
  id?: string;
  interactive?: boolean;
}

function playerGetters(): (() => unknown)[] {
  return [
    () => pluginApi().utils?.InteractiveUtils?.getPlayer?.(),
    () => (window as unknown as { videojs?: { getPlayer?: (id: string) => unknown } }).videojs?.getPlayer?.(VIDEO_PLAYER_ID),
  ];
}

function useLovenseStatus(toy: LovenseToy | undefined): LovenseStatus {
  const [status, setStatus] = React.useState<LovenseStatus>(() => toy?.legacyStatus() ?? { connection: "disconnected" });
  React.useEffect(() => {
    if (!toy) return;
    setStatus(toy.legacyStatus());
    return toy.onLegacyStatus(setStatus);
  }, [toy]);
  return status;
}

function useGain(gains: GainCombiner): number {
  const [gain, setGain] = React.useState(() => gains.gain());
  React.useEffect(() => {
    setGain(gains.gain());
    return gains.onChange(setGain);
  }, [gains]);
  return gain;
}

interface ScriptLoad {
  sceneId?: string;
  state: ScriptState;
  script?: Funscript;
}

function useFunscript(sceneId: string | undefined): ScriptLoad {
  const [load, setLoad] = React.useState<ScriptLoad>({ state: "none" });
  React.useEffect(() => {
    if (!sceneId) {
      setLoad({ state: "none" });
      return;
    }
    let alive = true;
    setLoad({ sceneId, state: "loading" });
    loadFunscript(sceneId).then(
      (f) => {
        if (!alive) return;
        setLoad(f && f.actions.length > 0 ? { sceneId, state: "ready", script: f } : { sceneId, state: "missing" });
      },
      (err: unknown) => {
        if (!alive) return;
        console.warn("[toysync] funscript failed to load", err);
        setLoad({ sceneId, state: "error" });
      },
    );
    return () => {
      alive = false;
    };
  }, [sceneId]);
  return load;
}

export function LovenseSlot(props: { scene?: StashScene }) {
  const rt = getRuntime();
  const raw = usePluginSettings();
  const rawKey = JSON.stringify(raw);
  // ScenePlayer re-renders on every timeupdate: parse only when the settings change
  const settings = React.useMemo(() => parseSettings(raw), [rawKey]);
  const lovense = rt.lovense();
  const status = useLovenseStatus(lovense);
  const gain = useGain(rt.gains);
  const interactive = props.scene?.interactive === true;
  const sceneId = props.scene?.id != null ? String(props.scene.id) : undefined;
  const load = useFunscript(interactive ? sceneId : undefined);

  React.useEffect(() => {
    rt.setSettings(settings);
  }, [rt, settings]);

  React.useEffect(() => {
    rt.engine.setScript(load.state === "ready" ? load.script : undefined);
  }, [rt, load]);

  // a toy paired on an earlier visit reconnects without a click
  React.useEffect(() => {
    if (interactive) void rt.manager.resumeAll();
  }, [rt, interactive]);

  React.useEffect(() => {
    const getters = playerGetters();
    const tick = () => rt.engine.tick(readPlayback(document.getElementById(VIDEO_PLAYER_ID), getters));
    tick();
    const id = window.setInterval(tick, TICK_MS);
    // react to pause / end / seek right away, not on the next tick (timers
    // run slower in background tabs). Media events don't bubble, but a
    // capturing listener on the document sees them.
    const onMedia = (e: Event) => {
      const root = document.getElementById(VIDEO_PLAYER_ID);
      if (root && e.target instanceof Node && root.contains(e.target)) tick();
    };
    for (const name of MEDIA_EVENTS) document.addEventListener(name, onMedia, true);
    return () => {
      window.clearInterval(id);
      for (const name of MEDIA_EVENTS) document.removeEventListener(name, onMedia, true);
      // unmount: the toy stops
      rt.engine.stop();
    };
  }, [rt]);

  const onConnect = React.useCallback(() => {
    // called in the click handler: the user gesture the Bluetooth picker needs
    void rt.manager.connect("lovense");
  }, [rt]);
  const onTest = React.useCallback(() => rt.lovense()?.test(), [rt]);
  const onStop = React.useCallback(() => {
    rt.engine.stop();
    rt.manager.stopAll();
    rt.manager.disconnectAll();
  }, [rt]);

  if (!shouldRender(interactive, status)) return null;
  return (
    <LovenseControl
      status={status}
      interactive={interactive}
      scriptState={load.state}
      gain={gain}
      onConnect={onConnect}
      onTest={onTest}
      onStop={onStop}
    />
  );
}
