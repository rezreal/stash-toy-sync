// The device instances of this browser: which devices of each kind the user
// has (two Coyotes, two Lovense vibrators, …), their ids and nicknames. Kept
// per browser, because the hardware is per machine: localStorage
// "toysync.instances", a JSON array of { instanceId, kind, name }. Pure apart
// from the injectable storage.
//
// - The first instance of a kind has the kind as its id ("coyote-v3"), so
//   scene mappings, calibration links and remembered devices from before
//   instances keep working. Further ones are "<kind>:2", "<kind>:3", … (the
//   lowest free ordinal). Scene mappings and URLs use these ids, so they are
//   portable between browsers.
// - name: the user's nickname; by default the driver's label for the first
//   ("DG-LAB Coyote 3.0") and "<label> 2", "<label> 3", … for the others.
// - Every registered kind always has its first instance (the default list is
//   one instance per registered kind: the behaviour from before instances).
//   Entries of kinds this build doesn't register are kept as they are.
import type { StorageLike } from "./calibration.ts";
import type { DeviceKind } from "./types.ts";

export const INSTANCES_KEY = "toysync.instances";
/** nicknames are cut to this many characters */
export const MAX_NAME_LENGTH = 60;
/** a sanity bound for ordinals read from storage */
export const MAX_ORDINAL = 99;

export interface DeviceInstance {
  /** "coyote-v3" for the first of a kind, "coyote-v3:2" … for the others */
  instanceId: string;
  kind: DeviceKind;
  /** the user's nickname */
  name: string;
}

/** what a driver learns about the instance it drives (see DriverContext) */
export interface InstanceInfo {
  readonly id: string;
  /** the instance's current nickname (follows renames) */
  readonly name: string;
  /** 1 for the first instance of a kind, 2, 3, … for the others */
  readonly ordinal: number;
}

/** the id of a kind's n-th instance: the kind itself for the first */
export function instanceIdFor(kind: string, ordinal: number): string {
  return ordinal <= 1 ? kind : `${kind}:${ordinal}`;
}

/** kind and ordinal of an instance id; undefined when it isn't one ("x:1", "x:0", "x:abc", "") */
export function parseInstanceId(id: string): { kind: string; ordinal: number } | undefined {
  if (typeof id !== "string") return undefined;
  const m = /^([a-z0-9][a-z0-9-]*)(?::([1-9]\d*))?$/.exec(id);
  if (!m) return undefined;
  if (m[2] === undefined) return { kind: m[1]!, ordinal: 1 };
  const ordinal = Number(m[2]);
  // the first instance is always written without a suffix
  if (ordinal < 2 || ordinal > MAX_ORDINAL) return undefined;
  return { kind: m[1]!, ordinal };
}

/** the kind part of an instance id (the id itself when it has no ordinal) */
export function kindOfInstance(id: string): string {
  return parseInstanceId(id)?.kind ?? id;
}

/** 1 for a first instance (or anything unparseable), else its ordinal */
export function ordinalOf(id: string): number {
  return parseInstanceId(id)?.ordinal ?? 1;
}

/** "DG-LAB Coyote 3.0", "DG-LAB Coyote 3.0 2", … */
export function defaultInstanceName(label: string, ordinal: number): string {
  return ordinal <= 1 ? label : `${label} ${ordinal}`;
}

/** a usable nickname: trimmed, whitespace collapsed, at most MAX_NAME_LENGTH; undefined when empty */
export function cleanName(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const s = raw.replace(/\s+/g, " ").trim().slice(0, MAX_NAME_LENGTH).trim();
  return s || undefined;
}

/** the id of the next instance of a kind: the lowest free ordinal (1 = the kind itself) */
export function nextInstanceId(list: readonly DeviceInstance[], kind: string): string | undefined {
  const used = new Set(list.filter((i) => i.kind === kind).map((i) => ordinalOf(i.instanceId)));
  for (let n = 1; n <= MAX_ORDINAL; n++) if (!used.has(n)) return instanceIdFor(kind, n);
  return undefined;
}

/** instances grouped by kind (in `kinds` order, unknown kinds last), then by ordinal */
export function sortInstances(list: readonly DeviceInstance[], kinds: readonly string[]): DeviceInstance[] {
  const rank = (k: string) => {
    const i = kinds.indexOf(k);
    return i < 0 ? kinds.length : i;
  };
  return [...list].sort(
    (x, y) => rank(x.kind) - rank(y.kind) || (x.kind < y.kind ? -1 : x.kind > y.kind ? 1 : 0) || ordinalOf(x.instanceId) - ordinalOf(y.instanceId),
  );
}

/**
 * A stored list, leniently: entries with a valid id (and a kind matching it)
 * once each, a default name where the name is missing; plus the first
 * instance of every kind in `kinds` that is missing. Sorted.
 */
export function normalizeInstances(raw: unknown, kinds: readonly DeviceKind[], labelOf: (kind: DeviceKind) => string): DeviceInstance[] {
  const out: DeviceInstance[] = [];
  const seen = new Set<string>();
  if (Array.isArray(raw)) {
    for (const e of raw) {
      if (!e || typeof e !== "object") continue;
      const o = e as Record<string, unknown>;
      const id = typeof o.instanceId === "string" ? o.instanceId.trim() : "";
      const parsed = parseInstanceId(id);
      if (!parsed || seen.has(id)) continue;
      if (o.kind !== undefined && o.kind !== parsed.kind) continue;
      const kind = parsed.kind as DeviceKind;
      seen.add(id);
      out.push({ instanceId: id, kind, name: cleanName(o.name) ?? defaultInstanceName(labelOf(kind), parsed.ordinal) });
    }
  }
  for (const kind of kinds) {
    if (!seen.has(kind)) {
      seen.add(kind);
      out.push({ instanceId: kind, kind, name: labelOf(kind) });
    }
  }
  return sortInstances(out, kinds);
}

function defaultStorage(): StorageLike | undefined {
  try {
    return globalThis.localStorage ?? undefined;
  } catch {
    return undefined;
  }
}

/** the stored instance list (normalized; the default list when nothing or garbage is stored) */
export function loadInstances(
  kinds: readonly DeviceKind[],
  labelOf: (kind: DeviceKind) => string,
  storage: StorageLike | undefined = defaultStorage(),
): DeviceInstance[] {
  let raw: unknown;
  try {
    const s = storage?.getItem(INSTANCES_KEY);
    raw = s ? JSON.parse(s) : undefined;
  } catch {
    raw = undefined;
  }
  return normalizeInstances(raw, kinds, labelOf);
}

/** stores the list; false when storage failed (the list then lives until the page reloads) */
export function saveInstances(list: readonly DeviceInstance[], storage: StorageLike | undefined = defaultStorage()): boolean {
  try {
    if (!storage) return false;
    storage.setItem(INSTANCES_KEY, JSON.stringify(list.map((i) => ({ instanceId: i.instanceId, kind: i.kind, name: i.name }))));
    return true;
  } catch {
    return false;
  }
}

/**
 * Where an instance's driver keeps something per instance in localStorage
 * (e.g. the remembered Bluetooth device): the first instance uses the key as
 * it always was, so nothing is forgotten on upgrade; the others append their
 * id ("toysync.coyote-v3.device.coyote-v3:2").
 */
export function instanceStorageKey(base: string, instance: Pick<InstanceInfo, "id" | "ordinal"> | undefined): string {
  return !instance || instance.ordinal <= 1 ? base : `${base}.${instance.id}`;
}

/** the instance a driver was made for; the first instance of `kind` when the context has none (tests, old callers) */
export function instanceInfoOf(ctx: { instance?: InstanceInfo } | undefined, kind: string, label: string = kind): InstanceInfo {
  return ctx?.instance ?? { id: kind, name: label, ordinal: 1 };
}
