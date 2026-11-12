// The device menu in stash's navbar: an icon with a status dot (grey: nothing
// connected, green: connected, glowing: outputting) that opens a panel with
// every registered device (Connect / Disconnect, the driver's own actions),
// Stop all, and links to the devices and calibration pages.
//
// A disclosure (button + panel), not an ARIA menu: the panel mixes buttons
// and links. Escape or a click outside closes it and returns focus to the
// button; opening it focuses its first control.
import type { DeviceEntry } from "../devices/manager.ts";
import { driverLabel } from "../devices/registry.ts";
import type { DeviceAction, DeviceKind } from "../devices/types.ts";
import { CALIBRATE_ROUTE, DEVICES_ROUTE } from "../pages/links.ts";
import { connectionText } from "../pages/devicesView.ts";
import { getRuntime, type Runtime } from "../runtime.ts";
import { navDot, navTitle } from "../scene/view.ts";
import { useDeviceEntries } from "../ui/hooks.ts";
import { pluginApi } from "../ui/pluginApi.ts";

const PANEL_ID = "toysync-nav-panel";

function WaveIcon() {
  return (
    <svg className="toysync-nav-icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
      <path
        d="M2 12h3l2-6 3 12 3-9 2 5 2-2h5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function safeActions(rt: Runtime, kind: DeviceKind): readonly DeviceAction[] {
  const d = rt.manager.device(kind);
  try {
    return d?.actions?.() ?? [];
  } catch (err) {
    console.error(`[toysync] ${kind} actions failed`, err);
    return [];
  }
}

export function NavMenu() {
  const { Link } = pluginApi().libraries.ReactRouterDOM;
  const rt = getRuntime();
  const entries = useDeviceEntries(rt.manager);
  const [open, setOpen] = React.useState(false);
  const button = React.useRef<HTMLButtonElement | null>(null);
  const panel = React.useRef<HTMLDivElement | null>(null);
  const dot = navDot(entries.map((e) => e.status));
  const connected = entries.filter((e) => e.status.connection === "connected").length;

  const close = React.useCallback((focusButton: boolean) => {
    setOpen(false);
    if (focusButton) button.current?.focus();
  }, []);

  React.useEffect(() => {
    if (!open) return;
    panel.current?.querySelector<HTMLElement>("button, a[href]")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close(true);
      }
    };
    const onPointer = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (t && (panel.current?.contains(t) || button.current?.contains(t))) return;
      close(false);
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onPointer, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", onPointer, true);
    };
  }, [open, close]);

  const stopAll = () => {
    // like Stop under the player: output 0 everywhere and disconnect, so the next tick can't start it again
    rt.engine.stop();
    rt.manager.stopAll();
    rt.manager.disconnectAll();
  };

  return (
    <div className="toysync-nav">
      <button
        ref={button}
        type="button"
        className="btn minimal toysync-nav-toggle"
        aria-expanded={open}
        aria-controls={PANEL_ID}
        aria-label={navTitle(dot, connected)}
        title={navTitle(dot, connected)}
        onClick={() => setOpen((o) => !o)}
      >
        <WaveIcon />
        <span className={`toysync-nav-dot toysync-nav-dot-${dot}`} aria-hidden="true" />
      </button>
      {open && (
        <div ref={panel} id={PANEL_ID} className="toysync-nav-panel" role="group" aria-label="Toy Sync devices">
          <div className="toysync-nav-title">Toy Sync</div>
          {entries.length === 0 && <div className="toysync-muted">No device drivers in this build.</div>}
          <ul className="toysync-nav-devices">
            {entries.map((e) => (
              <NavDevice key={e.kind} rt={rt} entry={e} />
            ))}
          </ul>
          <div className="toysync-row">
            <button type="button" className="btn btn-danger btn-sm toysync-btn" title="Outputs 0 and disconnects every device" onClick={stopAll}>
              Stop all
            </button>
          </div>
          <div className="toysync-row">
            <Link to={DEVICES_ROUTE} className="toysync-nav-link" onClick={() => close(false)}>
              Devices &amp; settings
            </Link>
            <Link to={CALIBRATE_ROUTE} className="toysync-nav-link" onClick={() => close(false)}>
              Calibrate
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}

function NavDevice(props: { rt: Runtime; entry: DeviceEntry }) {
  const { rt, entry } = props;
  const { kind, status } = entry;
  const label = driverLabel(kind);
  const busy = status.connection === "connected" || status.connection === "connecting";
  const actions = safeActions(rt, kind);
  return (
    <li className="toysync-nav-device">
      <div className="toysync-row">
        <span className={`toysync-nav-dot toysync-nav-dot-${status.connection === "connected" ? "connected" : "off"}`} aria-hidden="true" />
        <span className="toysync-grow">
          {status.device || label}
          <span className="toysync-muted toysync-small"> · {connectionText(status)}</span>
        </span>
        {busy ? (
          <button type="button" className="btn btn-secondary btn-sm toysync-btn" aria-label={`Disconnect ${label}`} onClick={() => rt.manager.disconnect(kind)}>
            Disconnect
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-primary btn-sm toysync-btn"
            aria-label={`Connect ${label}`}
            // the click is the user gesture the Bluetooth / serial picker needs
            onClick={() => void rt.manager.connect(kind)}
          >
            Connect
          </button>
        )}
      </div>
      {actions.length > 0 && (
        <div className="toysync-row toysync-nav-actions">
          {actions.map((a) => (
            <button
              key={a.id}
              type="button"
              className="btn btn-secondary btn-sm toysync-btn"
              onClick={() => {
                try {
                  a.run();
                } catch (err) {
                  console.error(`[toysync] ${kind} action ${a.id} failed`, err);
                }
              }}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
      {status.message && status.connection === "error" && <div className="toysync-message toysync-error">{status.message}</div>}
    </li>
  );
}
