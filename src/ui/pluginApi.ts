// Minimal typed view of the parts of stash's window.PluginApi this plugin
// uses. The real object is much larger; see ui/v2.5/src/pluginApi.tsx in the
// stash repo. Everything is looked up lazily because some members are only
// populated once stash has rendered.
import type * as ReactTypes from "react";

export interface PluginApiShape {
  React: typeof import("react");
  patch: {
    /** fn(...props, result) returns the new result; runs inside the component's render, so no hooks */
    after: (component: string, fn: (...args: any[]) => unknown) => void;
  };
  utils: {
    StashService: {
      useConfiguration: () => {
        data?: {
          configuration?: {
            plugins?: Record<string, Record<string, unknown> | undefined>;
          };
        };
      };
    };
    /** stash's hooks/Interactive/utils.ts; getPlayer() = videojs.getPlayer("VideoJsPlayer") */
    InteractiveUtils?: { getPlayer?: () => unknown };
  };
}

export type ReactNode = ReactTypes.ReactNode;

export function pluginApi(): PluginApiShape {
  return (window as unknown as { PluginApi: PluginApiShape }).PluginApi;
}

/** Plugin id = manifest file name without extension. */
export const PLUGIN_ID = "lovense";

/** Reads this plugin's settings from stash's configuration (may be empty). */
export function usePluginSettings(): Record<string, unknown> {
  // StashService is always present in a running stash, so this hook call is
  // unconditional in practice; the guard only protects against API changes.
  const useConfiguration = pluginApi().utils?.StashService?.useConfiguration;
  const result = useConfiguration ? useConfiguration() : undefined;
  return result?.data?.configuration?.plugins?.[PLUGIN_ID] ?? {};
}
