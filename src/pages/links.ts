// The plugin's pages and their URLs. The URL is the state: what the
// calibration page shows (device, channel, step) lives in the query string,
// so back, forward and reload work.
//
//   /toysync                                         devices & mapping
//   /toysync/calibrate?device=coyote-v3&channel=a&step=1   calibration wizard
//   /toysync/calibrate?device=coyote-v3:2&channel=b&step=review
//
// `device` is a device instance id (src/devices/instances.ts); the first
// instance of a kind has the kind as its id, so links from before instances
// (device=<kind>) still open the same device.
//
// Not under /plugin: stash's server owns /plugin (plugin files) and answers
// anything else below it with a 404, so such a page breaks on reload.
// Pure, tested under node --test.
export const DEVICES_ROUTE = "/toysync";
export const CALIBRATE_ROUTE = "/toysync/calibrate";

export type Channel = "a" | "b";
export type WizardStep = 1 | 2 | 3 | 4 | "review";
export const WIZARD_STEPS: readonly WizardStep[] = [1, 2, 3, 4, "review"];

export interface CalibrateLink {
  /** the device instance id */
  device: string;
  channel: Channel;
  step: WizardStep;
}

/** what the query string says, unchecked */
export interface CalibrateQuery {
  device?: string;
  channel?: string;
  step?: string;
}

/** a calibratable device instance the page could show */
export interface CalibrateChoice {
  instanceId: string;
  channels: readonly Channel[];
  connected: boolean;
}

export function parseCalibrateQuery(search: string): CalibrateQuery {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const q: CalibrateQuery = {};
  for (const key of ["device", "channel", "step"] as const) {
    const v = params.get(key)?.trim();
    if (v) q[key] = v;
  }
  return q;
}

function parseStep(raw: string | undefined): WizardStep | undefined {
  if (raw === "review") return "review";
  if (raw === "1" || raw === "2" || raw === "3" || raw === "4") return Number(raw) as 1 | 2 | 3 | 4;
  return undefined;
}

/**
 * The view for a query: the named device when it is one of the choices
 * (connected or not: the page then offers to connect it), else the first
 * connected choice; its channel when valid, else its first; the step when
 * valid, else 1. undefined when no device is named and none is connected.
 */
export function resolveCalibrateLink(q: CalibrateQuery, choices: readonly CalibrateChoice[]): CalibrateLink | undefined {
  const named = choices.find((c) => c.instanceId === q.device);
  const choice = named ?? choices.find((c) => c.connected);
  if (!choice || choice.channels.length === 0) return undefined;
  const channel = choice.channels.find((c) => c === q.channel) ?? choice.channels[0]!;
  return { device: choice.instanceId, channel, step: parseStep(q.step) ?? 1 };
}

// ":" is fine in a query string; keeping it readable keeps "coyote-v3:2" recognisable in the address bar
const queryValue = (v: string) => encodeURIComponent(v).replace(/%3A/gi, ":");

/** the query string of a view, in a fixed order */
export function calibrateSearch(link: CalibrateLink): string {
  return `?device=${queryValue(link.device)}&channel=${queryValue(link.channel)}&step=${queryValue(String(link.step))}`;
}

export function calibrateHref(link: CalibrateLink): string {
  return CALIBRATE_ROUTE + calibrateSearch(link);
}

/** the first calibration step of a device instance's channel (A by default) */
export function calibrateStartHref(device: string, channel: Channel = "a"): string {
  return calibrateHref({ device, channel, step: 1 });
}

/** the given search, as calibrateSearch would write it, when it already says exactly `link` */
export function isCanonical(search: string, link: CalibrateLink): boolean {
  const s = search.startsWith("?") ? search : `?${search}`;
  return s === calibrateSearch(link);
}

/** the step after / before, or undefined at the ends */
export function nextStep(step: WizardStep): WizardStep | undefined {
  const i = WIZARD_STEPS.indexOf(step);
  return i >= 0 && i < WIZARD_STEPS.length - 1 ? WIZARD_STEPS[i + 1] : undefined;
}

export function prevStep(step: WizardStep): WizardStep | undefined {
  const i = WIZARD_STEPS.indexOf(step);
  return i > 0 ? WIZARD_STEPS[i - 1] : undefined;
}

/** which page a router pathname is ("" outside the plugin) */
export function pageFor(pathname: string): "devices" | "calibrate" | "" {
  const p = pathname.replace(/\/+$/, "") || "/";
  if (p === DEVICES_ROUTE) return "devices";
  if (p === CALIBRATE_ROUTE) return "calibrate";
  return "";
}
