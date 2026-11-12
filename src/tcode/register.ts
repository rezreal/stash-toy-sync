// Registers the TCode driver (imported for its side effect by src/index.tsx).
// The settings panel and the 3D preview are handed in here so device.ts stays
// free of React.
import { registerDriver } from "../devices/registry.ts";
import { createTcodeDevice } from "./device.ts";
import { TcodePreview } from "./Preview.tsx";
import { TcodeSettingsPanel } from "./SettingsPanel.tsx";

registerDriver("tcode", (ctx) => createTcodeDevice(ctx, { settingsPanel: TcodeSettingsPanel, preview: TcodePreview }), {
  label: "TCode device",
  description: "OSR2 / SR6 / SSR1 over USB serial",
});
