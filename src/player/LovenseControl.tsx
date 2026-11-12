// The compact control under stash's scene player. Stateless: everything
// comes in as props (see LovenseSlot.tsx).
import type { LovenseStatus } from "../lovense/device.ts";
import { MAX_LEVEL } from "../lovense/protocol.ts";
import { deviceLabel, gainNote, scriptNote, type ScriptState } from "./view.ts";

export interface LovenseControlProps {
  status: LovenseStatus;
  interactive: boolean;
  scriptState: ScriptState;
  gain: number;
  onConnect(): void;
  onTest(): void;
  onStop(): void;
}

export function LovenseControl(props: LovenseControlProps) {
  const { status, interactive, scriptState, gain } = props;
  const note = scriptNote(interactive, scriptState);
  const connected = status.connection === "connected";
  const connecting = status.connection === "connecting";
  const level = status.level ?? 0;
  const gainText = gainNote(gain);

  return (
    <div className="toysync" role="group" aria-label="Toy Sync">
      <div className="toysync-row">
        {connected || connecting ? (
          <>
            <span className="toysync-brand">Lovense</span>
            <span className="toysync-device" title={status.device}>
              {connecting ? "Connecting…" : deviceLabel(status)}
            </span>
            {connected && status.battery !== undefined && (
              <span className="toysync-battery" title="Battery">
                {status.battery} %
              </span>
            )}
            {connected && (
              <span className="toysync-meter-wrap">
                <span
                  className="toysync-meter"
                  role="meter"
                  aria-label="Vibration level"
                  aria-valuemin={0}
                  aria-valuemax={MAX_LEVEL}
                  aria-valuenow={level}
                >
                  <span className="toysync-meter-fill" style={{ width: `${(level / MAX_LEVEL) * 100}%` }} />
                </span>
                <span className="toysync-level" aria-hidden="true">
                  {level}
                </span>
              </span>
            )}
            {gainText && <span className="toysync-gain">{gainText}</span>}
            <span className="toysync-actions">
              {connected && (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm toysync-btn"
                  onClick={props.onTest}
                  aria-label="Test: vibrate for one second"
                >
                  Test
                </button>
              )}
              <button
                type="button"
                className="btn btn-danger btn-sm toysync-btn"
                onClick={props.onStop}
                aria-label="Stop the toy and disconnect"
              >
                Stop
              </button>
            </span>
          </>
        ) : (
          <button
            type="button"
            className="btn btn-secondary btn-sm toysync-btn toysync-connect"
            onClick={props.onConnect}
            aria-label="Connect a Lovense toy over Bluetooth"
          >
            Lovense · Connect
          </button>
        )}
      </div>
      {status.message && (
        <div className={status.connection === "error" ? "toysync-message toysync-error" : "toysync-message"} role="status">
          {status.message}
        </div>
      )}
      {note && <div className="toysync-note">{note}</div>}
    </div>
  );
}
