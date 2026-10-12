// Bundles src/index.tsx into plugin/lovense.js. React comes from
// window.PluginApi at runtime and is never bundled.
import * as esbuild from "esbuild";

const options = {
  entryPoints: ["src/index.tsx"],
  outfile: "plugin/lovense.js",
  bundle: true,
  format: "iife",
  target: "es2020",
  jsxFactory: "React.createElement",
  jsxFragment: "React.Fragment",
  inject: ["src/ui/react-shim.ts"],
  legalComments: "none",
  logLevel: "info",
};

if (process.argv.includes("--watch")) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}
