// The Lovense toy as a ToyDevice (kind "lovense"). Wraps the Web Bluetooth
// device (device.ts) and turns the engine's DriveFrame into the vibration
// level 0..20:
//   level = round(20 × intensity × Strength), raised to Minimum level while
//   the intensity is above 0 (never above what Strength × gain allow).
// Strength is a hard cap on everything, including Test. Vibrators ignore
// balance, speed and the direct channels; they have no nudge.
import type { DriverContext } from "../devices/registry.ts";
import type { DeviceStatus, DriveFrame, ToyDevice } from "../devices/types.ts";
import { driveDefaultMapping, VIBRATOR_TARGETS } from "../mapping/targets.ts";
import { createLovenseDevice, type LovenseDevice, type LovenseDeviceOptions, type LovenseStatus } from "./device.ts";
import { MAX_LEVEL } from "./protocol.ts";

export const TEST_LEVEL = 10;
export const TEST_MS = 1000;
/** intensities below this count as none (a smoothing filter's tail never quite reaches 0) */
export const INTENSITY_EPSILON = 0.005;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : Number.isFinite(v) ? v : 0);

export interface VibrationParams {
  /** 0..100 % */
  strength: number;
  /** 0..20 */
  minLevel: number;
  /** the hook gain already contained in the intensity (caps the minimum level); default 1 */
  gain?: number;
}

/**
 * Level 0..20 for a frame intensity (gain already applied):
 * round(20 × intensity × strength), raised to minLevel while the intensity
 * is above 0, but never above round(20 × strength × gain); 0 when the
 * strength or the gain is 0.
 */
export function vibrationLevel(intensity: number, p: VibrationParams): number {
  const i = clamp01(intensity);
  const strength = clamp01(p.strength / 100);
  const gain = clamp01(p.gain ?? 1);
  if (i < INTENSITY_EPSILON || strength <= 0 || gain <= 0) return 0;
  const raw = Math.round(MAX_LEVEL * i * strength);
  const cap = Math.round(MAX_LEVEL * strength * gain);
  const min = Math.min(Math.max(0, Math.round(p.minLevel)), cap);
  return Math.max(0, Math.min(MAX_LEVEL, Math.max(raw, min)));
}

/** "Lush · LVS-A123", the name alone when it already says the model, or a fallback */
export function lovenseLabel(status: Pick<LovenseStatus, "device" | "model">): string {
  const name = status.device;
  const model = status.model;
  if (model && name && !name.toLowerCase().includes(model.toLowerCase())) return `${model} · ${name}`;
  return name || model || "Lovense toy";
}

/** the generic status for a Lovense status */
export function toDeviceStatus(s: LovenseStatus): DeviceStatus {
  const out: DeviceStatus = { connection: s.connection };
  if (s.device || s.model) out.device = lovenseLabel(s);
  if (s.battery !== undefined) out.battery = s.battery;
  if (s.message) out.message = s.message;
  if (s.connection === "connected") out.output = { a: (s.level ?? 0) / MAX_LEVEL };
  return out;
}

export interface LovenseToy extends ToyDevice {
  readonly kind: "lovense";
  /** the Lovense-specific status (level 0..20, model) for the legacy "lovense:status" event */
  legacyStatus(): LovenseStatus;
  onLegacyStatus(cb: (s: LovenseStatus) => void): () => void;
  /** the level last asked of the toy (0..20) */
  level(): number;
}

export interface LovenseToyOptions {
  /** an existing device (tests); default: a new Web Bluetooth device */
  device?: LovenseDevice;
  deviceOptions?: LovenseDeviceOptions;
}

export function createLovenseToy(ctx: DriverContext, opts: LovenseToyOptions = {}): LovenseToy {
  const dev =
    opts.device ??
    createLovenseDevice({ timers: ctx.timers, now: ctx.now, namePrefix: ctx.settings().namePrefix, ...opts.deviceOptions });
  let frame: DriveFrame | null = null;
  let testUntil = -Infinity;
  let testTimer: unknown;
  let level = 0;

  function wanted(): number {
    const s = ctx.settings();
    if (ctx.now() < testUntil) return vibrationLevel(TEST_LEVEL / MAX_LEVEL, { strength: s.strength, minLevel: 0 });
    if (!frame) return 0;
    return vibrationLevel(frame.intensity, { strength: s.strength, minLevel: s.minLevel, gain: frame.gain ?? 1 });
  }

  function apply(): void {
    level = wanted();
    dev.setLevel(level);
  }

  function cancelTest(): void {
    testUntil = -Infinity;
    if (testTimer !== undefined) ctx.timers.clearTimeout(testTimer);
    testTimer = undefined;
  }

  const stopSettings = ctx.onSettings((s) => {
    dev.setNamePrefix(s.namePrefix);
    // a new Strength / Minimum level applies right away (the sender still rate-limits)
    apply();
  });

  return {
    kind: "lovense",
    get id() {
      return dev.deviceId() ?? "lovense";
    },
    selfReconnects: true,
    connect: () => dev.connect(),
    resume: () => dev.resume(),
    disconnect() {
      cancelTest();
      frame = null;
      level = 0;
      // sends Vibrate:0 before closing the link
      void dev.disconnect();
    },
    status: () => toDeviceStatus(dev.status()),
    onStatus: (cb) => dev.onStatus((s) => cb(toDeviceStatus(s))),
    drive(f) {
      frame = f;
      apply();
    },
    nudge: () => false,
    // per-scene mapping: one target, the vibration level (frame.intensity)
    mappingTargets: () => VIBRATOR_TARGETS,
    defaultMapping: (channels) => driveDefaultMapping(channels, ctx.settings().axisMap, ["intensity"]),
    test() {
      cancelTest();
      testUntil = ctx.now() + TEST_MS;
      testTimer = ctx.timers.setTimeout(() => {
        testTimer = undefined;
        testUntil = -Infinity;
        // back to whatever the engine last asked for (0 when nothing plays)
        apply();
      }, TEST_MS);
      apply();
    },
    stopNow() {
      cancelTest();
      frame = null;
      level = 0;
      dev.stopNow();
    },
    legacyStatus: () => dev.status(),
    onLegacyStatus: (cb) => dev.onStatus(cb),
    level: () => level,
    dispose() {
      cancelTest();
      stopSettings();
    },
  };
}
