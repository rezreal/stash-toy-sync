// Ties the open scene to the devices: its script goes to the engine, its
// mapping (the store's working copy, so edits apply live) becomes each
// device instance's effective mapping (from the map's entry under the
// instance id: every instance has its own, nothing is shared between two
// instances of a kind), which goes to the engine (DriveFrame devices: their
// own frames) and to the manager (self-timed devices: setProgram). Its
// offset goes to the engine and the clock.
//
// Recomputes when the scene or its script changes, the working copy changes,
// the settings change (axisMap feeds the built-in default) and when the
// manager reports a change (a device was created, added or removed, or a
// driver's own default may have changed); the manager doesn't resend
// unchanged programs.
import type { DeviceManager } from "../devices/manager.ts";
import type { ChannelMapping, ScriptChannel, ToyDevice } from "../devices/types.ts";
import type { Funscript } from "../funscript/parse.ts";
import type { VideoClock } from "../player/clock.ts";
import type { SyncEngine } from "../sync/engine.ts";
import type { Settings } from "../sync/settings.ts";
import { deviceMapping, isSelfTimed } from "./effective.ts";
import { activeMapping } from "./frame.ts";
import type { SceneMap } from "./sceneMap.ts";
import type { SceneMapStore } from "./store.ts";

export interface SceneBinding {
  sceneId: string;
  /** the scene's funscript; undefined while loading or when it has none */
  script: Funscript | undefined;
}

export interface SceneBinder {
  /** the scene open in the player (undefined: none) */
  setScene(s: SceneBinding | undefined): void;
  sceneId(): string | undefined;
  channels(): readonly ScriptChannel[];
  /** a device's effective mapping for the open scene, every channel ("off" included) */
  mappingFor(device: ToyDevice): Record<string, ChannelMapping>;
  /** recompute now (e.g. a driver's default mapping changed) */
  refresh(): void;
  /** the effective mappings or the scene changed */
  onChange(cb: () => void): () => void;
  dispose(): void;
}

export interface SceneBinderDeps {
  manager: Pick<DeviceManager, "instances" | "device" | "instanceOf" | "setScene" | "onChange">;
  engine: Pick<SyncEngine, "setScript" | "channels" | "setDeviceMappings" | "setOffsetMs">;
  store: Pick<SceneMapStore, "state" | "onChange">;
  settings: { get(): Settings; onChange(cb: (s: Settings) => void): () => void };
  clock: Pick<VideoClock, "setOffsetMs" | "notify" | "scriptMs" | "playing" | "onChange">;
  gain(): number;
}

export function createSceneBinder(deps: SceneBinderDeps): SceneBinder {
  let scene: SceneBinding | undefined;
  let offset = 0;
  let mappings = new Map<ToyDevice, Record<string, ChannelMapping>>();
  let key = "";
  const listeners = new Set<() => void>();

  /** a device's instance id (its key in the scene map) */
  const idOf = (d: ToyDevice) => deps.manager.instanceOf(d)?.instanceId ?? d.kind;

  function sceneMap(): SceneMap | undefined {
    const st = deps.store.state();
    return scene && st && st.sceneId === scene.sceneId ? st.edit : undefined;
  }

  function recompute(): void {
    const sceneId = scene?.sceneId;
    const channels = deps.engine.channels();
    const map = sceneMap();
    const nextOffset = map?.offsetMs ?? 0;
    if (nextOffset !== offset) {
      offset = nextOffset;
      deps.engine.setOffsetMs(offset);
      deps.clock.setOffsetMs(offset);
      // the script time jumped: self-timed drivers resync
      if (sceneId) deps.clock.notify("seek");
    }
    const axisMap = deps.settings.get().axisMap;
    const next = new Map<ToyDevice, Record<string, ChannelMapping>>();
    const perInstance = new Map<string, Record<string, ChannelMapping>>();
    const keyed: [string, Record<string, ChannelMapping>][] = [];
    for (const inst of deps.manager.instances()) {
      const d = deps.manager.device(inst.instanceId);
      if (!d) continue;
      let m: Record<string, ChannelMapping> = {};
      try {
        m = deviceMapping(d, channels, map, axisMap, inst.instanceId);
      } catch (err) {
        console.error(`[toysync] mapping for ${inst.instanceId} failed`, err);
      }
      next.set(d, m);
      keyed.push([inst.instanceId, m]);
      if (!isSelfTimed(d)) perInstance.set(inst.instanceId, activeMapping(m));
    }
    mappings = next;
    deps.engine.setDeviceMappings(perInstance);
    deps.manager.setScene(
      sceneId && channels.length > 0
        ? {
            sceneId,
            clock: deps.clock,
            channels,
            mapping: (d) => mappings.get(d) ?? deviceMapping(d, channels, map, axisMap, idOf(d)),
            options: (instanceId) => map?.devices[instanceId]?.options,
            gain: deps.gain,
          }
        : null,
    );
    const k = JSON.stringify([sceneId ?? null, channels.length, offset, keyed]);
    if (k === key) return;
    key = k;
    for (const cb of [...listeners]) {
      try {
        cb();
      } catch (err) {
        console.error("[toysync] binder listener failed", err);
      }
    }
  }

  const stops = [deps.store.onChange(recompute), deps.settings.onChange(recompute), deps.manager.onChange(recompute)];

  return {
    setScene(s) {
      const sceneChanged = s?.sceneId !== scene?.sceneId;
      const scriptChanged = s?.script !== scene?.script;
      scene = s ? { ...s } : undefined;
      if (scriptChanged || sceneChanged) deps.engine.setScript(s?.script);
      recompute();
      if (sceneChanged) deps.clock.notify("scene");
    },
    sceneId: () => scene?.sceneId,
    channels: () => deps.engine.channels(),
    mappingFor(device) {
      return mappings.get(device) ?? deviceMapping(device, deps.engine.channels(), sceneMap(), deps.settings.get().axisMap, idOf(device));
    },
    refresh: recompute,
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    dispose() {
      for (const stop of stops) stop();
      listeners.clear();
    },
  };
}
