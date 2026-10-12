import { test } from "node:test";
import assert from "node:assert/strict";
import { clearFunscriptCache, loadFunscript } from "../../src/funscript/load.ts";

function fakeFetch(responses: (() => Response)[]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const next = responses.shift();
    if (!next) throw new Error("unexpected fetch");
    return next();
  }) as typeof fetch;
  return { impl, calls };
}

test("loads, parses and caches per scene id", async () => {
  clearFunscriptCache();
  const body = JSON.stringify({ actions: [{ at: 0, pos: 1 }], channels: { snap: { actions: [{ at: 5, pos: 100 }] } } });
  const { impl, calls } = fakeFetch([() => new Response(body, { status: 200 })]);
  const f = await loadFunscript("7", impl);
  assert.deepEqual(f?.axes.get("snap"), [{ at: 5, pos: 100 }]);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/scene\/7\/funscript$/);
  assert.equal(calls[0].init?.credentials, "same-origin");
  assert.equal(await loadFunscript("7", impl), f);
  assert.equal(calls.length, 1);
});

test("404 and non-JSON give undefined (cached)", async () => {
  clearFunscriptCache();
  const { impl, calls } = fakeFetch([
    () => new Response("not found", { status: 404 }),
    () => new Response("<html>", { status: 200 }),
  ]);
  assert.equal(await loadFunscript("1", impl), undefined);
  assert.equal(await loadFunscript("2", impl), undefined);
  assert.equal(await loadFunscript("1", impl), undefined);
  assert.equal(calls.length, 2);
});

test("other HTTP errors reject and are retried next time", async () => {
  clearFunscriptCache();
  const { impl, calls } = fakeFetch([
    () => new Response("boom", { status: 500 }),
    () => new Response(JSON.stringify({ actions: [] }), { status: 200 }),
  ]);
  await assert.rejects(loadFunscript("3", impl), /HTTP 500/);
  const f = await loadFunscript("3", impl);
  assert.deepEqual(f?.actions, []);
  assert.equal(calls.length, 2);
});
