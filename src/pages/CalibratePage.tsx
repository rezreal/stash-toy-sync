// /toysync/calibrate?device=<kind>&channel=a|b&step=1..4|review
//
// A step-by-step wizard per channel of an e-stim style device: 1 First
// felt, 2 Comfort max, 3 Nudge (sharp burst), 4 Hard max, then review &
// save. The URL is the state: every step, channel or device change pushes a
// history entry and the page renders from the query string, so back,
// forward and reload work; invalid parameters are normalised with replace.
// The levels picked so far survive in sessionStorage (wizard.ts).
import { isCalibratable, saveCalibration, validateCalibration } from "../devices/calibration.ts";
import { driverLabel } from "../devices/registry.ts";
import type { CalibratableDevice } from "../devices/types.ts";
import { getRuntime } from "../runtime.ts";
import { useDeviceEntries, useSyncedSettings } from "../ui/hooks.ts";
import { pluginApi } from "../ui/pluginApi.ts";
import { HoldToOutput, LevelControl, useProbeSession } from "./HoldToOutput.tsx";
import {
  calibrateHref,
  DEVICES_ROUTE,
  isCanonical,
  nextStep,
  parseCalibrateQuery,
  prevStep,
  resolveCalibrateLink,
  WIZARD_STEPS,
  type CalibrateChoice,
  type CalibrateLink,
  type Channel,
  type WizardStep,
} from "./links.ts";
import { SafetyBox } from "./SafetyBox.tsx";
import {
  draftChannel,
  draftKey,
  initialDraft,
  isLevelStep,
  loadDraft,
  mergeCalibration,
  nudgeConfirmed,
  percentOfRange,
  reviewProblems,
  saveDraft,
  STEP_INFO,
  stepProblem,
  valueFor,
  withLevel,
  type Draft,
  type LevelStep,
} from "./wizard.ts";

export function CalibratePage() {
  const rt = getRuntime();
  useSyncedSettings(rt);
  const { Link, useHistory, useLocation } = pluginApi().libraries.ReactRouterDOM;
  const history = useHistory();
  const location = useLocation();
  const entries = useDeviceEntries(rt.manager);

  const choices: CalibrateChoice[] = [];
  for (const kind of rt.manager.kinds()) {
    const d = rt.manager.device(kind);
    if (!isCalibratable(d)) continue;
    const connected = entries.find((e) => e.kind === kind)?.status.connection === "connected";
    choices.push({ kind, channels: d.channels, connected });
  }
  const link = resolveCalibrateLink(parseCalibrateQuery(location.search), choices);
  const canonical = link ? calibrateHref(link) : undefined;

  // invalid or missing parameters: normalise in place (no new history entry)
  React.useEffect(() => {
    if (link && !isCanonical(location.search, link)) history.replace(canonical!);
  }, [canonical, location.search]);

  React.useEffect(() => {
    void rt.manager.resumeAll();
  }, [rt]);

  const header = (
    <div className="toysync-page-head">
      <h1 className="toysync-h1">Calibrate</h1>
      <Link to={DEVICES_ROUTE}>Back to devices</Link>
    </div>
  );

  if (!link) {
    return (
      <div className="toysync-page">
        {header}
        <SafetyBox />
        <p>
          No e-stim device is connected. Calibration needs the device connected, because you feel each level while
          picking it.
        </p>
        <p>
          {choices.length === 0
            ? "None of the installed drivers needs calibration."
            : `Connect a ${choices.map((c) => driverLabel(c.kind)).join(" or ")} on the devices page first.`}{" "}
          <Link to={DEVICES_ROUTE}>Go to devices</Link>
        </p>
      </div>
    );
  }

  const device = rt.manager.device(link.device) as CalibratableDevice;
  const status = entries.find((e) => e.kind === link.device)?.status ?? device.status();
  const go = (patch: Partial<CalibrateLink>) => history.push(calibrateHref({ ...link, ...patch }));

  return (
    <div className="toysync-page">
      {header}
      <SafetyBox />
      {choices.length > 1 && (
        <div className="toysync-tabs" role="group" aria-label="Device">
          {choices.map((c) => (
            <button
              key={c.kind}
              type="button"
              className={`btn btn-sm ${c.kind === link.device ? "btn-primary" : "btn-secondary"} toysync-btn`}
              aria-pressed={c.kind === link.device}
              onClick={() => c.kind !== link.device && go({ device: c.kind, channel: c.channels[0]!, step: 1 })}
            >
              {driverLabel(c.kind)}
            </button>
          ))}
        </div>
      )}
      {status.connection !== "connected" ? (
        <div className="toysync-card">
          <h2 className="toysync-h2">{driverLabel(link.device)} isn't connected</h2>
          {status.message && <p className="toysync-message">{status.message}</p>}
          <button type="button" className="btn btn-primary toysync-btn" onClick={() => void rt.manager.connect(link.device)}>
            Connect
          </button>
        </div>
      ) : (
        <Wizard key={`${link.device}.${device.id}.${link.channel}`} device={device} link={link} go={go} />
      )}
    </div>
  );
}

const STEP_NAMES: Record<string, string> = { 1: "First felt", 2: "Comfort max", 3: "Nudge", 4: "Hard max", review: "Review" };

function Wizard(props: { device: CalibratableDevice; link: CalibrateLink; go(patch: Partial<CalibrateLink>): void }) {
  const { device, link, go } = props;
  const { Link } = pluginApi().libraries.ReactRouterDOM;
  const range = device.levelRange();
  const key = draftKey(device.kind, device.id, link.channel);
  const [draft, setDraftState] = React.useState<Draft>(() => loadDraft(key) ?? initialDraft(device.calibration()?.[link.channel]));
  const [saved, setSaved] = React.useState<string | undefined>(undefined);
  const setDraft = (d: Draft) => {
    setDraftState(d);
    saveDraft(key, d);
    setSaved(undefined);
  };
  const step = link.step;
  const levelStep: LevelStep | undefined = isLevelStep(step) ? step : undefined;
  const probeKind = levelStep ? STEP_INFO[levelStep].probe : "steady";
  const { session, output } = useProbeSession(device, link.channel, probeKind, String(step));

  const stopAll = () => {
    session.stop();
    device.stopNow();
  };

  return (
    <div className="toysync-wizard">
      {device.channels.length > 1 && (
        <div className="toysync-tabs" role="group" aria-label="Channel">
          {device.channels.map((ch: Channel) => (
            <button
              key={ch}
              type="button"
              className={`btn btn-sm ${ch === link.channel ? "btn-primary" : "btn-secondary"} toysync-btn`}
              aria-pressed={ch === link.channel}
              onClick={() => ch !== link.channel && go({ channel: ch, step: 1 })}
            >
              Channel {ch.toUpperCase()}
            </button>
          ))}
        </div>
      )}
      <ol className="toysync-steps" aria-label="Steps">
        {WIZARD_STEPS.map((s: WizardStep) => (
          <li key={String(s)}>
            <button
              type="button"
              className={`toysync-step${s === step ? " is-current" : ""}`}
              aria-current={s === step ? "step" : undefined}
              onClick={() => s !== step && go({ step: s })}
            >
              {s === "review" ? "" : `${s}. `}
              {STEP_NAMES[String(s)]}
            </button>
          </li>
        ))}
      </ol>

      {levelStep ? (
        <LevelStepView
          step={levelStep}
          draft={draft}
          setDraft={setDraft}
          range={range}
          channel={link.channel}
          session={session}
          output={output}
        />
      ) : (
        <ReviewView
          device={device}
          channel={link.channel}
          draft={draft}
          range={range}
          saved={saved}
          onSave={() => {
            const ch = draftChannel(draft, range);
            const c = mergeCalibration(device.calibration(), link.channel, ch, new Date().toISOString());
            if (!c || validateCalibration(c, range).length > 0) return;
            saveCalibration(device.kind, device.id, c);
            device.setCalibration(c);
            setSaved(c.updatedAt);
          }}
        />
      )}

      <div className="toysync-wizard-nav">
        {prevStep(step) !== undefined ? (
          <button type="button" className="btn btn-secondary toysync-btn" onClick={() => go({ step: prevStep(step)! })}>
            Back
          </button>
        ) : (
          <Link to={DEVICES_ROUTE} className="btn btn-secondary toysync-btn">
            Cancel
          </Link>
        )}
        {levelStep && (
          <button
            type="button"
            className="btn btn-primary toysync-btn"
            disabled={stepProblem(draft, levelStep, range) !== undefined}
            onClick={() => {
              // keep the shown level even when it was never touched
              setDraft(withLevel(draft, levelStep, valueFor(draft, levelStep, range), range));
              go({ step: nextStep(step)! });
            }}
          >
            Next
          </button>
        )}
        {step === "review" && saved && link.channel === "a" && device.channels.includes("b") && (
          <button type="button" className="btn btn-primary toysync-btn" onClick={() => go({ channel: "b", step: 1 })}>
            Calibrate channel B
          </button>
        )}
        <button type="button" className="btn btn-danger toysync-btn toysync-stop" onClick={stopAll}>
          Stop
        </button>
      </div>
    </div>
  );
}

function LevelStepView(props: {
  step: LevelStep;
  draft: Draft;
  setDraft(d: Draft): void;
  range: { min: number; max: number };
  channel: Channel;
  session: ReturnType<typeof useProbeSession>["session"];
  output: number;
}) {
  const { step, draft, range } = props;
  const info = STEP_INFO[step];
  const value = valueFor(draft, step, range);
  const problem = stepProblem(draft, step, range);
  const levelProblem = problem && !(step === 3 && problem.startsWith("Try the burst"));
  return (
    <div className="toysync-step-body">
      <h2 className="toysync-h2">
        Channel {props.channel.toUpperCase()} · Step {step}: {info.title}
      </h2>
      <p>{info.help}</p>
      <LevelControl
        value={value}
        range={range}
        percent={percentOfRange(value, range)}
        label="Level"
        onChange={(v) => props.setDraft(withLevel(draft, step, v, range))}
      />
      <HoldToOutput
        session={props.session}
        level={value}
        output={props.output}
        label={info.probe === "burst" ? "Hold for the nudge burst" : "Hold to feel this level"}
      />
      {step === 3 && (
        <label className="toysync-confirm">
          <input
            type="checkbox"
            checked={nudgeConfirmed(draft, range)}
            disabled={value <= valueFor(draft, 2, range)}
            onChange={(e) =>
              props.setDraft({ ...withLevel(draft, 3, value, range), nudgeConfirmed: e.currentTarget.checked ? value : undefined })
            }
          />{" "}
          I tried level {value}: it feels sharp but OK.
        </label>
      )}
      {levelProblem && (
        <p className="toysync-message toysync-error" role="status">
          {problem}
        </p>
      )}
    </div>
  );
}

function ReviewView(props: {
  device: CalibratableDevice;
  channel: Channel;
  draft: Draft;
  range: { min: number; max: number };
  saved: string | undefined;
  onSave(): void;
}) {
  const { device, channel, draft, range } = props;
  const ch = draftChannel(draft, range);
  const problems = reviewProblems(draft, range);
  const needsA = channel === "b" && !device.calibration();
  if (needsA) problems.push("Calibrate channel A first: channel B is saved next to it.");
  const rows: [string, number][] = [
    ["First felt", ch.firstFelt],
    ["Comfort max", ch.comfortMax],
    ["Nudge", ch.nudge],
    ["Hard max", ch.hardMax],
  ];
  return (
    <div className="toysync-step-body">
      <h2 className="toysync-h2">Channel {channel.toUpperCase()} · Review</h2>
      <p>
        Scripts output between First felt and Comfort max; a nudge goes to the nudge level; nothing ever goes above Hard
        max.
      </p>
      <table className="toysync-table">
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k}>
              <th scope="row">{k}</th>
              <td>
                {v} <span className="toysync-muted">({percentOfRange(v, range)} %)</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {problems.length > 0 && (
        <ul className="toysync-list toysync-error" role="status">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {props.saved ? (
        <p className="toysync-ok" role="status">
          Saved channel {channel.toUpperCase()}.
        </p>
      ) : (
        <button type="button" className="btn btn-primary toysync-btn" disabled={problems.length > 0} onClick={props.onSave}>
          Save channel {channel.toUpperCase()}
        </button>
      )}
    </div>
  );
}
