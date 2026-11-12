// Small React helpers shared by the TCode and PiuPiu panels.
import type { ChangeEvent } from "react";
import type { TcodeEngine } from "./engine.ts";
import { ensureStyles } from "./styles.ts";

/** re-renders on every engine change and returns its state */
export function useEngineState(engine: TcodeEngine): TcodeEngine["state"] {
  const [, force] = React.useReducer((x: number) => x + 1, 0);
  React.useEffect(() => engine.subscribe(force), [engine]);
  return engine.state;
}

/** re-renders on every status change of a device */
export function useStatusTick(device: { onStatus(cb: () => void): () => void }): void {
  const [, force] = React.useReducer((x: number) => x + 1, 0);
  React.useEffect(() => device.onStatus(force), [device]);
}

export function useStyles(): void {
  React.useEffect(() => ensureStyles(), []);
}

let uidSeq = 0;
/** a DOM id prefix unique to this component instance */
export function useUid(prefix: string): string {
  const [uid] = React.useState(() => `${prefix}-${++uidSeq}`);
  return uid;
}

export function NumberInput(props: {
  value: number | "";
  onChange: (v: number | "") => void;
  min?: number;
  max?: number;
  step?: number;
  width?: number;
  id?: string;
}) {
  return (
    <input
      type="number"
      id={props.id}
      className="form-control form-control-sm toysync-tc-num"
      style={props.width ? { width: props.width } : undefined}
      value={props.value}
      min={props.min}
      max={props.max}
      step={props.step ?? 1}
      onChange={(e: ChangeEvent<HTMLInputElement>) => props.onChange(e.target.value === "" ? "" : Number(e.target.value))}
    />
  );
}

export function Switch(props: { id: string; label: string; checked: boolean; onChange: (on: boolean) => void }) {
  return (
    <div className="custom-control custom-switch">
      <input
        type="checkbox"
        className="custom-control-input"
        id={props.id}
        checked={props.checked}
        onChange={(e: ChangeEvent<HTMLInputElement>) => props.onChange(e.target.checked)}
      />
      <label className="custom-control-label" htmlFor={props.id}>
        {props.label}
      </label>
    </div>
  );
}

/** two sliders for a 0..100 window */
export function RangePair(props: { min: number; max: number; onChange: (min: number, max: number) => void }) {
  const { min, max, onChange } = props;
  return (
    <div className="toysync-tc-range">
      <input
        type="range"
        className="custom-range"
        min={0}
        max={100}
        value={min}
        aria-label="Minimum"
        onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(Math.min(Number(e.target.value), max), max)}
      />
      <input
        type="range"
        className="custom-range"
        min={0}
        max={100}
        value={max}
        aria-label="Maximum"
        onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(min, Math.max(Number(e.target.value), min))}
      />
      <span>
        {min}–{max}
      </span>
    </div>
  );
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
