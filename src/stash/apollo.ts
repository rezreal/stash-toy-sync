// Best-effort updates of stash's own Apollo cache after this plugin wrote
// something through its fetch-based client (graphql.ts), so stash's pages and
// the props stash hands the plugin don't keep showing the old value. Every
// step is optional: without PluginApi (tests) or with a changed API nothing
// happens.

interface ApolloLike {
  refetchQueries?: (opts: { include: string[] }) => unknown;
  cache?: {
    identify?: (o: Record<string, unknown>) => string | undefined;
    modify?: (opts: { id?: string; fields: Record<string, () => unknown> }) => unknown;
  };
}

function apolloClient(): ApolloLike | undefined {
  try {
    const api = (globalThis as { PluginApi?: { utils?: { StashService?: { getClient?: () => ApolloLike } } } }).PluginApi;
    return api?.utils?.StashService?.getClient?.();
  } catch {
    return undefined;
  }
}

/** stash's settings pages send whole plugin configs from this cache: refresh it after configurePlugin */
export function refreshStashConfiguration(): void {
  try {
    const p = apolloClient()?.refetchQueries?.({ include: ["Configuration"] });
    if (p && typeof (p as Promise<unknown>).catch === "function") (p as Promise<unknown>).catch(() => undefined);
  } catch {
    // best effort
  }
}

/** puts a scene's new custom fields into the cache (the scene page re-renders with them) */
export function updateCachedSceneFields(sceneId: string, customFields: Record<string, unknown>): void {
  try {
    const cache = apolloClient()?.cache;
    const id = cache?.identify?.({ __typename: "Scene", id: sceneId });
    if (id) cache?.modify?.({ id, fields: { custom_fields: () => customFields } });
  } catch {
    // best effort
  }
}
