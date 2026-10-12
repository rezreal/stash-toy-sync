// Injected into every module by esbuild: JSX compiles to React.createElement,
// and React is the instance stash already runs.
export const React = (window as any).PluginApi.React as typeof import("react");
