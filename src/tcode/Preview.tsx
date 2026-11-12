// The 3D preview for the scene tab (props { device, program }): osr-emu
// renders the device model and receives exactly the TCode lines the device
// gets (after mapping, caps, invert and speed limits). Without a connected
// device it is a virtual device: playback and Test drive it alone. The
// bundle (~8 MB) is only loaded once the preview is opened; the open/closed
// choice is remembered per browser. A droplet lights up while A2 asks for
// lube, with or without a launcher.
import type { DeviceProgram } from "../devices/types.ts";
import { emuModelFor } from "./core.ts";
import type { TcodeDevice } from "./device.ts";
import { loadEmulator } from "./emulator.ts";
import { LUBE_AXIS, type TcodeEngine } from "./engine.ts";
import { useEngineState, useStyles } from "./ui.tsx";

const OPEN_KEY = "toysync.tcode.previewOpen";

function readOpen(): boolean {
  try {
    return globalThis.localStorage?.getItem(OPEN_KEY) === "1";
  } catch {
    return false;
  }
}
function writeOpen(on: boolean): void {
  try {
    globalThis.localStorage?.setItem(OPEN_KEY, on ? "1" : "0");
  } catch {
    // not remembered
  }
}

function LubeBadge(props: { engine: TcodeEngine }) {
  const s = useEngineState(props.engine);
  if (!s.mapping.some((m) => m.axis === LUBE_AXIS)) return null;
  return (
    <svg
      className={"toysync-tc-lube" + (s.lubeActive ? " toysync-tc-on" : "")}
      viewBox="0 0 24 24"
      role="img"
      aria-label={s.lubeActive ? "Lube firing" : "Lube idle"}
    >
      <path fill="currentColor" d="M12 2c-.4 0-.8.2-1 .6C8.6 6.7 5 11.4 5 15a7 7 0 0 0 14 0c0-3.6-3.6-8.3-6-12.4-.2-.4-.6-.6-1-.6z" />
    </svg>
  );
}

function Preview3D(props: { engine: TcodeEngine; model: "OSR2" | "SR6" | "SSR1" }) {
  const { engine, model } = props;
  const ref = React.useRef<HTMLDivElement | null>(null);
  const [state, setState] = React.useState<{ phase: "loading" | "ready" | "error"; error?: string }>({ phase: "loading" });
  React.useEffect(() => {
    let emu: { write(l: string): void; destroy(): void } | null = null;
    let cancelled = false;
    setState({ phase: "loading" });
    loadEmulator()
      .then((OSREmulator) => {
        if (cancelled || !ref.current) return;
        emu = new OSREmulator(ref.current, { model });
        engine.addEmulator(emu);
        setState({ phase: "ready" });
      })
      .catch((e: unknown) => {
        if (!cancelled) setState({ phase: "error", error: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      cancelled = true;
      if (emu) {
        engine.removeEmulator(emu);
        try {
          emu.destroy();
        } catch {
          /* ignore */
        }
      }
    };
  }, [engine, model]);
  return (
    <div className="toysync-tc-preview">
      <div ref={ref} className="toysync-tc-preview-canvas" />
      <LubeBadge engine={engine} />
      {state.phase === "loading" && <div className="toysync-tc-preview-msg">Loading 3D model…</div>}
      {state.phase === "error" && <div className="toysync-tc-preview-msg toysync-tc-error">{state.error}</div>}
    </div>
  );
}

export function TcodePreview(props: { device: TcodeDevice; program?: DeviceProgram | null }) {
  useStyles();
  const engine = props.device.engine;
  const s = useEngineState(engine);
  const [open, setOpen] = React.useState(readOpen);
  const toggle = () => {
    const v = !open;
    setOpen(v);
    writeOpen(v);
  };
  const model = emuModelFor(s.profile);
  return (
    <div className="toysync-tc">
      <div className="toysync-tc-row">
        <button type="button" className="btn btn-secondary btn-sm" onClick={toggle}>
          {open ? "Hide 3D preview" : "Show 3D preview"}
        </button>
        {open && (
          <span className="toysync-tc-muted toysync-tc-small">
            {s.status === "connected"
              ? `${model} – mirrors what the device receives. Drag to rotate, scroll to zoom.`
              : `${model} – no device connected, the preview acts as a virtual device.`}
          </span>
        )}
      </div>
      {open && <Preview3D key={model} engine={engine} model={model} />}
    </div>
  );
}
