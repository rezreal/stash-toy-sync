// Registers the Lovense driver (imported for its side effect by src/index.tsx).
import { registerDriver } from "../devices/registry.ts";
import { createLovenseToy } from "./toy.ts";

registerDriver("lovense", (ctx) => createLovenseToy(ctx), {
  label: "Lovense",
  description: "Vibrator over Web Bluetooth, one level 0–20 (Strength caps it)",
});
