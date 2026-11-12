// A DriverContext with settings that tests can change. By default the first
// instance of its kind with a claim registry of its own; pass `instance` and
// a shared `claims` to model several instances of one kind.
import { createClaimRegistry, type ClaimRegistry } from "../../src/devices/claims.ts";
import type { InstanceInfo } from "../../src/devices/instances.ts";
import type { DriverContext } from "../../src/devices/registry.ts";
import { DEFAULT_SETTINGS, type Settings } from "../../src/sync/settings.ts";
import { FakeClock } from "./clock.ts";

export interface FakeContextOptions {
  instance?: InstanceInfo;
  claims?: ClaimRegistry;
}

export function fakeContext(settings: Partial<Settings> = {}, clock = new FakeClock(), opts: FakeContextOptions = {}) {
  let s: Settings = { ...DEFAULT_SETTINGS, ...settings };
  const listeners = new Set<(s: Settings) => void>();
  const ctx: DriverContext = {
    settings: () => s,
    onSettings: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    timers: clock,
    now: clock.now,
    instance: opts.instance ?? { id: "test", name: "Test device", ordinal: 1 },
    claims: opts.claims ?? createClaimRegistry(),
  };
  const update = (patch: Partial<Settings>) => {
    s = { ...s, ...patch };
    for (const cb of [...listeners]) cb(s);
  };
  return { ctx, clock, update };
}
