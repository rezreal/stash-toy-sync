// The TCode device (OSR2 / OSR2+, SR6, SSR1 over Web Serial) as a Toy Sync
// self-timed device (kind "tcode"). It never uses DriveFrames: the engine
// (engine.ts) reads the program's channels and clock itself and sends its own
// frames, timed like MultiFunPlayer. This file adapts the engine to the
// device contract and owns the device profile (load, migrate, save).
//
// - resume() is the auto-connect: only the port this plugin opened before,
//   never one that is open already, quietly nothing when it is busy, and not
//   at all while TCode Player is active in the page (coexist.ts).
// - selfReconnects: the engine recovers failed writes on its own and, when
//   the device keeps failing, gives up with a message; the manager must not
//   undo that by retrying.
// - The settings panel and the 3D preview are React components handed in by
//   register.ts, so this file stays free of React (and testable in node).
// - One stroker per instance: the first instance keeps the old port key
//   ("toysync.tcode.port", plus TCode Player's "tcp-port") and profile key
//   (tcodeProfile); others remember "toysync.tcode.port.<instanceId>" and keep
//   their profile in tcodeProfiles; ports other instances hold are never
//   opened (ctx.claims).
import { instanceClaims } from "../devices/claims.ts";
import { instanceInfoOf, instanceStorageKey } from "../devices/instances.ts";
import type { DriverContext } from "../devices/registry.ts";
import type {
  ChannelMapping,
  DeviceAction,
  DeviceProgram,
  DeviceStatus,
  MappingTarget,
  ScriptChannel,
  SelfTimedDevice,
} from "../devices/types.ts";
import { tcodePlayerPresent } from "./coexist.ts";
import { axisTargets, defaultChannelMapping, DEVICE_PRESETS, normalizeProfile, type Profile } from "./core.ts";
import { MSG_INSECURE, MSG_UNSUPPORTED, PORT_KEY, TcodeEngine, type EngineEnv } from "./engine.ts";
import { createSharedProfileStore, type TcodeProfileStore } from "./profileStore.ts";

export interface TcodeDevice extends SelfTimedDevice {
  readonly kind: "tcode";
  readonly engine: TcodeEngine;
  /** resolves once the stored profile is loaded (or failed to load) */
  ready(): Promise<void>;
  profile(): Profile;
  /** normalizes, stores and applies a profile; rejects when storing fails */
  saveProfile(profile: Profile): Promise<void>;
  /** the open scene's program, null without one */
  program(): DeviceProgram | null;
  /** sweeps one mapped channel's axis through its mapped range (like TCode Player's Test button) */
  testChannel(channelId: string): void;
  resume(): Promise<void>;
  mappingTargets(): readonly MappingTarget[];
  defaultMapping(channels: readonly ScriptChannel[]): Record<string, ChannelMapping>;
  actions(): readonly DeviceAction[];
  dispose(): void;
}

export interface TcodeDeviceOptions {
  engine?: EngineEnv;
  store?: TcodeProfileStore;
  /** React components (props { device } / { device, program }) */
  settingsPanel?: unknown;
  preview?: unknown;
  log?: Pick<Console, "warn" | "info">;
}

/** "Sending 60/s · write 2 ms · gap 18 ms · 1 write error" while frames go out */
export function statsLine(stats: TcodeEngine["state"]["stats"]): string | undefined {
  if (!stats) return undefined;
  let s = `Sending ${stats.fps}/s · write ${stats.writeMs} ms · gap ${stats.maxGapMs} ms`;
  if (stats.writeErrors) s += ` · ${stats.writeErrors} write error${stats.writeErrors > 1 ? "s" : ""}`;
  if (stats.readErrors) s += ` · ${stats.readErrors} read error${stats.readErrors > 1 ? "s" : ""}`;
  return s;
}

export function tcodeStatus(engine: TcodeEngine): DeviceStatus {
  const s = engine.state;
  const out: DeviceStatus = { connection: s.status };
  const preset = (DEVICE_PRESETS[s.profile.model] ?? DEVICE_PRESETS.custom).label;
  out.device = s.deviceInfo ? `${preset} · ${s.deviceInfo}` : preset;
  const message =
    s.error ??
    (!s.supported ? (s.secure ? MSG_UNSUPPORTED : MSG_INSECURE) : null) ??
    (s.status === "connected" ? statsLine(s.stats) : s.notice) ??
    undefined;
  if (message) out.message = message;
  if (s.status === "connected") out.output = { a: Math.round((s.live.L0 ?? 0) * 100) / 100 };
  return out;
}

export function createTcodeDevice(ctx: DriverContext | undefined, opts: TcodeDeviceOptions = {}): TcodeDevice {
  const log = opts.log ?? console;
  const inst = instanceInfoOf(ctx, "tcode");
  const first = inst.ordinal <= 1;
  const engine = new TcodeEngine({
    oldPluginPresent: () => tcodePlayerPresent(),
    log,
    portKey: instanceStorageKey(PORT_KEY, inst),
    legacyPortKey: first ? undefined : null,
    claims: instanceClaims(ctx?.claims, inst.id),
    ...opts.engine,
  });
  const store = opts.store ?? createSharedProfileStore(first ? undefined : inst.id);

  const ready = (async () => {
    let profile: Profile | undefined;
    try {
      const stored = await store.load();
      if (stored !== undefined) {
        profile = normalizeProfile(stored);
      } else {
        // first run: take over TCode Player's profile once (the first instance only: the store says none otherwise)
        const legacy = await store.loadLegacy();
        if (legacy !== undefined) {
          profile = normalizeProfile(legacy);
          try {
            await store.save(profile);
          } catch (e) {
            log.warn("[toysync] could not store the TCode profile taken over from TCode Player", e);
          }
        }
      }
    } catch (e) {
      log.warn("[toysync] could not load the TCode profile", e);
    }
    engine.setProfile(profile ?? engine.state.profile);
  })();

  // status: only when what the manager sees changes
  const listeners = new Set<(s: DeviceStatus) => void>();
  let lastStatus = JSON.stringify(tcodeStatus(engine));
  const unsubscribe = engine.subscribe(() => {
    const st = tcodeStatus(engine);
    const json = JSON.stringify(st);
    if (json === lastStatus) return;
    lastStatus = json;
    for (const cb of [...listeners]) {
      try {
        cb(st);
      } catch (e) {
        log.warn("[toysync] tcode status listener failed", e);
      }
    }
  });

  const device: TcodeDevice = {
    kind: "tcode",
    selfTimed: true,
    selfReconnects: true,
    engine,
    get id() {
      const port = engine.rememberedPort();
      return port ? `tcode:${port}` : first ? "tcode" : inst.id;
    },
    ready: () => ready,
    profile: () => engine.state.profile,
    async saveProfile(p) {
      const profile = normalizeProfile(p);
      await store.save(profile);
      engine.setProfile(profile);
    },
    program: () => engine._program,
    // the picker needs the user gesture: no await before it
    connect: () => engine.connect(),
    async resume() {
      await ready;
      if (!engine.state.profile.autoConnect) return;
      await engine.autoConnect();
    },
    disconnect() {
      void engine.disconnect();
    },
    status: () => tcodeStatus(engine),
    onStatus(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    drive() {
      // self-timed: frames come from the program, not the engine's DriveFrames
    },
    nudge: () => false,
    test() {
      void engine.testAxisCfg("L0", engine.state.profile.axes.L0);
    },
    testChannel(channelId) {
      void engine.testChannel(channelId);
    },
    stopNow: () => engine.stopNow(),
    setProgram: (program) => engine.setProgram(program),
    mappingTargets: (): readonly MappingTarget[] => axisTargets(engine.state.profile),
    defaultMapping: (channels: readonly ScriptChannel[]): Record<string, ChannelMapping> =>
      defaultChannelMapping(channels, engine.state.profile),
    actions(): readonly DeviceAction[] {
      const on = engine.state.outputEnabled;
      return [
        { id: "home", label: "Home", run: () => engine.home(800) },
        { id: "motion", label: on ? "Motion off" : "Motion on", run: () => engine.setOutputEnabled(!on) },
      ];
    },
    settingsPanel: opts.settingsPanel,
    preview: opts.preview,
    forget: () => engine.forgetPort(),
    dispose() {
      unsubscribe();
      listeners.clear();
      engine.dispose();
    },
  };
  return device;
}
