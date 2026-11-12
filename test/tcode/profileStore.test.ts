// The GraphQL profile store: reads the toysync plugin config, saves with
// read-merge-write (configurePlugin replaces the whole map), reads TCode
// Player's profile for the one-time migration. No server: a fake fetch.
import { it } from "node:test";
import assert from "node:assert/strict";
import { createGraphqlProfileStore } from "../../src/tcode/profileStore.ts";

function fakeStash(plugins: Record<string, Record<string, unknown>>) {
  const calls: { query: string; variables: Record<string, unknown> }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    assert.equal(url, "http://stash/graphql");
    const body = JSON.parse(String(init.body)) as { query: string; variables: Record<string, unknown> };
    calls.push(body);
    let data: unknown;
    if (body.query.includes("configurePlugin")) {
      plugins[body.variables.plugin_id as string] = body.variables.input as Record<string, unknown>;
      data = { configurePlugin: body.variables.input };
    } else {
      const id = (body.variables.include as string[])[0]!;
      data = { configuration: { plugins: id in plugins ? { [id]: plugins[id] } : {} } };
    }
    return { ok: true, status: 200, json: async () => ({ data }) } as Response;
  }) as typeof globalThis.fetch;
  return { calls, store: createGraphqlProfileStore({ fetch, endpoint: "http://stash/graphql" }), plugins };
}

it("loads the JSON profile, undefined when there is none", async () => {
  const empty = fakeStash({});
  assert.equal(await empty.store.load(), undefined);
  const { store } = fakeStash({ toysync: { tcodeProfile: '{"model":"sr6"}' } });
  assert.deepEqual(await store.load(), { model: "sr6" });
});

it("saves without losing the other plugin settings", async () => {
  const { store, plugins, calls } = fakeStash({ toysync: { strength: 50, mode: "speed" } });
  await store.save({ model: "ssr1" });
  assert.deepEqual(plugins.toysync, { strength: 50, mode: "speed", tcodeProfile: '{"model":"ssr1"}' });
  assert.equal(calls.length, 2, "read, then write");
  assert.equal(calls[1]!.variables.plugin_id, "toysync");
});

it("reads TCode Player's profile", async () => {
  const { store, calls } = fakeStash({ TCodePlayer: { profile: '{"model":"sr6","rateHz":90}' } });
  assert.deepEqual(await store.loadLegacy(), { model: "sr6", rateHz: 90 });
  assert.deepEqual(calls[0]!.variables.include, ["TCodePlayer"]);
  assert.equal(await fakeStash({}).store.loadLegacy(), undefined);
});

it("rejects on GraphQL errors", async () => {
  const fetch = (async () => ({ ok: true, status: 200, json: async () => ({ errors: [{ message: "nope" }] }) }) as Response) as typeof globalThis.fetch;
  await assert.rejects(createGraphqlProfileStore({ fetch, endpoint: "x" }).load(), /nope/);
});
