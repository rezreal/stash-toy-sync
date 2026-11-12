// TCode device settings (rendered on /toysync, props { device }): TCode
// Player's "Device settings" dialog as a panel. Preset, connection and
// playback, filling in missing axes, per-axis range / invert / speed limit
// with Test, and the default channel -> axis table. Edits are a draft until
// Save, which stores the profile in the plugin config (tcodeProfile).
// TCode Player's "separate axis files" section is left out: Toy Sync loads
// the scripts itself; the setting is kept in the stored profile.
import type { ChangeEvent } from "react";
import {
  applyPreset,
  AXES,
  AXIS_LABELS,
  cloneProfile,
  DEVICE_PRESETS,
  GENERATE_LEVELS,
  isAxis,
  LEVEL_LABELS,
  MODELS,
  normalizeChannelName,
  normalizeProfile,
  type Axis,
  type AxisCfg,
  type GenerateLevel,
  type Profile,
} from "./core.ts";
import type { TcodeDevice } from "./device.ts";
import { errorText, NumberInput, RangePair, Switch, useEngineState, useStyles, useUid } from "./ui.tsx";

const LEVELS = Object.keys(GENERATE_LEVELS) as GenerateLevel[];

function AxisSelect(props: { value: string; profile: Profile; onChange: (v: string) => void }) {
  return (
    <select
      className="form-control form-control-sm toysync-tc-select"
      value={props.value}
      onChange={(e: ChangeEvent<HTMLSelectElement>) => props.onChange(e.target.value)}
    >
      <option value="off">— off —</option>
      {AXES.map((a) => (
        <option key={a} value={a}>
          {`${a} ${AXIS_LABELS[a]}${props.profile.axes[a].enabled ? "" : " (disabled)"}`}
        </option>
      ))}
    </select>
  );
}

export function TcodeSettingsPanel(props: { device: TcodeDevice }) {
  useStyles();
  const { device } = props;
  const engine = device.engine;
  const s = useEngineState(engine);
  const uid = useUid("toysync-tc");
  const [draft, setDraft] = React.useState<Profile>(() => cloneProfile(s.profile));
  const [dirty, setDirty] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [message, setMessage] = React.useState<{ ok: boolean; text: string } | null>(null);
  const [newName, setNewName] = React.useState("");

  // the stored profile arrives after mount (or changes elsewhere): follow it while there is no draft
  React.useEffect(() => {
    if (!dirty) setDraft(cloneProfile(s.profile));
  }, [s.profile, dirty]);

  const p = draft;
  const put = (next: Profile) => {
    setDraft(next);
    setDirty(true);
    setMessage(null);
  };
  const upd = (patch: Partial<Profile>) => put({ ...p, ...patch });
  const updAxis = (a: Axis, patch: Partial<AxisCfg>) => {
    const next: Profile = { ...p, axes: { ...p.axes, [a]: { ...p.axes[a], ...patch } } };
    if ("enabled" in patch) next.model = "custom"; // hand-picked axes -> custom device
    put(next);
  };
  const updMap = (name: string, axis: string) => upd({ channelMap: { ...p.channelMap, [name]: axis } });
  const delMap = (name: string) => {
    const m = { ...p.channelMap };
    delete m[name];
    upd({ channelMap: m });
  };
  const num = (v: number | "", d: number) => (v === "" ? d : v);

  async function save() {
    setSaving(true);
    try {
      await device.saveProfile(p);
      setDirty(false);
      setMessage({ ok: true, text: "TCode device profile saved." });
    } catch (e) {
      setMessage({ ok: false, text: `Could not save: ${errorText(e)}` });
    } finally {
      setSaving(false);
    }
  }

  const canTest = (s.status === "connected" || s.previews > 0) && !s.testing;

  return (
    <div className="toysync-tc">
      <h3>Device</h3>
      <div className="toysync-tc-row">
        <select
          className="form-control form-control-sm toysync-tc-select"
          aria-label="Device preset"
          value={p.model}
          onChange={(e: ChangeEvent<HTMLSelectElement>) => put(applyPreset(p, e.target.value))}
        >
          {MODELS.map((k) => (
            <option key={k} value={k}>
              {DEVICE_PRESETS[k].label}
            </option>
          ))}
        </select>
        <span className="toysync-tc-muted toysync-tc-small">
          {p.model === "custom"
            ? "Choose the active axes yourself in the table below."
            : "Active axes come from the preset. Range, invert and speed stay as you set them."}
        </span>
      </div>
      {s.deviceInfo && <div className="toysync-tc-muted toysync-tc-small">Firmware: {s.deviceInfo}</div>}

      <h3>Connection &amp; playback</h3>
      <div className="toysync-tc-grid">
        <label htmlFor={`${uid}-baud`}>Baud rate</label>
        <NumberInput id={`${uid}-baud`} value={p.baud} onChange={(v) => upd({ baud: num(v, 115200) })} />
        <label htmlFor={`${uid}-rate`}>Update rate (Hz)</label>
        <NumberInput id={`${uid}-rate`} value={p.rateHz} min={10} max={200} onChange={(v) => upd({ rateHz: num(v, 60) })} />
        <label htmlFor={`${uid}-ramp`}>Resync ramp (ms)</label>
        <NumberInput id={`${uid}-ramp`} value={p.rampMs} min={0} max={3000} step={50} onChange={(v) => upd({ rampMs: num(v, 400) })} />
        <label htmlFor={`${uid}-offset`}>Device offset (ms)</label>
        <NumberInput id={`${uid}-offset`} value={p.offsetMs} step={10} onChange={(v) => upd({ offsetMs: num(v, 0) })} />
      </div>
      <div className="toysync-tc-muted toysync-tc-small">
        The device offset adds to the scene offset and the latency setting, for this device only.
      </div>
      <Switch
        id={`${uid}-auto`}
        label="Reconnect to the last device automatically"
        checked={!!p.autoConnect}
        onChange={(v) => upd({ autoConnect: v })}
      />
      <Switch
        id={`${uid}-home`}
        label="Return to home position when paused"
        checked={!!p.homeOnPause}
        onChange={(v) => upd({ homeOnPause: v })}
      />

      <h3>Fill in missing axes</h3>
      <div className="toysync-tc-row">
        <select
          className="form-control form-control-sm toysync-tc-select"
          aria-label="Fill in missing axes"
          value={p.generate}
          onChange={(e: ChangeEvent<HTMLSelectElement>) => upd({ generate: e.target.value as GenerateLevel })}
        >
          {LEVELS.map((k) => (
            <option key={k} value={k}>
              {LEVEL_LABELS[k]}
            </option>
          ))}
        </select>
      </div>
      <Switch
        id={`${uid}-genvib`}
        label="Vibration follows stroke speed (V0)"
        checked={!!p.generateVibe}
        onChange={(v) => upd({ generateVibe: v })}
      />
      <div className="toysync-tc-muted toysync-tc-small">
        Scripts that only have a stroke get pitch, roll and twist (surge/sway on SR6) made from the stroke. A scene can
        choose its own level.
      </div>

      <h3>Axes (device limits)</h3>
      <div className="toysync-tc-muted toysync-tc-small">
        Min/Max scale the full script range into this window (lerp), so motion keeps its shape. Speed limit is in % of
        range per second (0 = off). Test needs a connected device or an open 3D preview.
      </div>
      <table className="table table-sm toysync-tc-table">
        <thead>
          <tr>
            <th>Axis</th>
            <th>On</th>
            <th>Range</th>
            <th>Invert</th>
            <th>Speed</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {AXES.map((a) => (
            <tr key={a} className={p.axes[a].enabled ? "" : "toysync-tc-off"}>
              <td>
                <b>{a}</b> <span className="toysync-tc-muted">{AXIS_LABELS[a]}</span>
              </td>
              <td>
                <input
                  type="checkbox"
                  aria-label={`${a} on`}
                  checked={!!p.axes[a].enabled}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => updAxis(a, { enabled: e.target.checked })}
                />
              </td>
              <td>
                <RangePair min={p.axes[a].min} max={p.axes[a].max} onChange={(mn, mx) => updAxis(a, { min: mn, max: mx })} />
              </td>
              <td>
                <input
                  type="checkbox"
                  aria-label={`${a} invert`}
                  checked={!!p.axes[a].invert}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => updAxis(a, { invert: e.target.checked })}
                />
              </td>
              <td>
                <NumberInput value={p.axes[a].speed} min={0} step={50} width={80} onChange={(v) => updAxis(a, { speed: num(v, 0) })} />
              </td>
              <td>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={!canTest || !p.axes[a].enabled}
                  onClick={() => void engine.testAxisCfg(a, normalizeProfile(p).axes[a])}
                >
                  Test
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>Default channel → axis mapping</h3>
      <div className="toysync-tc-muted toysync-tc-small">
        Used for scenes without their own mapping, and for generated axes. Add aliases for unusual channel names.
      </div>
      <table className="table table-sm toysync-tc-table">
        <tbody>
          {Object.keys(p.channelMap)
            .sort()
            .map((name) => (
              <tr key={name}>
                <td>
                  <code>{name}</code>
                </td>
                <td>
                  <AxisSelect value={isAxis(p.channelMap[name]) ? p.channelMap[name]! : "off"} profile={p} onChange={(v) => updMap(name, v)} />
                </td>
                <td>
                  <button type="button" className="btn btn-link btn-sm" aria-label={`Remove ${name}`} onClick={() => delMap(name)}>
                    ×
                  </button>
                </td>
              </tr>
            ))}
          <tr>
            <td>
              <input
                className="form-control form-control-sm"
                placeholder="channel name"
                value={newName}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setNewName(e.target.value)}
              />
            </td>
            <td colSpan={2}>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={!newName.trim()}
                onClick={() => {
                  updMap(normalizeChannelName(newName).toLowerCase(), "off");
                  setNewName("");
                }}
              >
                Add
              </button>
            </td>
          </tr>
        </tbody>
      </table>

      {message && <div className={message.ok ? "toysync-tc-notice" : "toysync-tc-error"}>{message.text}</div>}
      <div className="toysync-tc-row">
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => put(normalizeProfile(undefined))}>
          Reset to defaults
        </button>
        <span className="toysync-tc-grow" />
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={!dirty}
          onClick={() => {
            setDraft(cloneProfile(s.profile));
            setDirty(false);
            setMessage(null);
          }}
        >
          Revert
        </button>
        <button type="button" className="btn btn-primary btn-sm" disabled={!dirty || saving} onClick={() => void save()}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>

      {s.deviceLog.length > 0 && (
        <details>
          <summary className="toysync-tc-small">Device log</summary>
          <pre className="toysync-tc-log">{s.deviceLog.join("\n")}</pre>
        </details>
      )}
    </div>
  );
}
