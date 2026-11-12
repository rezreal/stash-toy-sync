import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { graphqlRequest } from "../../src/stash/graphql.ts";
import { mergePluginConfig, readOtherPluginConfig, readPluginConfig } from "../../src/stash/pluginConfig.ts";
import { saveSceneCustomField } from "../../src/stash/sceneFields.ts";

interface Call {
  url: string;
  query: string;
  variables: Record<string, unknown>;
}

/** a fake stash: plugin configs and scene custom fields behind /graphql */
function fakeStash(plugins: Record<string, Record<string, unknown>> = {}) {
  const calls: Call[] = [];
  const scenes: Record<string, Record<string, unknown>> = { "7": { other: "keep" } };
  let delay = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
    calls.push({ url, ...body });
    if (delay) await new Promise((r) => setTimeout(r, delay));
    const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200 });
    if (body.query.includes("configurePlugin")) {
      const id = body.variables.plugin_id as string;
      plugins[id] = body.variables.input as Record<string, unknown>;
      return json({ data: { configurePlugin: plugins[id] } });
    }
    if (body.query.includes("configuration")) {
      const include = body.variables.include as string[];
      const out: Record<string, unknown> = {};
      for (const id of include) if (plugins[id]) out[id] = plugins[id];
      return json({ data: { configuration: { plugins: out } } });
    }
    if (body.query.includes("sceneUpdate")) {
      const input = body.variables.input as { id: string; custom_fields: { partial?: Record<string, unknown>; remove?: string[] } };
      const s = (scenes[input.id] ??= {});
      Object.assign(s, input.custom_fields.partial ?? {});
      for (const k of input.custom_fields.remove ?? []) delete s[k];
      return json({ data: { sceneUpdate: { id: input.id, custom_fields: { ...s } } } });
    }
    return json({ errors: [{ message: "unknown query" }] });
  }) as typeof fetch;
  return { fetchImpl, calls, plugins, scenes, setDelay: (ms: number) => (delay = ms) };
}

const base = "https://host/stash/";

describe("stash GraphQL", () => {
  it("posts to graphql under stash's base URL and surfaces errors", async () => {
    const s = fakeStash();
    await assert.rejects(graphqlRequest("query X { x }", {}, { fetchImpl: s.fetchImpl, baseUrl: base }), /unknown query/);
    assert.equal(s.calls[0]!.url, "https://host/stash/graphql");
    const http = (async () => new Response("no", { status: 502 })) as typeof fetch;
    await assert.rejects(graphqlRequest("query X { x }", {}, { fetchImpl: http, baseUrl: base }), /HTTP 502/);
  });
});

describe("plugin config", () => {
  it("reads a plugin's map, {} when it has none", async () => {
    const s = fakeStash({ toysync: { mode: "position" }, TCodePlayer: { profile: '{"model":"sr6"}' } });
    const o = { fetchImpl: s.fetchImpl, baseUrl: base };
    assert.deepEqual(await readPluginConfig("toysync", o), { mode: "position" });
    assert.deepEqual(await readOtherPluginConfig("TCodePlayer", o), { profile: '{"model":"sr6"}' });
    assert.deepEqual(await readPluginConfig("nobody", o), {});
    assert.deepEqual(s.calls[0]!.variables, { include: ["toysync"] });
  });

  it("merges into the current map instead of replacing it", async () => {
    const s = fakeStash({ toysync: { mode: "position", strength: 50 } });
    let refreshed = 0;
    const o = { fetchImpl: s.fetchImpl, baseUrl: base, afterWrite: () => refreshed++ };
    const out = await mergePluginConfig("toysync", { tcodeProfile: "{}", strength: undefined }, o);
    assert.deepEqual(out, { mode: "position", tcodeProfile: "{}" });
    assert.deepEqual(s.plugins.toysync, { mode: "position", tcodeProfile: "{}" });
    assert.equal(refreshed, 1);
  });

  it("serializes concurrent merges so neither is lost", async () => {
    const s = fakeStash({ toysync: { mode: "speed" } });
    s.setDelay(2);
    const o = { fetchImpl: s.fetchImpl, baseUrl: base, afterWrite: () => undefined };
    await Promise.all([mergePluginConfig("toysync", { x: "1" }, o), mergePluginConfig("toysync", { y: "2" }, o)]);
    assert.deepEqual(s.plugins.toysync, { mode: "speed", x: "1", y: "2" });
  });

  it("keeps going after a failed merge", async () => {
    const s = fakeStash({ toysync: {} });
    const failing = (async () => new Response("", { status: 500 })) as typeof fetch;
    await assert.rejects(mergePluginConfig("toysync", { x: "1" }, { fetchImpl: failing, baseUrl: base }));
    await mergePluginConfig("toysync", { y: "2" }, { fetchImpl: s.fetchImpl, baseUrl: base, afterWrite: () => undefined });
    assert.deepEqual(s.plugins.toysync, { y: "2" });
  });
});

describe("scene custom fields", () => {
  it("sets and removes one field, leaving the others", async () => {
    const s = fakeStash();
    const seen: unknown[] = [];
    const o = { fetchImpl: s.fetchImpl, baseUrl: base, afterWrite: (id: string, f: Record<string, unknown>) => seen.push([id, f]) };
    assert.deepEqual(await saveSceneCustomField("7", "toysync_map", '{"v":1}', o), { other: "keep", toysync_map: '{"v":1}' });
    assert.deepEqual(s.calls[0]!.variables, { input: { id: "7", custom_fields: { partial: { toysync_map: '{"v":1}' } } } });
    assert.deepEqual(await saveSceneCustomField("7", "toysync_map", null, o), { other: "keep" });
    assert.deepEqual(s.calls[1]!.variables, { input: { id: "7", custom_fields: { remove: ["toysync_map"] } } });
    assert.equal(seen.length, 2);
  });
});
