// The open scene's mapping: what is saved in its custom fields, the working
// copy the scene tab edits (applied live, before saving), and saving it back.
// No DOM; the write is injected (stash/sceneFields.ts in the plugin).
//
// - bind() comes from the scene props (custom_fields, first file). The same
//   scene with the same stored values keeps the working copy.
// - Save writes `toysync_map` (a partial custom_fields update). An empty map
//   removes the field, except while the scene still has a `tcode_map`: then
//   the empty map is written, so the next read doesn't migrate the old
//   mapping back in.
// - What this page saved last is remembered per scene, so a re-bind with
//   props from before the save (stash's cache) doesn't undo it.
import type { DeviceKind } from "../devices/types.ts";
import {
  cloneSceneMap,
  compactSceneMap,
  emptySceneMap,
  isEmptySceneMap,
  readSceneMap,
  SCENE_FIELD,
  serializeSceneMap,
  TCODE_FIELD,
  type ChannelOverride,
  type SceneMap,
  type SceneMapSource,
} from "./sceneMap.ts";

export interface SceneMapState {
  sceneId: string;
  /** what is stored (migrated from tcode_map when source is "tcode") */
  saved: SceneMap;
  source: SceneMapSource;
  /** the scene has a tcode_map field (TCode Player's), whatever it holds */
  hasTcodeField: boolean;
  /** the working copy: applied live */
  edit: SceneMap;
  /** edit differs from saved */
  dirty: boolean;
  /** saving makes sense: dirty, or the map still lives only in tcode_map */
  canSave: boolean;
  saving: boolean;
  /** the last save failed */
  error?: string;
}

export interface SceneMapStore {
  /** the scene open in the player and its stored fields */
  bind(sceneId: string, customFields: Readonly<Record<string, unknown>> | null | undefined, fileKey?: string): void;
  /** the scene closed (only if it is the bound one) */
  unbind(sceneId: string): void;
  state(): SceneMapState | undefined;
  /** sets (or with undefined resets to the default) one channel of one device instance (its id; the kind for the first) */
  setChannel(instanceId: DeviceKind | string, channelId: string, entry: ChannelOverride | undefined): void;
  setOffset(ms: number): void;
  /** replaces a device instance's options (undefined removes them) */
  setOptions(instanceId: DeviceKind | string, options: Record<string, unknown> | undefined): void;
  /** every device back to its default, offset 0 (saved on Save) */
  useDefaults(): void;
  /** back to what is saved */
  revert(): void;
  /** writes the working copy; resolves false (and sets error) when it failed */
  save(): Promise<boolean>;
  onChange(cb: () => void): () => void;
}

export interface SceneMapStoreOptions {
  /** writes the toysync_map field (null removes it); resolves with the scene's custom fields after the write */
  saveField(sceneId: string, value: string | null): Promise<Record<string, unknown> | void>;
}

type Fields = Readonly<Record<string, unknown>>;

export function createSceneMapStore(opts: SceneMapStoreOptions): SceneMapStore {
  let st: SceneMapState | undefined;
  let boundKey = "";
  /** sceneId -> the toysync_map value this page last wrote (null = removed) */
  const written = new Map<string, string | null>();
  const listeners = new Set<() => void>();

  function emit(): void {
    for (const cb of [...listeners]) {
      try {
        cb();
      } catch (err) {
        console.error("[toysync] scene map listener failed", err);
      }
    }
  }

  function withWritten(sceneId: string, fields: Fields | null | undefined): Fields {
    const out: Record<string, unknown> = { ...(fields ?? {}) };
    if (written.has(sceneId)) {
      const v = written.get(sceneId)!;
      if (v === null) delete out[SCENE_FIELD];
      else out[SCENE_FIELD] = v;
    }
    return out;
  }

  function refresh(s: SceneMapState): void {
    s.dirty = serializeSceneMap(s.edit) !== serializeSceneMap(s.saved);
    s.canSave = s.dirty || s.source === "tcode";
  }

  function change(fn: (s: SceneMapState) => void): void {
    if (!st) return;
    fn(st);
    refresh(st);
    st = { ...st };
    emit();
  }

  return {
    bind(sceneId, customFields, fileKey) {
      const fields = withWritten(sceneId, customFields);
      const key = JSON.stringify([sceneId, fields[SCENE_FIELD] ?? null, fields[TCODE_FIELD] ?? null, fileKey ?? null]);
      if (key === boundKey && st?.sceneId === sceneId) return;
      boundKey = key;
      const { map, source } = readSceneMap(fields, fileKey);
      const hasTcodeField = fields[TCODE_FIELD] !== undefined && fields[TCODE_FIELD] !== null;
      if (st && st.sceneId === sceneId && st.dirty) {
        // stored values changed under unsaved edits: keep the edits
        st = { ...st, saved: map, source, hasTcodeField };
      } else {
        st = { sceneId, saved: map, source, hasTcodeField, edit: cloneSceneMap(map), dirty: false, canSave: false, saving: false };
      }
      refresh(st);
      emit();
    },
    unbind(sceneId) {
      if (!st || st.sceneId !== sceneId) return;
      st = undefined;
      boundKey = "";
      emit();
    },
    state: () => st,
    setChannel(kind, channelId, entry) {
      change((s) => {
        const devices = s.edit.devices;
        const dev = (devices[kind] ??= { mapping: {} });
        if (entry === undefined || Object.keys(entry).length === 0) delete dev.mapping[channelId];
        else dev.mapping[channelId] = { ...entry };
        if (Object.keys(dev.mapping).length === 0 && !dev.options) delete devices[kind];
        s.edit = { ...s.edit, devices: { ...devices } };
      });
    },
    setOffset(ms) {
      change((s) => {
        s.edit = { ...s.edit, offsetMs: Number.isFinite(ms) ? Math.round(ms) : 0 };
      });
    },
    setOptions(kind, options) {
      change((s) => {
        const devices = s.edit.devices;
        const dev = (devices[kind] ??= { mapping: {} });
        if (options && Object.keys(options).length > 0) dev.options = { ...options };
        else delete dev.options;
        if (Object.keys(dev.mapping).length === 0 && !dev.options) delete devices[kind];
        s.edit = { ...s.edit, devices: { ...devices } };
      });
    },
    useDefaults() {
      change((s) => {
        s.edit = emptySceneMap();
      });
    },
    revert() {
      change((s) => {
        s.edit = cloneSceneMap(s.saved);
      });
    },
    async save() {
      if (!st || st.saving) return false;
      const sceneId = st.sceneId;
      const map = compactSceneMap(st.edit);
      const value = isEmptySceneMap(map) && !st.hasTcodeField ? null : serializeSceneMap(map);
      change((s) => {
        s.saving = true;
        delete s.error;
      });
      try {
        await opts.saveField(sceneId, value);
        written.set(sceneId, value);
        if (st?.sceneId === sceneId) {
          boundKey = "";
          change((s) => {
            s.saved = cloneSceneMap(map);
            s.source = value === null ? "none" : "toysync";
            s.saving = false;
          });
        }
        return true;
      } catch (err) {
        if (st?.sceneId === sceneId) {
          change((s) => {
            s.saving = false;
            s.error = err instanceof Error ? err.message : String(err);
          });
        }
        return false;
      }
    },
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}
