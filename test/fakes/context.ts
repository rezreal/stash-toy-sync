// A DriverContext with settings that tests can change.
import type { DriverContext } from "../../src/devices/registry.ts";
import { DEFAULT_SETTINGS, type Settings } from "../../src/sync/settings.ts";
import { FakeClock } from "./clock.ts";

export function fakeContext(settings: Partial<Settings> = {}, clock = new FakeClock()) {
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
  };
  const update = (patch: Partial<Settings>) => {
    s = { ...s, ...patch };
    for (const cb of [...listeners]) cb(s);
  };
  return { ctx, clock, update };
}
