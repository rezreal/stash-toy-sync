// Writes one scene custom field without touching the others (stash's
// CustomFieldsInput: `partial` sets keys, `remove` deletes them), like TCode
// Player's saveSceneField.
import { updateCachedSceneFields } from "./apollo.ts";
import { graphqlRequest, type GraphQLOptions } from "./graphql.ts";

export interface SceneFieldOptions extends GraphQLOptions {
  /** runs with the scene's new custom fields; default: put them into stash's Apollo cache */
  afterWrite?: (sceneId: string, customFields: Record<string, unknown>) => void;
}

const UPDATE = `mutation ToySyncSceneFields($input: SceneUpdateInput!) {
  sceneUpdate(input: $input) { id custom_fields }
}`;

/** sets (string) or removes (null) one custom field; resolves with the scene's custom fields after the write */
export async function saveSceneCustomField(sceneId: string, field: string, value: string | null, opts: SceneFieldOptions = {}): Promise<Record<string, unknown>> {
  const custom_fields = value === null ? { remove: [field] } : { partial: { [field]: value } };
  const data = await graphqlRequest<{ sceneUpdate?: { id?: string; custom_fields?: Record<string, unknown> } | null }>(
    UPDATE,
    { input: { id: sceneId, custom_fields } },
    opts,
  );
  const fields = data.sceneUpdate?.custom_fields ?? {};
  (opts.afterWrite ?? updateCachedSceneFields)(sceneId, fields);
  return fields;
}
