// Type-side counterpart of react-shim.ts: esbuild injects `React` into every
// module, so tell TypeScript it exists as a global value. Types (event types
// etc.) are imported from "react" with `import type`.
import type * as ReactTypes from "react";

declare global {
  const React: typeof ReactTypes;
}
