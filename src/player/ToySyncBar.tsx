// The compact bar under stash's scene player. Stateless: everything comes
// in as props (see ToySyncSlot.tsx). Lists the connected devices (name,
// battery, meter), links to the devices page, a calibration link when an
// e-stim device needs one, and Stop for everything.
import type { DeviceEntry } from "../devices/manager.ts";
import type { DeviceKind } from "../devices/types.ts";
import { calibrateStartHref, DEVICES_ROUTE } from "../pages/links.ts";
import { pluginApi } from "../ui/pluginApi.ts";
import { OutputMeters } from "../ui/Meter.tsx";
import { deviceMessages, gainNote, liveEntries, needingCalibration, scriptNote, type ScriptState } from "./view.ts";

export interface ToySyncBarProps {
  entries: DeviceEntry[];
  /** registered kinds, for the Connect buttons */
  kinds: DeviceKind[];
  label(kind: DeviceKind): string;
  interactive: boolean;
  scriptState: ScriptState;
  gain: number;
  onConnect(kind: DeviceKind): void;
  onStop(): void;
}

export function ToySyncBar(props: ToySyncBarProps) {
  const { Link } = pluginApi().libraries.ReactRouterDOM;
  const live = liveEntries(props.entries);
  const calibrate = needingCalibration(props.entries);
  const note = scriptNote(props.interactive, props.scriptState);
  const gainText = gainNote(props.gain);
  const nameOf = (e: DeviceEntry) => e.status.device || props.label(e.kind);
  const messages = deviceMessages(props.entries, nameOf);

  return (
    <div className="toysync" role="group" aria-label="Toy Sync">
      <div className="toysync-row">
        <Link to={DEVICES_ROUTE} className="toysync-brand" title="Devices, mapping and calibration">
          Toy Sync
        </Link>
        {live.map((e) => (
          <span key={e.kind} className="toysync-dev">
            <span className="toysync-device" title={nameOf(e)}>
              {e.status.connection === "connecting" ? `${props.label(e.kind)}: connecting…` : nameOf(e)}
            </span>
            {e.status.connection === "connected" && e.status.battery !== undefined && (
              <span className="toysync-battery" title="Battery">
                {e.status.battery} %
              </span>
            )}
            {e.status.connection === "connected" && <OutputMeters output={e.status.output} name={nameOf(e)} />}
          </span>
        ))}
        {live.length === 0 &&
          props.kinds.map((kind) => (
            <button
              key={kind}
              type="button"
              className="btn btn-secondary btn-sm toysync-btn toysync-connect"
              onClick={() => props.onConnect(kind)}
              aria-label={`Connect a ${props.label(kind)} over Bluetooth`}
            >
              Connect {props.label(kind)}
            </button>
          ))}
        {gainText && <span className="toysync-gain">{gainText}</span>}
        {calibrate && (
          <Link to={calibrateStartHref(calibrate.kind)} className="toysync-calibrate">
            Calibrate {props.label(calibrate.kind)}
          </Link>
        )}
        {live.length > 0 && (
          <span className="toysync-actions">
            <button
              type="button"
              className="btn btn-danger btn-sm toysync-btn"
              onClick={props.onStop}
              aria-label="Stop every device and disconnect"
            >
              Stop
            </button>
          </span>
        )}
      </div>
      {messages.map((m) => (
        <div key={m.text} className={m.error ? "toysync-message toysync-error" : "toysync-message"} role="status">
          {m.text}
        </div>
      ))}
      {note && <div className="toysync-note">{note}</div>}
    </div>
  );
}
