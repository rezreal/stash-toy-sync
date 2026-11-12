// A small horizontal output meter (0..1), shared by the bar and the pages.
import { meterPercent } from "../player/view.ts";

export function Meter(props: { value: number | undefined; label: string; short?: string }) {
  const pct = meterPercent(props.value);
  return (
    <span className="toysync-meter-wrap">
      {props.short && (
        <span className="toysync-meter-ch" aria-hidden="true">
          {props.short}
        </span>
      )}
      <span className="toysync-meter" role="meter" aria-label={props.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
        <span className="toysync-meter-fill" style={{ width: `${pct}%` }} />
      </span>
    </span>
  );
}

/** the meters of a device: one, or A and B */
export function OutputMeters(props: { output: { a: number; b?: number } | undefined; name: string }) {
  const out = props.output ?? { a: 0 };
  if (out.b === undefined) return <Meter value={out.a} label={`${props.name} output`} />;
  return (
    <span className="toysync-meters">
      <Meter value={out.a} label={`${props.name} channel A output`} short="A" />
      <Meter value={out.b} label={`${props.name} channel B output`} short="B" />
    </span>
  );
}
