// PiuPiu panel on /toysync (props { device }): hold-to-squirt, as TCode
// Player's navbar menu had it. It fires for as long as the button is held
// and never stays on after release, blur or unmount.
import type { KeyboardEvent, SyntheticEvent } from "react";
import { useStatusTick, useStyles } from "../tcode/ui.tsx";
import type { PiupiuDevice } from "./device.ts";

export function PiupiuSettingsPanel(props: { device: PiupiuDevice }) {
  useStyles();
  const { device } = props;
  useStatusTick(device);
  const connected = device.status().connection === "connected";
  const start = (e: SyntheticEvent) => {
    e.preventDefault();
    device.squirt(true);
  };
  const stop = () => device.squirt(false);
  React.useEffect(() => () => device.squirt(false), [device]);
  return (
    <div className="toysync-tc">
      <div className="toysync-tc-row">
        <button
          type="button"
          className={"btn btn-sm " + (device.active() ? "btn-info" : "btn-secondary")}
          disabled={!connected}
          title="Hold to squirt"
          onMouseDown={start}
          onMouseUp={stop}
          onMouseLeave={stop}
          onTouchStart={start}
          onTouchEnd={stop}
          onTouchCancel={stop}
          onKeyDown={(e: KeyboardEvent) => {
            if (e.key === " " || e.key === "Enter") start(e);
          }}
          onKeyUp={stop}
          onBlur={stop}
        >
          Squirt (hold)
        </button>
        <span className="toysync-tc-muted toysync-tc-small">
          Fires while held. During playback it follows the channel mapped to “squirt” (the script's lube channel by
          default) while that is above 50 %.
        </span>
      </div>
    </div>
  );
}
