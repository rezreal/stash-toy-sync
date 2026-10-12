// The page-wide objects: one toy connection, one gain combiner, one sync
// engine. They outlive scene changes (stash keeps the scene player mounted
// across scenes) and are shared with the hook contract.
import { createLovenseDevice, type LovenseDevice } from "./lovense/device.ts";
import { createSyncEngine, type SyncEngine } from "./sync/engine.ts";
import { createGainCombiner, type GainCombiner } from "./sync/gain.ts";

export interface Runtime {
  device: LovenseDevice;
  gains: GainCombiner;
  engine: SyncEngine;
}

let runtime: Runtime | undefined;

export function getRuntime(): Runtime {
  if (runtime) return runtime;
  const device = createLovenseDevice();
  const gains = createGainCombiner();
  const engine = createSyncEngine({ output: device, gain: () => gains.gain() });
  // a new gain applies right away (the sender still rate-limits)
  gains.onChange(() => engine.refresh());
  runtime = { device, gains, engine };
  return runtime;
}
