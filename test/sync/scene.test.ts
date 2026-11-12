import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createSceneTracker } from "../../src/sync/scene.ts";

describe("scene tracker", () => {
  it("knows the open scene and remembers the last one", () => {
    const t = createSceneTracker();
    let changes = 0;
    t.onChange(() => changes++);
    assert.equal(t.open(), undefined);
    t.set({ id: "1", interactive: true, scriptState: "loading" });
    t.set({ id: "1", interactive: true, scriptState: "loading" });
    assert.equal(changes, 1, "identical updates are ignored");
    t.set({ id: "1", interactive: true, scriptState: "ready" });
    t.set(undefined);
    assert.equal(t.open(), undefined);
    assert.equal(t.last()?.scriptState, "ready");
    assert.equal(changes, 3);
  });
});
