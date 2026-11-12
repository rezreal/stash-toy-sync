// The compact bar under stash's scene player. Stateless: everything comes
// in as props (see ToySyncSlot.tsx). Lists the connected devices by
// instance name (battery, meter), links to the devices page, a calibration
// link when an e-stim device needs one, and Stop for everything.
import type { DeviceEntry } from "../devices/manager.ts";
import { calibrateStartHref, DEVICES_ROUTE } from "../pages/links.ts";
import { pluginApi } from "../ui/pluginApi.ts";
import { OutputMeters } from "../ui/Meter.tsx";
import { deviceMessages, gainNote, liveEntries, needingCalibration, scriptNote, type ScriptState } from "./view.ts";

export interface ToySyncBarProps {
  entries: DeviceEntry[];
  interactive: boolean;
  scriptState: ScriptState;
  gain: number;
  /** an instance id: the click is the user gesture its picker needs */
  onConnect(instanceId: string): void;
  onStop(): void;
}

export function ToySyncBar(props: ToySyncBarProps) {
  const { Link } = pluginApi().libraries.ReactRouterDOM;
  const live = liveEntries(props.entries);
  const calibrate = needingCalibration(props.entries);
  const note = scriptNote(props.interactive, props.scriptState);
  const gainText = gainNote(props.gain);
  const nameOf = (e: DeviceEntry) => e.name;
  const messages = deviceMessages(props.entries, nameOf);

  return (
    <div className="toysync" role="group" aria-label="Toy Sync">
      <div className="toysync-row">
        <Link to={DEVICES_ROUTE} className="toysync-brand" title="Devices, mapping and calibration">
          Toy Sync
        </Link>
        {live.map((e) => (
          <span key={e.instanceId} className="toysync-dev">
            <span className="toysync-device" title={e.status.device ? `${nameOf(e)} · ${e.status.device}` : nameOf(e)}>
              {e.status.connection === "connecting" ? `${nameOf(e)}: connecting…` : nameOf(e)}
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
          props.entries.map((e) => (
            <button
              key={e.instanceId}
              type="button"
              className="btn btn-secondary btn-sm toysync-btn toysync-connect"
              onClick={() => props.onConnect(e.instanceId)}
              aria-label={`Connect ${nameOf(e)}`}
            >
              Connect {nameOf(e)}
            </button>
          ))}
        {gainText && <span className="toysync-gain">{gainText}</span>}
        {calibrate && (
          <Link to={calibrateStartHref(calibrate.instanceId)} className="toysync-calibrate">
            Calibrate {nameOf(calibrate)}
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
