// Holds every device (one per registered kind), fans the engine's frames,
// nudges and stops out to them, and keeps dropped links coming back.
//
// - Devices are created from the driver registry on first use (eagerly for
//   the kinds registered when the manager is made).
// - connect(kind) must run in a user gesture the first time: it is the
//   driver's Bluetooth picker. resumeAll() reconnects devices granted on an
//   earlier visit without a picker.
// - A device that was connected and drops while still wanted is retried with
//   its resume() (backing off), unless the driver reconnects on its own
//   (selfReconnects). disconnect(kind) ends the wish.
// - One throwing driver never stops the others.
// Time and timers are injected; no DOM.
import { createListeners, GLOBAL_TIMERS, type Timers } from "../util/timers.ts";
import { DRIVERS, type DriverContext, type DriverRegistry } from "./registry.ts";
import type { DeviceKind, DeviceStatus, DriveFrame, ToyDevice } from "./types.ts";

export interface DeviceEntry {
  kind: DeviceKind;
  id: string;
  status: DeviceStatus;
}

export interface DeviceManager {
  /** registered kinds, in registration order */
  kinds(): DeviceKind[];
  /** the device of a registered kind (created on first use); undefined for unregistered kinds */
  device(kind: DeviceKind): ToyDevice | undefined;
  /** every device created so far */
  devices(): ToyDevice[];
  /** user gesture -> that driver's picker (or reuse); never rejects */
  connect(kind: DeviceKind): Promise<void>;
  /** outputs 0, disconnects and stops retrying that device */
  disconnect(kind: DeviceKind): void;
  disconnectAll(): void;
  /** silent reconnect of every device granted earlier (no picker); never rejects */
  resumeAll(): Promise<void>;
  /** the engine's frame for this tick, to every device */
  driveAll(frame: DriveFrame | null): void;
  /** one nudge on every device that has one; returns how many nudged */
  nudgeAll(): number;
  /** output 0 on every device now, keep the connections */
  stopAll(): void;
  /** kind, id and status of every device */
  statuses(): DeviceEntry[];
  /** any device's status changed (or a device was created) */
  onChange(cb: (entries: DeviceEntry[]) => void): () => void;
  dispose(): void;
}

export interface DeviceManagerOptions {
  context: DriverContext;
  registry?: DriverRegistry;
  timers?: Timers;
  /** retry delays after a drop, ms; the last one repeats */
  retryDelaysMs?: number[];
}

export const DEFAULT_RETRY_DELAYS_MS = [1000, 2000, 5000, 10_000];

interface Slot {
  device: ToyDevice;
  /** the user wants it connected (it connected, and disconnect() wasn't called since) */
  wanted: boolean;
  attempt: number;
  timer: unknown;
  unsubscribe: () => void;
}

function safely(what: string, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    console.error(`[toysync] ${what} failed`, err);
  }
}

export function createDeviceManager(opts: DeviceManagerOptions): DeviceManager {
  const registry = opts.registry ?? DRIVERS;
  const timers = opts.timers ?? GLOBAL_TIMERS;
  const delays = opts.retryDelaysMs?.length ? opts.retryDelaysMs : DEFAULT_RETRY_DELAYS_MS;
  const slots = new Map<DeviceKind, Slot>();
  const listeners = createListeners<DeviceEntry[]>();
  let disposed = false;

  function statuses(): DeviceEntry[] {
    return [...slots.values()].map((s) => ({ kind: s.device.kind, id: s.device.id, status: s.device.status() }));
  }

  function changed(): void {
    listeners.emit(statuses());
  }

  function clearRetry(slot: Slot): void {
    if (slot.timer !== undefined) timers.clearTimeout(slot.timer);
    slot.timer = undefined;
  }

  function maybeRetry(slot: Slot): void {
    const d = slot.device;
    if (disposed || !slot.wanted || d.selfReconnects || typeof d.resume !== "function" || slot.timer !== undefined) return;
    const c = d.status().connection;
    if (c === "connected" || c === "connecting") return;
    const delay = delays[Math.min(slot.attempt, delays.length - 1)]!;
    slot.attempt++;
    slot.timer = timers.setTimeout(() => {
      slot.timer = undefined;
      if (!slot.wanted || disposed) return;
      let p: Promise<void>;
      try {
        p = d.resume!();
      } catch (err) {
        p = Promise.reject(err);
      }
      p.catch((err: unknown) => console.error("[toysync] resume failed", err)).finally(() => maybeRetry(slot));
    }, delay);
  }

  function slotFor(kind: DeviceKind): Slot | undefined {
    const have = slots.get(kind);
    if (have || disposed) return have;
    const reg = registry.get(kind);
    if (!reg) return undefined;
    let device: ToyDevice;
    try {
      device = reg.factory(opts.context);
    } catch (err) {
      console.error(`[toysync] the ${kind} driver failed to start`, err);
      return undefined;
    }
    const slot: Slot = { device, wanted: false, attempt: 0, timer: undefined, unsubscribe: () => undefined };
    slots.set(kind, slot);
    slot.unsubscribe = device.onStatus((s) => {
      if (s.connection === "connected") {
        slot.wanted = true;
        slot.attempt = 0;
        clearRetry(slot);
      } else if (s.connection !== "connecting") {
        maybeRetry(slot);
      }
      changed();
    });
    changed();
    return slot;
  }

  function disconnect(kind: DeviceKind): void {
    const slot = slots.get(kind);
    if (!slot) return;
    slot.wanted = false;
    clearRetry(slot);
    safely(`disconnecting ${kind}`, () => slot.device.disconnect());
  }

  for (const kind of registry.kinds()) slotFor(kind);

  return {
    kinds: () => registry.kinds(),
    device: (kind) => slotFor(kind)?.device,
    devices: () => [...slots.values()].map((s) => s.device),
    async connect(kind) {
      const slot = slotFor(kind);
      if (!slot) return;
      clearRetry(slot);
      slot.attempt = 0;
      try {
        await slot.device.connect();
      } catch (err) {
        console.error(`[toysync] connecting ${kind} failed`, err);
      }
    },
    disconnect,
    disconnectAll() {
      for (const kind of [...slots.keys()]) disconnect(kind);
    },
    async resumeAll() {
      for (const kind of registry.kinds()) slotFor(kind);
      await Promise.all(
        [...slots.values()].map(async (slot) => {
          if (typeof slot.device.resume !== "function") return;
          try {
            await slot.device.resume();
          } catch (err) {
            console.error(`[toysync] resuming ${slot.device.kind} failed`, err);
          }
        }),
      );
    },
    driveAll(frame) {
      for (const slot of slots.values()) safely(`${slot.device.kind} drive`, () => slot.device.drive(frame));
    },
    nudgeAll() {
      let n = 0;
      for (const slot of slots.values()) {
        safely(`${slot.device.kind} nudge`, () => {
          if (slot.device.nudge()) n++;
        });
      }
      return n;
    },
    stopAll() {
      for (const slot of slots.values()) safely(`${slot.device.kind} stop`, () => slot.device.stopNow());
    },
    statuses,
    onChange: (cb) => listeners.add(cb),
    dispose() {
      disposed = true;
      for (const slot of slots.values()) {
        clearRetry(slot);
        slot.unsubscribe();
        safely(`${slot.device.kind} dispose`, () => slot.device.dispose?.());
      }
      listeners.clear();
    },
  };
}
