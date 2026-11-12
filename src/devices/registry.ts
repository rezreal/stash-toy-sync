// Driver registry: each device kind registers a factory once, at import
// time. src/index.tsx imports the drivers' register modules
// (src/lovense/register.ts, src/coyote/register.ts, …), which call
// registerDriver(kind, factory). The DeviceManager calls the factory once
// per device instance of that kind (src/devices/instances.ts).
import type { Settings } from "../sync/settings.ts";
import type { Timers } from "../util/timers.ts";
import type { ClaimRegistry } from "./claims.ts";
import type { InstanceInfo } from "./instances.ts";
import type { DeviceKind, ToyDevice } from "./types.ts";

/** What every driver instance shares: the plugin side of its context. */
export interface DriverBaseContext {
  /** the current plugin settings (Settings › Plugins › Toy Sync), already parsed and clamped */
  settings(): Settings;
  /** called whenever the settings change; returns an unsubscribe */
  onSettings(cb: (s: Settings) => void): () => void;
  timers: Timers;
  now: () => number;
}

/** What a driver gets from the plugin when it is created: one per device instance. */
export interface DriverContext extends DriverBaseContext {
  /**
   * The instance this device is: id ("coyote-v3", "coyote-v3:2"), live
   * nickname and ordinal (1 = the first of its kind). Keep per-instance
   * storage apart with instanceStorageKey() (the first instance keeps the
   * old keys).
   */
  instance: InstanceInfo;
  /**
   * Which instance holds which physical device (page-wide). Claim the
   * device's key when picking it, release it on disconnect and dispose;
   * never take one another instance holds (src/devices/claims.ts).
   */
  claims: ClaimRegistry;
}

export type DriverFactory = (ctx: DriverContext) => ToyDevice;

export interface DriverInfo {
  /** e.g. "DG-Lab Coyote 3.0" */
  label: string;
  /** one line for the devices page, e.g. "E-stim, two channels" */
  description?: string;
}

export interface DriverRegistration {
  kind: DeviceKind;
  factory: DriverFactory;
  info: DriverInfo;
}

export interface DriverRegistry {
  /** registers (or replaces) the driver of a kind */
  register(kind: DeviceKind, factory: DriverFactory, info?: DriverInfo): void;
  get(kind: DeviceKind): DriverRegistration | undefined;
  /** registered kinds, in registration order */
  kinds(): DeviceKind[];
}

export const DEFAULT_DRIVER_INFO: Record<DeviceKind, DriverInfo> = {
  lovense: { label: "Lovense", description: "Vibrator, one motor level (0–20)" },
  "coyote-v2": { label: "DG-Lab Coyote 2.0", description: "E-stim, two channels" },
  "coyote-v3": { label: "DG-Lab Coyote 3.0", description: "E-stim, two channels" },
  tcode: { label: "TCode device", description: "OSR2 / SR6 / SSR1 over USB serial" },
  piupiu: { label: "Hismith PiuPiu", description: "Lube launcher" },
};

export function createDriverRegistry(): DriverRegistry {
  const map = new Map<DeviceKind, DriverRegistration>();
  return {
    register(kind, factory, info) {
      map.set(kind, { kind, factory, info: info ?? DEFAULT_DRIVER_INFO[kind] ?? { label: kind } });
    },
    get: (kind) => map.get(kind),
    kinds: () => [...map.keys()],
  };
}

/** the page-wide registry the plugin's DeviceManager uses */
export const DRIVERS: DriverRegistry = createDriverRegistry();

/**
 * Registers a driver with the page-wide registry. Call it at module top level
 * of the driver's register.ts and import that module from src/index.tsx:
 *
 *   registerDriver("coyote-v3", (ctx) => createCoyoteV3(ctx));
 */
export function registerDriver(kind: DeviceKind, factory: DriverFactory, info?: DriverInfo): void {
  DRIVERS.register(kind, factory, info);
}

/** the display name of a kind ("DG-Lab Coyote 3.0") */
export function driverLabel(kind: DeviceKind, registry: DriverRegistry = DRIVERS): string {
  return registry.get(kind)?.info.label ?? DEFAULT_DRIVER_INFO[kind]?.label ?? kind;
}
