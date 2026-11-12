// Mounted next to stash's ScenePlayer (see patch.tsx). Loads the scene's
// funscript, ticks the sync engine from the player every TICK_MS and shows
// the bar. stash keeps ScenePlayer (and so this slot) mounted across
// scene changes; the script follows scene.id.
import { loadFunscript } from "../funscript/load.ts";
import type { Funscript } from "../funscript/parse.ts";
import { driverLabel } from "../devices/registry.ts";
import type { DeviceKind } from "../devices/types.ts";
import { getRuntime } from "../runtime.ts";
import { useDeviceEntries, useGain, useSyncedSettings } from "../ui/hooks.ts";
import { pluginApi } from "../ui/pluginApi.ts";
import { readPlayback, VIDEO_PLAYER_ID } from "./playback.ts";
import { ToySyncBar } from "./ToySyncBar.tsx";
import { shouldRender, type ScriptState } from "./view.ts";

export const TICK_MS = 50;
const MEDIA_EVENTS = ["pause", "play", "playing", "ended", "seeking", "seeked", "waiting", "emptied"];

export interface StashScene {
  id?: string;
  title?: string;
  interactive?: boolean;
}

function playerGetters(): (() => unknown)[] {
  return [
    () => pluginApi().utils?.InteractiveUtils?.getPlayer?.(),
    () => (window as unknown as { videojs?: { getPlayer?: (id: string) => unknown } }).videojs?.getPlayer?.(VIDEO_PLAYER_ID),
  ];
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
        // a stroke, or embedded axes (e-stim scripts may have no stroke at all)
        const usable = f && (f.actions.length > 0 || f.axes.size > 0);
        setLoad(usable ? { sceneId, state: "ready", script: f } : { sceneId, state: "missing" });
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

export function ToySyncSlot(props: { scene?: StashScene }) {
  const rt = getRuntime();
  const settings = useSyncedSettings(rt);
  const entries = useDeviceEntries(rt.manager);
  const gain = useGain(rt.gains);
  const interactive = props.scene?.interactive === true;
  const sceneId = props.scene?.id != null ? String(props.scene.id) : undefined;
  const load = useFunscript(interactive ? sceneId : undefined);

  React.useEffect(() => {
    rt.engine.setScript(load.state === "ready" ? load.script : undefined);
  }, [rt, load]);

  // the open scene: nudges need one, the devices page shows its mapping
  const title = props.scene?.title || undefined;
  React.useEffect(() => {
    if (!sceneId) {
      rt.scene.set(undefined);
      return;
    }
    const mapping = rt.engine.mapping();
    rt.scene.set({ id: sceneId, interactive, scriptState: interactive ? load.state : "none", ...(title ? { title } : {}), ...(mapping ? { mapping } : {}) });
  }, [rt, sceneId, title, interactive, load, settings]);
  React.useEffect(() => () => rt.scene.set(undefined), [rt]);

  // devices paired on an earlier visit reconnect without a click
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
      // unmount: every device stops
      rt.engine.stop();
    };
  }, [rt]);

  const onConnect = React.useCallback(
    (kind: DeviceKind) => {
      // called in the click handler: the user gesture the Bluetooth picker needs
      void rt.manager.connect(kind);
    },
    [rt],
  );
  const onStop = React.useCallback(() => {
    // Stop means stopped: output 0 everywhere and disconnect, so the next tick can't start it again
    rt.engine.stop();
    rt.manager.stopAll();
    rt.manager.disconnectAll();
  }, [rt]);

  if (!shouldRender(interactive, entries)) return null;
  return (
    <ToySyncBar
      entries={entries}
      kinds={rt.manager.kinds()}
      label={(kind) => driverLabel(kind)}
      interactive={interactive}
      scriptState={load.state}
      gain={gain}
      onConnect={onConnect}
      onStop={onStop}
    />
  );
}
