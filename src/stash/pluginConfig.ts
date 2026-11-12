// Plugin settings in stash's configuration, for drivers that keep their own
// (e.g. the TCode device profile). stash's configurePlugin mutation replaces a
// plugin's whole settings map, so a write is read-current-merge-write;
// merges for the same plugin run one after another so two never clobber each
// other. Values are whatever stash stores (strings, numbers, booleans; keep
// structured data as a JSON string, like TCode Player's `profile`).
//
//   const cfg = await readPluginConfig("toysync");
//   await mergePluginConfig("toysync", { tcodeProfile: JSON.stringify(profile) });
//   const old = await readOtherPluginConfig("TCodePlayer");   // one-time migration
import { refreshStashConfiguration } from "./apollo.ts";
import { graphqlRequest, type GraphQLOptions } from "./graphql.ts";

export interface PluginConfigOptions extends GraphQLOptions {
  /** runs after a successful write; default: refresh stash's cached configuration */
  afterWrite?: () => void;
}

export type PluginConfig = Record<string, unknown>;

const READ = `query ToySyncPluginConfig($include: [ID!]) {
  configuration { plugins(include: $include) }
}`;

const WRITE = `mutation ToySyncConfigurePlugin($plugin_id: ID!, $input: Map!) {
  configurePlugin(plugin_id: $plugin_id, input: $input)
}`;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** a plugin's current settings map from the server ({} when it has none) */
export async function readPluginConfig(pluginId: string, opts: PluginConfigOptions = {}): Promise<PluginConfig> {
  const data = await graphqlRequest<{ configuration?: { plugins?: unknown } }>(READ, { include: [pluginId] }, opts);
  const all = data.configuration?.plugins;
  const mine = isObj(all) ? all[pluginId] : undefined;
  return isObj(mine) ? { ...mine } : {};
}

/**
 * Another plugin's settings, read-only (e.g. TCode Player's `profile` for a
 * one-time import). {} when that plugin has none or isn't installed.
 */
export function readOtherPluginConfig(pluginId: string, opts: PluginConfigOptions = {}): Promise<PluginConfig> {
  return readPluginConfig(pluginId, opts);
}

const queues = new Map<string, Promise<unknown>>();

/**
 * Reads the plugin's current settings, applies `patch` (a key set to
 * undefined is removed) and writes the whole map back. Resolves with the map
 * stash stored. Calls for the same plugin are serialized. `patch` can be a
 * function of the current map, for a read-modify-write of one key inside the
 * same serialized step (e.g. one entry of a JSON map).
 */
export function mergePluginConfig(
  pluginId: string,
  patch: Readonly<Record<string, unknown>> | ((current: Readonly<PluginConfig>) => Readonly<Record<string, unknown>>),
  opts: PluginConfigOptions = {},
): Promise<PluginConfig> {
  const prev = queues.get(pluginId) ?? Promise.resolve();
  const run = prev
    .catch(() => undefined)
    .then(async () => {
      const current = await readPluginConfig(pluginId, opts);
      const next: PluginConfig = { ...current };
      const changes = typeof patch === "function" ? patch(current) : patch;
      for (const [k, v] of Object.entries(changes)) {
        if (v === undefined) delete next[k];
        else next[k] = v;
      }
      const data = await graphqlRequest<{ configurePlugin?: unknown }>(WRITE, { plugin_id: pluginId, input: next }, opts);
      (opts.afterWrite ?? refreshStashConfiguration)();
      return isObj(data.configurePlugin) ? { ...data.configurePlugin } : next;
    });
  queues.set(pluginId, run);
  const cleanup = () => {
    if (queues.get(pluginId) === run) queues.delete(pluginId);
  };
  run.then(cleanup, cleanup);
  return run;
}
