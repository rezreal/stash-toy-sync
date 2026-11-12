// Registers the DG-LAB Coyote drivers (imported for its side effect by src/index.tsx).
import { registerDriver } from "../devices/registry.ts";
import { createCoyoteV2 } from "./v2.ts";
import { createCoyoteV3 } from "./v3.ts";

registerDriver("coyote-v2", (ctx) => createCoyoteV2(ctx), {
  label: "DG-LAB Coyote 2.0",
  description: "E-stim, two channels",
});
registerDriver("coyote-v3", (ctx) => createCoyoteV3(ctx), {
  label: "DG-LAB Coyote 3.0",
  description: "E-stim, two channels",
});
