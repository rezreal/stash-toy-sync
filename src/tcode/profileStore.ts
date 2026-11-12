// Where the TCode device profile lives: the toysync plugin config, key
// "tcodeProfile", as a JSON string (TCode Player kept it under its own config
// key "profile"; a JSON string avoids viper's key lower-casing).
//
// configurePlugin REPLACES the plugin's whole config map, so saving always
// reads the current map first and writes it back with only tcodeProfile
// changed (the other keys are the plugin settings from toysync.yml).
// The configuration query is sent with plain fetch, not through stash's
// Apollo client, so it can't clobber the app's cached configuration.
import { mergePluginConfig, readOtherPluginConfig, readPluginConfig } from "../stash/pluginConfig.ts";
import { stashUrl } from "../stash/url.ts";

export interface TcodeProfileStore {
  /** the stored Toy Sync profile (parsed JSON), undefined when there is none */
  load(): Promise<unknown | undefined>;
  /** stores the profile, keeping every other key of the plugin config */
  save(profile: unknown): Promise<void>;
  /** TCode Player's profile (plugin TCodePlayer, key "profile"), undefined when there is none */
  loadLegacy(): Promise<unknown | undefined>;
}

export const PLUGIN_ID = "toysync";
export const PROFILE_KEY = "tcodeProfile";
export const LEGACY_PLUGIN_ID = "TCodePlayer";
export const LEGACY_PROFILE_KEY = "profile";

const Q_PLUGIN_CFG = "query ToySyncPluginConfig($include: [ID!]) { configuration { plugins(include: $include) } }";
const M_PLUGIN_CFG = "mutation ToySyncConfigurePlugin($plugin_id: ID!, $input: Map!) { configurePlugin(plugin_id: $plugin_id, input: $input) }";

type ConfigMap = Record<string, unknown>;

export interface GraphqlProfileStoreOptions {
  fetch?: typeof fetch;
  /** stash's GraphQL endpoint; default <base href>graphql */
  endpoint?: string;
}

function parseJson(raw: unknown): unknown | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "string") return typeof raw === "object" ? raw : undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export function createGraphqlProfileStore(opts: GraphqlProfileStoreOptions = {}): TcodeProfileStore {
  const doFetch = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const endpoint = () => opts.endpoint ?? stashUrl("graphql");

  async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const res = await doFetch(endpoint(), {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) throw new Error(`stash GraphQL: HTTP ${res.status}`);
    const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
    if (body.errors?.length) throw new Error(`stash GraphQL: ${body.errors.map((e) => e.message).join("; ")}`);
    return body.data as T;
  }

  async function readConfig(pluginId: string): Promise<ConfigMap> {
    const data = await gql<{ configuration?: { plugins?: Record<string, ConfigMap | null> } }>(Q_PLUGIN_CFG, {
      include: [pluginId],
    });
    const cfg = data?.configuration?.plugins?.[pluginId];
    return cfg && typeof cfg === "object" ? cfg : {};
  }

  return {
    async load() {
      return parseJson((await readConfig(PLUGIN_ID))[PROFILE_KEY]);
    },
    async save(profile) {
      const current = await readConfig(PLUGIN_ID);
      const input = { ...current, [PROFILE_KEY]: JSON.stringify(profile) };
      await gql(M_PLUGIN_CFG, { plugin_id: PLUGIN_ID, input });
    },
    async loadLegacy() {
      return parseJson((await readConfig(LEGACY_PLUGIN_ID))[LEGACY_PROFILE_KEY]);
    },
  };
}

/** A store in memory (tests, or when stash isn't reachable). */
export function createMemoryProfileStore(initial?: { profile?: unknown; legacy?: unknown }): TcodeProfileStore & {
  saved: unknown[];
} {
  let profile = initial?.profile;
  const saved: unknown[] = [];
  return {
    saved,
    load: async () => profile,
    save: async (p) => {
      profile = JSON.parse(JSON.stringify(p));
      saved.push(profile);
    },
    loadLegacy: async () => initial?.legacy,
  };
}

/**
 * The store the driver uses: the shared plugin-config helpers, which merge
 * one write at a time and refresh stash's cached configuration afterwards,
 * so saving the plugin's settings page later doesn't send back a stale map
 * without tcodeProfile.
 */
export function createSharedProfileStore(): TcodeProfileStore {
  return {
    async load() {
      return parseJson((await readPluginConfig(PLUGIN_ID))[PROFILE_KEY]);
    },
    async save(profile) {
      await mergePluginConfig(PLUGIN_ID, { [PROFILE_KEY]: JSON.stringify(profile) });
    },
    async loadLegacy() {
      return parseJson((await readOtherPluginConfig(LEGACY_PLUGIN_ID))[LEGACY_PROFILE_KEY]);
    },
  };
}
