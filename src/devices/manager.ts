// Holds every device instance (src/devices/instances.ts: one per registered
// kind by default, more when the user adds them), fans the engine's frames,
// nudges and stops out to them, and keeps dropped links coming back.
//
// - Each instance gets its own ToyDevice from the driver registry, made with
//   a DriverContext that names the instance and shares the page's claim
//   registry (claims.ts), so two instances never drive one physical device.
//   Devices are created on first use (eagerly for the instances known when
//   the manager is made). The instance list is per browser (localStorage
//   toysync.instances); add, rename and remove persist it.
// - Everything is addressed by instance id; the first instance of a kind has
//   the kind as its id, so connect("lovense") and device("coyote-v3") keep
//   working. The first instance can't be removed.
// - connect(id) must run in a user gesture the first time: it is the
//   driver's Bluetooth / serial picker. resumeAll() reconnects devices granted
//   on an earlier visit without a picker.
// - A device that was connected and drops while still wanted is retried with
//   its resume() (backing off), unless the driver reconnects on its own
//   (selfReconnects). disconnect(id) ends the wish.
// - DriveFrame devices get the engine's frames (their own instance's frame
//   when the engine made one, else the default frame). Self-timed devices
//   (selfTimed: true) never get frames: they get setProgram() with the open
//   scene's program when a scene with a script opens, when its mapping /
//   options change (live edits included), and setProgram(null) when it
//   closes or has no script. Unchanged programs aren't sent again.
// - Removing an instance disconnects it (which outputs 0), makes the driver
//   forget its remembered device, disposes it and frees its claims.
// - One throwing driver never stops the others.
// Time and timers are injected; no DOM.
import { activeMapping } from "../mapping/frame.ts";
import { isSelfTimed } from "../mapping/effective.ts";
import { createListeners, GLOBAL_TIMERS, type Timers } from "../util/timers.ts";
import type { StorageLike } from "./calibration.ts";
import { createClaimRegistry, type ClaimRegistry } from "./claims.ts";
import {
  cleanName,
  defaultInstanceName,
  instanceIdFor,
  loadInstances,
  nextInstanceId,
  ordinalOf,
  saveInstances,
  sortInstances,
  type DeviceInstance,
  type InstanceInfo,
} from "./instances.ts";
import { DRIVERS, driverLabel, type DriverBaseContext, type DriverContext, type DriverRegistry } from "./registry.ts";
import type {
  ChannelMapping,
  DeviceKind,
  DeviceProgram,
  DeviceStatus,
  DriveFrame,
  PlaybackClock,
  ScriptChannel,
  SelfTimedDevice,
  ToyDevice,
} from "./types.ts";

export interface DeviceEntry {
  /** "coyote-v3", "coyote-v3:2", … */
  instanceId: string;
  /** the instance's nickname */
  name: string;
  kind: DeviceKind;
  /** the physical device id (ToyDevice.id) */
  id: string;
  status: DeviceStatus;
}

/** the open scene, as the manager turns it into each device's DeviceProgram */
export interface SceneProgramSource {
  sceneId: string;
  clock: PlaybackClock;
  /** the scene's script channels (empty: no script, every program is null) */
  channels: readonly ScriptChannel[];
  /** a device's effective mapping for the scene ("off" entries are dropped for the program) */
  mapping(device: ToyDevice): Readonly<Record<string, ChannelMapping>>;
  /** the scene's options for a device instance */
  options(instanceId: string): Readonly<Record<string, unknown>> | undefined;
  gain(): number;
}

export interface DeviceManager {
  /** registered kinds, in registration order */
  kinds(): DeviceKind[];
  /** every instance of a registered kind: grouped by kind (registration order), then by ordinal */
  instances(): DeviceInstance[];
  /** one instance (a kind names its first instance); undefined when unknown or its kind isn't registered */
  instance(instanceId: string): DeviceInstance | undefined;
  /** the device of an instance (created on first use); undefined for unknown instances or unregistered kinds */
  device(instanceId: string): ToyDevice | undefined;
  /** every device created so far, in instance order */
  devices(): ToyDevice[];
  /** the instance a device belongs to */
  instanceOf(device: ToyDevice): DeviceInstance | undefined;
  /** adds another instance of a registered kind (default name "<label> N"); undefined when it can't */
  addInstance(kind: DeviceKind, name?: string): DeviceInstance | undefined;
  /** renames an instance (an empty name restores the default); false when unknown */
  renameInstance(instanceId: string, name: string): boolean;
  /**
   * Removes an instance: disconnects it (0 first), forgets its remembered
   * device, disposes it and frees its claims. The first instance of a kind
   * can't be removed (false).
   */
  removeInstance(instanceId: string): boolean;
  /** user gesture -> that driver's picker (or reuse); never rejects. A kind names its first instance. */
  connect(instanceId: string): Promise<void>;
  /** outputs 0, disconnects and stops retrying that device */
  disconnect(instanceId: string): void;
  disconnectAll(): void;
  /** silent reconnect of every device granted earlier (no picker); never rejects */
  resumeAll(): Promise<void>;
  /**
   * The engine's frames for this tick: each DriveFrame device gets its
   * instance's frame from perInstance, else `frame` (null = silence for
   * all). Self-timed devices get nothing.
   */
  driveAll(frame: DriveFrame | null, perInstance?: ReadonlyMap<string, DriveFrame>): void;
  /** the open scene (or null): self-timed devices get setProgram() when their program changes */
  setScene(scene: SceneProgramSource | null): void;
  /** an instance's current program (for previews; also kept for DriveFrame devices), null without a scene / script */
  program(instanceId: string): DeviceProgram | null;
  /** one nudge on every device that has one; returns how many nudged */
  nudgeAll(): number;
  /** output 0 on every device now, keep the connections */
  stopAll(): void;
  /** instance, name, kind, id and status of every device */
  statuses(): DeviceEntry[];
  /** any device's status changed, or an instance was created, added, renamed or removed */
  onChange(cb: (entries: DeviceEntry[]) => void): () => void;
  dispose(): void;
}

export interface DeviceManagerOptions {
  /** what every driver instance shares; the manager adds `instance` and `claims` */
  context: DriverBaseContext;
  registry?: DriverRegistry;
  timers?: Timers;
  /** retry delays after a drop, ms; the last one repeats */
  retryDelaysMs?: number[];
  /** where the instance list lives; default localStorage, null = nowhere (the default list, never saved) */
  storage?: StorageLike | null;
  /** the page's claim registry; default a new one that names holders by instance name */
  claims?: ClaimRegistry;
}

export const DEFAULT_RETRY_DELAYS_MS = [1000, 2000, 5000, 10_000];

interface Slot {
  instanceId: string;
  device: ToyDevice;
  /** the user wants it connected (it connected, and disconnect() wasn't called since) */
  wanted: boolean;
  attempt: number;
  timer: unknown;
  unsubscribe: () => void;
  program: DeviceProgram | null;
  /** identifies `program` (scene, channels, mapping, options); null = no program */
  programKey: string | null;
}

function safely(what: string, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    console.error(`[toysync] ${what} failed`, err);
  }
}

function defaultStorage(): StorageLike | undefined {
  try {
    return globalThis.localStorage ?? undefined;
  } catch {
    return undefined;
  }
}

export function createDeviceManager(opts: DeviceManagerOptions): DeviceManager {
  const registry = opts.registry ?? DRIVERS;
  const timers = opts.timers ?? GLOBAL_TIMERS;
  const delays = opts.retryDelaysMs?.length ? opts.retryDelaysMs : DEFAULT_RETRY_DELAYS_MS;
  const storage = opts.storage === null ? undefined : (opts.storage ?? defaultStorage());
  const labelOf = (kind: DeviceKind) => driverLabel(kind, registry);
  /** every instance this browser knows (also of kinds this build doesn't register) */
  let list: DeviceInstance[] = loadInstances(registry.kinds(), labelOf, storage);
  const nameOf = (id: string) => list.find((i) => i.instanceId === id)?.name;
  const claims = opts.claims ?? createClaimRegistry(nameOf);
  const slots = new Map<string, Slot>();
  const listeners = createListeners<DeviceEntry[]>();
  let disposed = false;
  let scene: SceneProgramSource | null = null;
  // identity of channel arrays, so a program key doesn't serialize every action
  const channelIds = new WeakMap<object, number>();
  let channelSeq = 0;
  const channelToken = (c: readonly ScriptChannel[]) => {
    let id = channelIds.get(c);
    if (id === undefined) channelIds.set(c, (id = ++channelSeq));
    return id;
  };

  const save = () => saveInstances(list, storage);

  /** the first instance of every registered kind exists (kinds may register late) */
  function ensureFirsts(): void {
    for (const kind of registry.kinds()) {
      if (!list.some((i) => i.instanceId === kind)) list.push({ instanceId: kind, kind, name: labelOf(kind) });
    }
  }

  function visible(): DeviceInstance[] {
    ensureFirsts();
    const kinds = registry.kinds();
    return sortInstances(
      list.filter((i) => kinds.includes(i.kind)),
      kinds,
    );
  }

  function findInstance(id: string): DeviceInstance | undefined {
    ensureFirsts();
    const inst = list.find((i) => i.instanceId === id);
    return inst && registry.get(inst.kind) ? inst : undefined;
  }

  function applyProgram(slot: Slot): void {
    const d = slot.device;
    const id = slot.instanceId;
    let program: DeviceProgram | null = null;
    let key: string | null = null;
    if (scene && scene.channels.length > 0) {
      const s = scene;
      let mapping: Record<string, ChannelMapping> = {};
      let options: Readonly<Record<string, unknown>> | undefined;
      safely(`${id} mapping`, () => {
        mapping = activeMapping(s.mapping(d));
        options = s.options(id);
      });
      program = { sceneId: s.sceneId, clock: s.clock, channels: s.channels, mapping, gain: () => s.gain() };
      if (options) program.options = options;
      key = JSON.stringify([s.sceneId, channelToken(s.channels), mapping, options ?? null]);
    }
    if (key === slot.programKey) return;
    slot.programKey = key;
    slot.program = program;
    if (isSelfTimed(d)) safely(`${id} setProgram`, () => (d as SelfTimedDevice).setProgram(program));
  }

  function statuses(): DeviceEntry[] {
    const out: DeviceEntry[] = [];
    for (const inst of visible()) {
      const slot = slots.get(inst.instanceId);
      if (!slot) continue;
      out.push({ instanceId: inst.instanceId, name: inst.name, kind: inst.kind, id: slot.device.id, status: slot.device.status() });
    }
    return out;
  }

  function changed(): void {
    listeners.emit(statuses());
  }

  function clearRetry(slot: Slot): void {
    if (slot.timer !== undefined) timers.clearTimeout(slot.timer);
    slot.timer = undefined;
  }

  const alive = (slot: Slot) => !disposed && slots.get(slot.instanceId) === slot;

  function maybeRetry(slot: Slot): void {
    const d = slot.device;
    if (!alive(slot) || !slot.wanted || d.selfReconnects || typeof d.resume !== "function" || slot.timer !== undefined) return;
    const c = d.status().connection;
    if (c === "connected" || c === "connecting") return;
    const delay = delays[Math.min(slot.attempt, delays.length - 1)]!;
    slot.attempt++;
    slot.timer = timers.setTimeout(() => {
      slot.timer = undefined;
      if (!slot.wanted || !alive(slot)) return;
      let p: Promise<void>;
      try {
        p = d.resume!();
      } catch (err) {
        p = Promise.reject(err);
      }
      p.catch((err: unknown) => console.error("[toysync] resume failed", err)).finally(() => maybeRetry(slot));
    }, delay);
  }

  function slotFor(instanceId: string): Slot | undefined {
    const have = slots.get(instanceId);
    if (have || disposed) return have;
    const inst = findInstance(instanceId);
    if (!inst) return undefined;
    const reg = registry.get(inst.kind)!;
    const id = inst.instanceId;
    const info: InstanceInfo = {
      id,
      ordinal: ordinalOf(id),
      // live: a rename reaches the driver (e.g. its "already connected as" message)
      get name() {
        return nameOf(id) ?? inst.name;
      },
    };
    const context: DriverContext = { ...opts.context, instance: info, claims };
    let device: ToyDevice;
    try {
      device = reg.factory(context);
    } catch (err) {
      console.error(`[toysync] the ${inst.kind} driver failed to start (${id})`, err);
      return undefined;
    }
    const slot: Slot = { instanceId: id, device, wanted: false, attempt: 0, timer: undefined, unsubscribe: () => undefined, program: null, programKey: null };
    slots.set(id, slot);
    applyProgram(slot);
    slot.unsubscribe = device.onStatus((s) => {
      if (s.connection === "connected") {
        slot.wanted = true;
        slot.attempt = 0;
        clearRetry(slot);
      } else if (s.connection !== "connecting") {
        maybeRetry(slot);
      }
      if (alive(slot)) changed();
    });
    changed();
    return slot;
  }

  function disconnect(instanceId: string): void {
    const slot = slots.get(instanceId);
    if (!slot) return;
    slot.wanted = false;
    clearRetry(slot);
    safely(`disconnecting ${instanceId}`, () => slot.device.disconnect());
  }

  for (const inst of visible()) slotFor(inst.instanceId);

  return {
    kinds: () => registry.kinds(),
    instances: () => visible().map((i) => ({ ...i })),
    instance(id) {
      const inst = findInstance(id);
      return inst && { ...inst };
    },
    device: (id) => slotFor(id)?.device,
    devices: () => visible().flatMap((i) => slots.get(i.instanceId)?.device ?? []),
    instanceOf(device) {
      for (const slot of slots.values()) {
        if (slot.device !== device) continue;
        const inst = findInstance(slot.instanceId);
        return inst && { ...inst };
      }
      return undefined;
    },
    addInstance(kind, name) {
      if (disposed || !registry.get(kind)) return undefined;
      ensureFirsts();
      const id = nextInstanceId(list, kind);
      if (!id) return undefined;
      const inst: DeviceInstance = { instanceId: id, kind, name: cleanName(name) ?? defaultInstanceName(labelOf(kind), ordinalOf(id)) };
      list = sortInstances([...list, inst], registry.kinds());
      save();
      if (!slotFor(id)) changed();
      return { ...inst };
    },
    renameInstance(id, name) {
      const inst = findInstance(id);
      if (!inst) return false;
      const next = cleanName(name) ?? defaultInstanceName(labelOf(inst.kind), ordinalOf(id));
      if (next === inst.name) return true;
      list = list.map((i) => (i.instanceId === id ? { ...i, name: next } : i));
      save();
      changed();
      return true;
    },
    removeInstance(id) {
      const inst = findInstance(id);
      if (!inst || id === instanceIdFor(inst.kind, 1)) return false;
      const slot = slots.get(id);
      if (slot) {
        slot.wanted = false;
        clearRetry(slot);
        slots.delete(id);
        // 0 first (every driver's disconnect outputs 0), then the driver forgets the device
        safely(`disconnecting ${id}`, () => slot.device.disconnect());
        safely(`${id} forget`, () => slot.device.forget?.());
        slot.unsubscribe();
        safely(`${id} dispose`, () => slot.device.dispose?.());
      }
      claims.releaseAll(id);
      list = list.filter((i) => i.instanceId !== id);
      save();
      changed();
      return true;
    },
    async connect(id) {
      const slot = slotFor(id);
      if (!slot) return;
      clearRetry(slot);
      slot.attempt = 0;
      try {
        await slot.device.connect();
      } catch (err) {
        console.error(`[toysync] connecting ${id} failed`, err);
      }
    },
    disconnect,
    disconnectAll() {
      for (const id of [...slots.keys()]) disconnect(id);
    },
    async resumeAll() {
      for (const inst of visible()) slotFor(inst.instanceId);
      await Promise.all(
        [...slots.values()].map(async (slot) => {
          if (typeof slot.device.resume !== "function") return;
          try {
            await slot.device.resume();
          } catch (err) {
            console.error(`[toysync] resuming ${slot.instanceId} failed`, err);
          }
        }),
      );
    },
    driveAll(frame, perInstance) {
      for (const slot of slots.values()) {
        const d = slot.device;
        if (isSelfTimed(d)) continue;
        const f = frame === null ? null : (perInstance?.get(slot.instanceId) ?? frame);
        safely(`${slot.instanceId} drive`, () => d.drive(f));
      }
    },
    setScene(next) {
      scene = next;
      for (const slot of slots.values()) applyProgram(slot);
    },
    program: (id) => slots.get(id)?.program ?? null,
    nudgeAll() {
      let n = 0;
      for (const slot of slots.values()) {
        safely(`${slot.instanceId} nudge`, () => {
          if (slot.device.nudge()) n++;
        });
      }
      return n;
    },
    stopAll() {
      for (const slot of slots.values()) safely(`${slot.instanceId} stop`, () => slot.device.stopNow());
    },
    statuses,
    onChange: (cb) => listeners.add(cb),
    dispose() {
      disposed = true;
      for (const slot of slots.values()) {
        clearRetry(slot);
        slot.unsubscribe();
        safely(`${slot.instanceId} dispose`, () => slot.device.dispose?.());
      }
      listeners.clear();
    },
  };
}
