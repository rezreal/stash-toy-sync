// The scene page's "Interactive" tab: the scene's script channels with a
// preview line each, and per device instance (by name; every instance has
// its own mapping, saved under its instance id) a mapping row per channel (target,
// invert, min/max window, Test), its live output, its preview component and
// the scene offset. Edits go to the scene map store's working copy and apply
// live (the binder pushes them to the engine and the devices); Save writes
// toysync_map. The scene itself is bound by the player slot.
import type { DeviceEntry } from "../devices/manager.ts";
import { DRIVERS, driverLabel } from "../devices/registry.ts";
import type { ChannelMapping, ScriptChannel, ToyDevice } from "../devices/types.ts";
import { isSelfTimed } from "../mapping/effective.ts";
import { isEmptySceneMap, compactSceneMap } from "../mapping/sceneMap.ts";
import type { SceneMapState } from "../mapping/store.ts";
import { OFF_TARGET } from "../mapping/targets.ts";
import { connectionText } from "../pages/devicesView.ts";
import type { StashScene } from "../player/ToySyncSlot.tsx";
import { getRuntime, type Runtime } from "../runtime.ts";
import { renderDriverComponent } from "../ui/ErrorBoundary.tsx";
import { useBinder, useDeviceEntries, useLastScene, useSceneMapState } from "../ui/hooks.ts";
import { OutputMeters } from "../ui/Meter.tsx";
import { pluginApi } from "../ui/pluginApi.ts";
import { TcodePlayerNotice } from "../ui/TcodePlayerNotice.tsx";
import { DEVICES_ROUTE } from "../pages/links.ts";
import { Sparkline } from "./Sparkline.tsx";
import { channelLabel, groupTargets, optionText, readPercent, sourceText, targetLabel, targetsFor } from "./view.ts";

export const SCENE_TAB_KEY = "toysync-scene-panel";

const domId = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_");

export function SceneTab(props: { scene?: StashScene }) {
  const rt = getRuntime();
  const entries = useDeviceEntries(rt.manager);
  const st = useSceneMapState(rt.sceneMaps);
  useBinder(rt.binder);
  const info = useLastScene(rt.scene);
  const sceneId = props.scene?.id != null ? String(props.scene.id) : undefined;
  const time = React.useCallback(() => rt.clock.videoMs(), [rt]);
  if (!sceneId) return null;

  const bound = st?.sceneId === sceneId && rt.binder.sceneId() === sceneId;
  const channels = bound ? rt.binder.channels() : [];
  const durationMs = (props.scene?.files?.[0]?.duration ?? 0) * 1000;
  const scriptState = info?.id === sceneId ? info.scriptState : "none";
  const interactive = props.scene?.interactive === true;

  return (
    <div className="toysync-tab">
      <TcodePlayerNotice />
      {!interactive && <p className="toysync-muted">This scene has no funscript, so the devices stay off.</p>}
      {interactive && scriptState === "loading" && <p className="toysync-muted">Loading the funscript…</p>}
      {interactive && scriptState === "error" && <p className="toysync-message toysync-error">The funscript failed to load.</p>}
      {interactive && scriptState === "missing" && (
        <p className="toysync-muted">No usable funscript found for this scene; stash looks for a .funscript next to the video.</p>
      )}
      {bound && st && channels.length > 0 && (
        <>
          <section aria-labelledby="toysync-tab-channels-h">
            <h3 id="toysync-tab-channels-h" className="toysync-h3">
              Script channels
            </h3>
            <ul className="toysync-channels">
              {channels.map((ch) => (
                <li key={ch.id} className="toysync-channel">
                  <span className="toysync-channel-name">{channelLabel(ch.id)}</span>
                  <span className="toysync-muted toysync-small">{ch.actions.length} actions</span>
                  <Sparkline channel={ch} durationMs={durationMs} time={time} />
                </li>
              ))}
            </ul>
            <div className="toysync-row">
              <label htmlFor="toysync-offset" className="mb-0">
                Scene offset (ms)
              </label>
              <OffsetInput value={st.edit.offsetMs} onChange={(v) => rt.sceneMaps.setOffset(v)} />
              <span className="toysync-muted toysync-small">positive = devices run earlier; adds to the latency setting</span>
            </div>
          </section>
          {entries.map((e) => (
            <DeviceSection key={e.instanceId} rt={rt} entry={e} channels={channels} st={st} />
          ))}
          <SaveBar rt={rt} st={st} />
        </>
      )}
    </div>
  );
}

function OffsetInput(props: { value: number; onChange(v: number): void }) {
  const [draft, setDraft] = React.useState(String(props.value));
  React.useEffect(() => setDraft(String(props.value)), [props.value]);
  return (
    <input
      id="toysync-offset"
      type="number"
      step={10}
      className="form-control form-control-sm toysync-num toysync-num-wide"
      value={draft}
      onChange={(e) => {
        setDraft(e.target.value);
        const n = Number(e.target.value);
        if (e.target.value.trim() !== "" && Number.isFinite(n)) props.onChange(n);
      }}
      onBlur={() => setDraft(String(props.value))}
    />
  );
}

function PercentInput(props: { id: string; label: string; value: number; onChange(v: number): void }) {
  const [draft, setDraft] = React.useState(String(props.value));
  React.useEffect(() => setDraft(String(props.value)), [props.value]);
  return (
    <input
      id={props.id}
      type="number"
      min={0}
      max={100}
      step={1}
      aria-label={props.label}
      className="form-control form-control-sm toysync-num"
      value={draft}
      onChange={(e) => {
        setDraft(e.target.value);
        const v = readPercent(e.target.value);
        if (v !== undefined) props.onChange(v);
      }}
      onBlur={() => setDraft(String(props.value))}
    />
  );
}

function DeviceSection(props: { rt: Runtime; entry: DeviceEntry; channels: readonly ScriptChannel[]; st: SceneMapState }) {
  const { rt, entry, channels, st } = props;
  const { instanceId, kind } = entry;
  const device: ToyDevice | undefined = rt.manager.device(instanceId);
  if (!device) return null;
  const status = entry.status;
  const connected = status.connection === "connected";
  const busy = connected || status.connection === "connecting";
  const label = entry.name;
  const name = status.device || label;
  const targets = targetsFor(device);
  const groups = groupTargets(targets);
  const eff = rt.binder.mappingFor(device);
  // this instance's own entry: nothing is shared with other instances of the kind
  const saved = st.edit.devices[instanceId]?.mapping ?? {};
  const options = st.edit.devices[instanceId]?.options;
  const selfTimed = isSelfTimed(device);
  const headId = `toysync-tab-${domId(instanceId)}-h`;

  const set = (ch: string, patch: Partial<ChannelMapping>) => rt.sceneMaps.setChannel(instanceId, ch, { ...eff[ch], ...patch } as ChannelMapping);
  const test = (ch: string) => {
    if (typeof device.testChannel === "function") device.testChannel(ch);
    else device.test();
  };

  return (
    <section className="toysync-tab-device" aria-labelledby={headId}>
      <div className="toysync-card-head">
        <h3 id={headId} className="toysync-h3">
          {label}
        </h3>
        <span className={`toysync-pill toysync-pill-${status.connection}`}>{connectionText(status)}</span>
        {connected && <OutputMeters output={status.output} name={name} />}
        <span className="toysync-grow" />
        {!busy && (
          <button type="button" className="btn btn-primary btn-sm toysync-btn" onClick={() => void rt.manager.connect(instanceId)}>
            Connect
          </button>
        )}
        {busy && (
          <button type="button" className="btn btn-secondary btn-sm toysync-btn" onClick={() => rt.manager.disconnect(instanceId)}>
            Disconnect
          </button>
        )}
      </div>
      <div className="toysync-muted toysync-small">
        {label !== driverLabel(kind) ? `${driverLabel(kind)} · ` : ""}
        {status.device && status.device !== label ? `${status.device} · ` : ""}
        {DRIVERS.get(kind)?.info.description}
        {selfTimed ? " · times its own output from the video" : ""}
      </div>
      {status.message && (
        <div className={status.connection === "error" ? "toysync-message toysync-error" : "toysync-message"} role="status">
          {status.message}
        </div>
      )}
      {renderDriverComponent(device.preview, { device, program: rt.manager.program(instanceId) }, `${label} preview`)}
      {targets.length === 0 ? (
        <p className="toysync-muted">This device offers no mapping targets.</p>
      ) : (
        <div className="toysync-table-scroll">
          <table className="toysync-table toysync-map-table">
            <thead>
              <tr>
                <th scope="col">Channel</th>
                <th scope="col">Target</th>
                <th scope="col">Invert</th>
                <th scope="col">Min</th>
                <th scope="col">Max</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {channels.map((ch) => {
                const m = eff[ch.id] ?? { target: OFF_TARGET, invert: false, min: 0, max: 100 };
                const off = m.target === OFF_TARGET;
                const base = `toysync-${domId(instanceId)}-${domId(ch.id)}`;
                const custom = saved[ch.id] !== undefined;
                const known = off || targets.some((t) => t.id === m.target);
                return (
                  <tr key={ch.id} className={off ? "toysync-row-off" : undefined}>
                    <th scope="row">
                      {channelLabel(ch.id)}
                      {custom && <span className="toysync-badge">custom</span>}
                    </th>
                    <td>
                      <select
                        id={`${base}-target`}
                        aria-label={`${label}: target for ${ch.id}`}
                        className="form-control form-control-sm toysync-select"
                        value={m.target}
                        onChange={(e) => set(ch.id, { target: e.target.value })}
                      >
                        <option value={OFF_TARGET}>Off</option>
                        {!known && <option value={m.target}>{targetLabel(m.target, targets)}</option>}
                        {groups.map((g) =>
                          g.label ? (
                            <optgroup key={g.label} label={g.label}>
                              {g.targets.map((t) => (
                                <option key={t.id} value={t.id}>
                                  {t.label}
                                </option>
                              ))}
                            </optgroup>
                          ) : (
                            g.targets.map((t) => (
                              <option key={t.id} value={t.id}>
                                {t.label}
                              </option>
                            ))
                          ),
                        )}
                      </select>
                    </td>
                    <td>
                      <input
                        id={`${base}-invert`}
                        type="checkbox"
                        aria-label={`${label}: invert ${ch.id}`}
                        checked={m.invert === true}
                        onChange={(e) => set(ch.id, { invert: e.target.checked })}
                      />
                    </td>
                    <td>
                      <PercentInput id={`${base}-min`} label={`${label}: ${ch.id} minimum`} value={m.min ?? 0} onChange={(v) => set(ch.id, { min: v })} />
                    </td>
                    <td>
                      <PercentInput id={`${base}-max`} label={`${label}: ${ch.id} maximum`} value={m.max ?? 100} onChange={(v) => set(ch.id, { max: v })} />
                    </td>
                    <td className="toysync-nowrap">
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm toysync-btn"
                        disabled={!connected || off}
                        title={typeof device.testChannel === "function" ? "Run this channel's target through its range" : "A short test pulse"}
                        onClick={() => test(ch.id)}
                      >
                        Test
                      </button>
                      {custom && (
                        <button
                          type="button"
                          className="btn btn-link btn-sm toysync-btn"
                          aria-label={`${label}: ${ch.id} back to the default`}
                          onClick={() => rt.sceneMaps.setChannel(instanceId, ch.id, undefined)}
                        >
                          Default
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {kind !== "lovense" && !selfTimed && eff && Object.values(eff).some((m) => m.target === "auto") && (
        <p className="toysync-muted toysync-small">
          “Auto” drives intensity, balance and pulse frequency from that channel's motion, each only while no other
          channel is mapped to it.
        </p>
      )}
      {options && Object.keys(options).length > 0 && (
        <dl className="toysync-settings">
          {Object.entries(options).map(([k, v]) => (
            <div key={k} className="toysync-settings-row">
              <dt>{k}</dt>
              <dd>{optionText(v)}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

function SaveBar(props: { rt: Runtime; st: SceneMapState }) {
  const { Link } = pluginApi().libraries.ReactRouterDOM;
  const { rt, st } = props;
  const empty = isEmptySceneMap(compactSceneMap(st.edit));
  return (
    <div className="toysync-save">
      <div className="toysync-row">
        <button type="button" className="btn btn-primary btn-sm toysync-btn" disabled={!st.canSave || st.saving} onClick={() => void rt.sceneMaps.save()}>
          {st.saving ? "Saving…" : "Save to scene"}
        </button>
        <button type="button" className="btn btn-secondary btn-sm toysync-btn" disabled={!st.dirty || st.saving} onClick={() => rt.sceneMaps.revert()}>
          Revert
        </button>
        <button type="button" className="btn btn-secondary btn-sm toysync-btn" disabled={empty || st.saving} onClick={() => rt.sceneMaps.useDefaults()}>
          Use defaults
        </button>
        <Link to={DEVICES_ROUTE} className="btn btn-link btn-sm toysync-btn">
          Devices
        </Link>
      </div>
      <div className="toysync-muted toysync-small" role="status">
        {sourceText(st.source, st.dirty)}
      </div>
      {st.error && (
        <div className="toysync-message toysync-error" role="alert">
          Saving failed: {st.error}
        </div>
      )}
    </div>
  );
}
