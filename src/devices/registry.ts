// Driver registry: each device kind registers a factory once, at import
// time. src/index.tsx imports the drivers' register modules
// (src/lovense/register.ts, later src/coyote/register.ts), which call
// registerDriver(kind, factory). The DeviceManager creates one device per
// registered kind from it.
import type { Settings } from "../sync/settings.ts";
import type { Timers } from "../util/timers.ts";
import type { DeviceKind, ToyDevice } from "./types.ts";

/** What a driver gets from the plugin when it is created. */
export interface DriverContext {
  /** the current plugin settings (Settings › Plugins › Toy Sync), already parsed and clamped */
  settings(): Settings;
  /** called whenever the settings change; returns an unsubscribe */
  onSettings(cb: (s: Settings) => void): () => void;
  timers: Timers;
  now: () => number;
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
