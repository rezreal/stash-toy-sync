// "Hold to output" for the calibration probe: output runs only while the
// button is pressed (pointer) or Space is held (keyboard), ramping up from 0
// over ~1 s. Release, pointer leave/cancel, losing focus, the window losing
// focus, the tab being hidden and unmounting all stop it at once.
import type { KeyboardEvent, PointerEvent } from "react";
import type { CalibratableDevice } from "../devices/types.ts";
import { createProbeSession, type ProbeSession } from "./probe.ts";

/** a probe session for one device / channel / waveform, stopped when any of them changes or on unmount */
export function useProbeSession(
  device: CalibratableDevice,
  channel: "a" | "b",
  kind: "steady" | "burst",
  resetKey: string,
): { session: ProbeSession; output: number } {
  const [output, setOutput] = React.useState(0);
  const session = React.useMemo(
    () => createProbeSession(device, { channel, kind, onLevel: setOutput }),
    [device, channel, kind, resetKey],
  );
  React.useEffect(() => {
    const stop = () => session.stop();
    const onVisibility = () => {
      if (document.visibilityState !== "visible") session.stop();
    };
    window.addEventListener("blur", stop);
    window.addEventListener("pagehide", stop);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("blur", stop);
      window.removeEventListener("pagehide", stop);
      document.removeEventListener("visibilitychange", onVisibility);
      session.stop();
    };
  }, [session]);
  return { session, output };
}

export interface HoldToOutputProps {
  session: ProbeSession;
  /** the chosen level the output ramps to */
  level: number;
  /** what is being output right now (0 while released) */
  output: number;
  label: string;
  disabled?: boolean;
}

export function HoldToOutput(props: HoldToOutputProps) {
  const { session, level } = props;
  const [held, setHeld] = React.useState(false);
  const hintId = React.useMemo(() => `toysync-hold-${Math.random().toString(36).slice(2)}`, []);

  // a level change while held moves the target (ramping up, dropping at once)
  React.useEffect(() => {
    session.setTarget(level);
  }, [session, level]);
  React.useEffect(() => {
    if (props.disabled) {
      session.stop();
      setHeld(false);
    }
  }, [session, props.disabled]);
  // a new session (step / channel change) starts released
  React.useEffect(() => setHeld(false), [session]);

  const start = () => {
    if (props.disabled) return;
    session.start(level);
    setHeld(true);
  };
  const stop = () => {
    session.stop();
    setHeld(false);
  };
  const isSpace = (e: KeyboardEvent) => e.key === " " || e.key === "Spacebar";

  return (
    <div className="toysync-hold-wrap">
      <button
        type="button"
        className={`toysync-hold${held ? " is-held" : ""}`}
        disabled={props.disabled}
        aria-pressed={held}
        aria-describedby={hintId}
        onPointerDown={(e: PointerEvent<HTMLButtonElement>) => {
          if (e.pointerType === "mouse" && e.button !== 0) return;
          e.preventDefault();
          e.currentTarget.focus();
          start();
        }}
        onPointerUp={stop}
        onPointerCancel={stop}
        onPointerLeave={stop}
        onBlur={stop}
        onKeyDown={(e) => {
          if (!isSpace(e)) return;
          e.preventDefault();
          if (!e.repeat) start();
        }}
        onKeyUp={(e) => {
          if (!isSpace(e)) return;
          e.preventDefault();
          stop();
        }}
        onContextMenu={(e) => e.preventDefault()}
      >
        {held ? `Outputting ${props.output} of ${level}` : props.label}
      </button>
      <div id={hintId} className="toysync-muted toysync-hold-hint">
        Press and hold (or hold Space) to feel it; it ramps up over a second. Let go to stop.
      </div>
    </div>
  );
}

/** − / + and a slider for a raw device level, with the % of the range */
export function LevelControl(props: {
  value: number;
  range: { min: number; max: number };
  percent: number;
  label: string;
  onChange(v: number): void;
}) {
  const { value, range } = props;
  const set = (v: number) => props.onChange(Math.max(range.min, Math.min(range.max, Math.round(v))));
  const id = React.useMemo(() => `toysync-level-${Math.random().toString(36).slice(2)}`, []);
  return (
    <div className="toysync-level">
      <label htmlFor={id} className="toysync-level-label">
        {props.label}: <strong>{value}</strong> <span className="toysync-muted">({props.percent} % of {range.min}–{range.max})</span>
      </label>
      <div className="toysync-level-row">
        <button
          type="button"
          className="btn btn-secondary toysync-btn"
          onClick={() => set(value - 1)}
          disabled={value <= range.min}
          aria-label="One level lower"
        >
          −
        </button>
        <input
          id={id}
          type="range"
          className="toysync-slider"
          min={range.min}
          max={range.max}
          step={1}
          value={value}
          onChange={(e) => set(Number(e.currentTarget.value))}
        />
        <button
          type="button"
          className="btn btn-secondary toysync-btn"
          onClick={() => set(value + 1)}
          disabled={value >= range.max}
          aria-label="One level higher"
        >
          +
        </button>
      </div>
    </div>
  );
}
