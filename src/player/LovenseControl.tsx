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
    <div className="lovense-sync" role="group" aria-label="Lovense Sync">
      <div className="lovense-sync-row">
        {connected || connecting ? (
          <>
            <span className="lovense-sync-brand">Lovense</span>
            <span className="lovense-sync-device" title={status.device}>
              {connecting ? "Connecting…" : deviceLabel(status)}
            </span>
            {connected && status.battery !== undefined && (
              <span className="lovense-sync-battery" title="Battery">
                {status.battery} %
              </span>
            )}
            {connected && (
              <span className="lovense-sync-meter-wrap">
                <span
                  className="lovense-sync-meter"
                  role="meter"
                  aria-label="Vibration level"
                  aria-valuemin={0}
                  aria-valuemax={MAX_LEVEL}
                  aria-valuenow={level}
                >
                  <span className="lovense-sync-meter-fill" style={{ width: `${(level / MAX_LEVEL) * 100}%` }} />
                </span>
                <span className="lovense-sync-level" aria-hidden="true">
                  {level}
                </span>
              </span>
            )}
            {gainText && <span className="lovense-sync-gain">{gainText}</span>}
            <span className="lovense-sync-actions">
              {connected && (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm lovense-sync-btn"
                  onClick={props.onTest}
                  aria-label="Test: vibrate for one second"
                >
                  Test
                </button>
              )}
              <button
                type="button"
                className="btn btn-danger btn-sm lovense-sync-btn"
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
            className="btn btn-secondary btn-sm lovense-sync-btn lovense-sync-connect"
            onClick={props.onConnect}
            aria-label="Connect a Lovense toy over Bluetooth"
          >
            Lovense · Connect
          </button>
        )}
      </div>
      {status.message && (
        <div className={status.connection === "error" ? "lovense-sync-message lovense-sync-error" : "lovense-sync-message"} role="status">
          {status.message}
        </div>
      )}
      {note && <div className="lovense-sync-note">{note}</div>}
    </div>
  );
}
