// Registers the Hismith PiuPiu driver (imported for its side effect by src/index.tsx).
import { registerDriver } from "../devices/registry.ts";
import { createPiupiuDevice } from "./device.ts";
import { PiupiuSettingsPanel } from "./SettingsPanel.tsx";

registerDriver("piupiu", (ctx) => createPiupiuDevice(ctx, { settingsPanel: PiupiuSettingsPanel }), {
  label: "Hismith PiuPiu",
  description: "Lube launcher",
});
