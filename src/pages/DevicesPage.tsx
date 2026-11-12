// /toysync: the devices (connect, disconnect, test, stop, battery, live
// meters, calibration), how scripts map onto them with the mapping of the
// open or last scene, and a summary of the settings.
import { isCalibratable } from "../devices/calibration.ts";
import type { DeviceEntry } from "../devices/manager.ts";
import { DRIVERS, driverLabel } from "../devices/registry.ts";
import type { DeviceKind, ToyDevice } from "../devices/types.ts";
import { getRuntime, type Runtime } from "../runtime.ts";
import type { SceneInfo } from "../sync/scene.ts";
import type { Settings } from "../sync/settings.ts";
import { useDeviceEntries, useLastScene, useSyncedSettings } from "../ui/hooks.ts";
import { OutputMeters } from "../ui/Meter.tsx";
import { pluginApi } from "../ui/pluginApi.ts";
import { isSelfTimed } from "../mapping/effective.ts";
import { renderDriverComponent } from "../ui/ErrorBoundary.tsx";
import { TcodePlayerNotice } from "../ui/TcodePlayerNotice.tsx";
import { calibrationSummary, connectionText, mappingRows, settingsRows } from "./devicesView.ts";
import { calibrateStartHref } from "./links.ts";
import { SafetyBox } from "./SafetyBox.tsx";

export function DevicesPage() {
  const rt = getRuntime();
  const settings = useSyncedSettings(rt);
  const entries = useDeviceEntries(rt.manager);
  const scene = useLastScene(rt.scene);
  const kinds = rt.manager.kinds();

  // devices granted on an earlier visit reconnect without a click
  React.useEffect(() => {
    void rt.manager.resumeAll();
  }, [rt]);

  return (
    <div className="toysync-page">
      <h1 className="toysync-h1">Toy Sync</h1>
      <p className="toysync-lead">
        Drives your devices from the funscript of the scene playing in stash's player. Connect them here or from the bar
        under the player; output only runs while a scene with a script plays, and stops on pause, seek and stop.
      </p>

      <TcodePlayerNotice />

      <section aria-labelledby="toysync-devices-h">
        <h2 id="toysync-devices-h" className="toysync-h2">
          Devices
        </h2>
        {kinds.length === 0 && <p className="toysync-muted">No device drivers are installed in this build.</p>}
        <div className="toysync-cards">
          {kinds.map((kind) => (
            <DeviceCard key={kind} rt={rt} kind={kind} entry={entries.find((e) => e.kind === kind)} />
          ))}
        </div>
        <SafetyBox compact />
      </section>

      <MappingSection scene={scene} settings={settings} />

      <section aria-labelledby="toysync-settings-h">
        <h2 id="toysync-settings-h" className="toysync-h2">
          Settings
        </h2>
        <p className="toysync-muted">
          Settings live in Settings › Plugins › Toy Sync; changes apply right away. Current values:
        </p>
        <dl className="toysync-settings">
          {settingsRows(settings).map(([k, v]) => (
            <div key={k} className="toysync-settings-row">
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  );
}

function DeviceCard(props: { rt: Runtime; kind: DeviceKind; entry: DeviceEntry | undefined }) {
  const { Link } = pluginApi().libraries.ReactRouterDOM;
  const { rt, kind } = props;
  const device: ToyDevice | undefined = rt.manager.device(kind);
  const status = props.entry?.status ?? device?.status() ?? { connection: "disconnected" as const };
  const label = driverLabel(kind);
  const description = DRIVERS.get(kind)?.info.description;
  const connected = status.connection === "connected";
  const busy = connected || status.connection === "connecting";
  const calibratable = isCalibratable(device) ? device : undefined;
  const name = status.device || label;
  const selfTimed = isSelfTimed(device);
  const program = selfTimed ? rt.manager.program(kind) : null;
  let actions: readonly { id: string; label: string; run(): void }[] = [];
  try {
    actions = device?.actions?.() ?? [];
  } catch (err) {
    console.error(`[toysync] ${kind} actions failed`, err);
  }

  return (
    <div className={`toysync-card${status.needsCalibration ? " toysync-card-attention" : ""}`}>
      <div className="toysync-card-head">
        <h3 className="toysync-h3">{label}</h3>
        <span className={`toysync-pill toysync-pill-${status.connection}`}>{connectionText(status)}</span>
      </div>
      {description && <div className="toysync-muted">{description}</div>}
      {selfTimed && (
        <div className="toysync-card-line toysync-muted">
          Times its own output from the video.{" "}
          {program ? `Playing scene ${program.sceneId}'s script (${Object.keys(program.mapping).length} mapped channels).` : "No scene with a script open."}
        </div>
      )}
      {(status.device || status.battery !== undefined) && (
        <div className="toysync-card-line">
          {status.device && <span>{status.device}</span>}
          {status.battery !== undefined && <span className="toysync-battery">Battery {status.battery} %</span>}
        </div>
      )}
      {connected && (
        <div className="toysync-card-line">
          <span className="toysync-muted">Output</span>
          <OutputMeters output={status.output} name={name} />
        </div>
      )}
      {status.message && (
        <div className={status.connection === "error" ? "toysync-message toysync-error" : "toysync-message"} role="status">
          {status.message}
        </div>
      )}
      {calibratable && (
        <div className="toysync-card-line">
          <span className="toysync-muted">Calibration: {calibrationSummary(calibratable.calibration())}</span>
        </div>
      )}
      {status.needsCalibration && (
        <div className="toysync-attention" role="status">
          Needs calibration before it outputs anything.{" "}
          <Link to={calibrateStartHref(kind)}>Calibrate</Link>
        </div>
      )}
      <div className="toysync-card-actions">
        {!busy && (
          <button
            type="button"
            className="btn btn-primary btn-sm toysync-btn"
            // the click is the user gesture the Bluetooth picker needs
            onClick={() => void rt.manager.connect(kind)}
          >
            Connect
          </button>
        )}
        {busy && (
          <button type="button" className="btn btn-secondary btn-sm toysync-btn" onClick={() => rt.manager.disconnect(kind)}>
            Disconnect
          </button>
        )}
        {connected && (
          <button type="button" className="btn btn-secondary btn-sm toysync-btn" onClick={() => device?.test()}>
            Test
          </button>
        )}
        {connected && (
          <button type="button" className="btn btn-danger btn-sm toysync-btn" onClick={() => device?.stopNow()}>
            Stop
          </button>
        )}
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
        {calibratable && !status.needsCalibration && (
          <Link to={calibrateStartHref(kind)} className="btn btn-link btn-sm toysync-btn">
            {calibratable.calibration() ? "Recalibrate" : "Calibrate"}
          </Link>
        )}
      </div>
      {device?.settingsPanel !== undefined && (
        <div className="toysync-card-panel">{renderDriverComponent(device.settingsPanel, { device }, `${label} settings`)}</div>
      )}
    </div>
  );
}

function MappingSection(props: { scene: SceneInfo | undefined; settings: Settings }) {
  const { Link } = pluginApi().libraries.ReactRouterDOM;
  const { scene, settings } = props;
  return (
    <section aria-labelledby="toysync-mapping-h">
      <h2 id="toysync-mapping-h" className="toysync-h2">
        How scripts drive the devices
      </h2>
      <p>Every 50 ms the plugin turns the script into one frame that every device reads in its own way:</p>
      <ul className="toysync-list">
        <li>
          <strong>Intensity</strong> (overall strength): in speed mode from how fast the stroke moves, in position mode
          from how deep it is. Vibrators use only this.
        </li>
        <li>
          <strong>Balance</strong> (e-stim, between channel A and B): follows the stroke depth: out = A, deepest = B.
        </li>
        <li>
          <strong>Speed</strong> (e-stim pulse frequency): follows the stroke speed, mapped onto{" "}
          {settings.estimSpeedMinHz}–{settings.estimSpeedMaxHz} Hz.
        </li>
        <li>
          <strong>Embedded axes</strong> of multi-axis scripts win over the stroke: <code>volume</code> → intensity,{" "}
          <code>alpha</code> → balance, <code>e1</code>/<code>e2</code> → channel A/B (they replace intensity × balance
          for that channel), <code>pulse_frequency</code> → speed. The <em>Axis mapping</em> setting replaces this
          auto-detection.
        </li>
        <li>Gain from other plugins scales intensity and the channels, never balance or speed.</li>
        <li>
          A scene can have its own mapping per device: open the scene's <strong>Interactive</strong> tab to change
          what each script channel drives, invert it, narrow its range or shift the scene's timing, and save it to the
          scene. What follows is the default without one.
        </li>
      </ul>
      <h3 className="toysync-h3">{scene ? "This scene" : "Current scene"}</h3>
      {!scene && <p className="toysync-muted">Open a scene to see how its script is mapped.</p>}
      {scene && (
        <div className="toysync-scene">
          <div className="toysync-card-line">
            <Link to={`/scenes/${encodeURIComponent(scene.id)}`}>{scene.title || `Scene ${scene.id}`}</Link>
            <span className="toysync-muted">{sceneStateText(scene)}</span>
          </div>
          {scene.mapping && (
            <>
              <table className="toysync-table">
                <thead>
                  <tr>
                    <th scope="col">Part</th>
                    <th scope="col">Comes from</th>
                  </tr>
                </thead>
                <tbody>
                  {mappingRows(scene.mapping, settings.mode).map((r) => (
                    <tr key={r.target}>
                      <td>{r.label}</td>
                      <td>{r.source}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {scene.mapping.problems.length > 0 && (
                <ul className="toysync-list toysync-error">
                  {scene.mapping.problems.map((p) => (
                    <li key={p}>Axis mapping: {p}</li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}

function sceneStateText(scene: SceneInfo): string {
  if (!scene.interactive) return "not interactive (no funscript)";
  switch (scene.scriptState) {
    case "loading":
      return "loading the funscript…";
    case "missing":
      return "no funscript";
    case "error":
      return "the funscript failed to load";
    case "ready":
      return scene.mapping ? "" : "the script has nothing the devices can use";
    default:
      return "";
  }
}
