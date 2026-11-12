// Keeps a driver's own component (settings panel, preview) from taking the
// page down with it: a render error shows a one-line note instead.
import type * as ReactTypes from "react";

interface Props {
  what: string;
  children?: ReactTypes.ReactNode;
}

interface State {
  failed: boolean;
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(err: unknown): void {
    console.error(`[toysync] ${this.props.what} failed`, err);
  }

  render() {
    if (this.state.failed) return <div className="toysync-message toysync-error">{this.props.what} failed to render.</div>;
    return this.props.children ?? null;
  }
}

/** renders a component typed unknown (ToyDevice.settingsPanel / preview) when it is one */
export function renderDriverComponent(component: unknown, props: Record<string, unknown>, what: string) {
  if (typeof component !== "function" && !(component && typeof component === "object")) return null;
  return <ErrorBoundary what={what}>{React.createElement(component as ReactTypes.ComponentType<Record<string, unknown>>, props)}</ErrorBoundary>;
}
