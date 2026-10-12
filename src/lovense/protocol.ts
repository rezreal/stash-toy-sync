// The Lovense Bluetooth LE protocol as far as this plugin needs it: which
// devices and services to ask the browser for, which characteristics carry
// commands (TX) and replies (RX), and the ASCII commands and replies.
// Pure and DOM-free.
//
// Protocol summary (community documentation, e.g. the buttplug.io device
// notes; Lovense doesn't publish the BLE protocol):
// - Toys advertise as "LVS-<model><n>" (newer) or "LOVE-<n>" (older).
// - Each model family has its own 128-bit service UUID of the form
//   XX300001-002Y-4bd4-bbd5-a6920e4c5653, with TX = XX300002-... and
//   RX = XX300003-...; old toys use 0000fff0 (TX fff2, RX fff1), some use the
//   Nordic UART service 6e400001 (TX 6e400002, RX 6e400003).
// - Commands are ASCII strings ending in ";" written to TX; replies arrive as
//   notifications on RX ("OK;" after a command).
import type { BluetoothCharacteristicProperties, RequestDeviceOptions } from "./bluetooth.d.ts";

export const LOVENSE_NAME_PREFIXES: readonly string[] = ["LVS-", "LOVE-"];

const LOVENSE_UUID_SUFFIX = "-4bd4-bbd5-a6920e4c5653";
export const FFF0_SERVICE = "0000fff0-0000-1000-8000-00805f9b34fb";
export const NORDIC_UART_SERVICE = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";

/**
 * Every service UUID a Lovense toy may use. Web Bluetooth only exposes the
 * services named in requestDevice()'s optionalServices, so all candidates
 * are listed: XX300001-002Y-4bd4-bbd5-a6920e4c5653 for XX = 40..5f, Y = 3, 4,
 * plus the old fff0 service and Nordic UART.
 */
export function lovenseServices(): string[] {
  const out: string[] = [];
  for (let xx = 0x40; xx <= 0x5f; xx++) {
    const hex = xx.toString(16).padStart(2, "0");
    for (const y of [3, 4]) out.push(`${hex}300001-002${y}${LOVENSE_UUID_SUFFIX}`);
  }
  out.push(FFF0_SERVICE, NORDIC_UART_SERVICE);
  return out;
}

export const LOVENSE_SERVICES: readonly string[] = lovenseServices();

/** requestDevice() options: the Lovense name prefixes (plus an optional custom one) and every Lovense service. */
export function requestOptions(extraPrefix?: string): RequestDeviceOptions {
  const prefixes = [...LOVENSE_NAME_PREFIXES];
  const extra = extraPrefix?.trim();
  if (extra && !prefixes.includes(extra)) prefixes.push(extra);
  return {
    filters: prefixes.map((namePrefix) => ({ namePrefix })),
    optionalServices: [...LOVENSE_SERVICES],
  };
}

/** The device name looks like a Lovense toy (or matches the custom prefix). */
export function isLovenseName(name: string | null | undefined, extraPrefix?: string): boolean {
  if (!name) return false;
  const extra = extraPrefix?.trim();
  return LOVENSE_NAME_PREFIXES.some((p) => name.startsWith(p)) || (!!extra && name.startsWith(extra));
}

// --- TX / RX selection ----------------------------------------------------------------

export interface CharacteristicLike {
  readonly uuid: string;
  readonly properties: BluetoothCharacteristicProperties;
}

const LOVENSE_SERVICE_RE = /^([0-9a-f]{4})0001(-002[0-9a-f]-4bd4-bbd5-a6920e4c5653)$/;

/** The TX / RX uuids the naming pattern predicts for a service, if it follows one. */
export function expectedChannels(serviceUuid: string): { tx: string; rx: string } | undefined {
  const s = serviceUuid.toLowerCase();
  const m = LOVENSE_SERVICE_RE.exec(s);
  if (m) return { tx: `${m[1]}0002${m[2]}`, rx: `${m[1]}0003${m[2]}` };
  if (s === FFF0_SERVICE) {
    return { tx: "0000fff2-0000-1000-8000-00805f9b34fb", rx: "0000fff1-0000-1000-8000-00805f9b34fb" };
  }
  if (s === NORDIC_UART_SERVICE) {
    return { tx: "6e400002-b5a3-f393-e0a9-e50e24dcca9e", rx: "6e400003-b5a3-f393-e0a9-e50e24dcca9e" };
  }
  return undefined;
}

export const isWritable = (c: CharacteristicLike): boolean => c.properties.write || c.properties.writeWithoutResponse;
export const isNotifying = (c: CharacteristicLike): boolean => c.properties.notify || c.properties.indicate;

/**
 * TX (writable) and RX (notifying) characteristics of a service: the ones the
 * naming pattern predicts when they have the right properties, else the
 * first writable / the first notifying one. Undefined when nothing is
 * writable. RX is optional (replies are a nice-to-have).
 */
export function pickChannels<C extends CharacteristicLike>(serviceUuid: string, chars: readonly C[]): { tx: C; rx?: C } | undefined {
  const want = expectedChannels(serviceUuid);
  const byUuid = (u: string | undefined) => (u ? chars.find((c) => c.uuid.toLowerCase() === u) : undefined);
  const namedTx = byUuid(want?.tx);
  const tx = namedTx && isWritable(namedTx) ? namedTx : chars.find(isWritable);
  if (!tx) return undefined;
  const namedRx = byUuid(want?.rx);
  const rx = namedRx && isNotifying(namedRx) ? namedRx : (chars.find((c) => c !== tx && isNotifying(c)) ?? chars.find(isNotifying));
  return rx ? { tx, rx } : { tx };
}

// --- commands ---------------------------------------------------------------------------

export const MAX_LEVEL = 20;

/** an integer level in 0..20 */
export function clampLevel(level: number): number {
  if (!Number.isFinite(level)) return 0;
  const r = Math.round(level);
  return r < 0 ? 0 : r > MAX_LEVEL ? MAX_LEVEL : r;
}

/** "Vibrate:N;" for all motors, N clamped to 0..20 */
export function vibrateCommand(level: number): string {
  return `Vibrate:${clampLevel(level)};`;
}

export const DEVICE_TYPE_COMMAND = "DeviceType;";
export const BATTERY_COMMAND = "Battery;";

/** ASCII bytes of a command, with the terminating ";" added when missing */
export function encodeCommand(cmd: string): Uint8Array<ArrayBuffer> {
  const s = cmd.endsWith(";") ? cmd : cmd + ";";
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out[i] = c < 128 ? c : 0x3f; // "?" for anything non-ASCII
  }
  return out;
}

/** text of a notification (ASCII; stops at a NUL byte) */
export function decodeText(dv: DataView): string {
  let s = "";
  for (let i = 0; i < dv.byteLength; i++) {
    const b = dv.getUint8(i);
    if (b === 0) break;
    s += String.fromCharCode(b);
  }
  return s;
}

/**
 * Splits buffered reply text into complete replies (without the ";") and the
 * unfinished rest. A reply may arrive split over notifications, or several
 * in one.
 */
export function splitReplies(buffer: string): { replies: string[]; rest: string } {
  const parts = buffer.split(";");
  const rest = parts.pop() ?? "";
  const replies = parts.map((p) => p.trim()).filter((p) => p.length > 0);
  // a runaway rest without any ";" is noise: don't let it grow forever
  return { replies, rest: rest.length > 256 ? "" : rest };
}

export type Reply =
  | { kind: "ok" }
  | { kind: "error"; text: string }
  | { kind: "battery"; percent: number }
  | { kind: "deviceType"; model: string; firmware?: string; address?: string }
  | { kind: "unknown"; text: string };

/**
 * One reply (without ";"):
 * - "OK" -> ok; "ERR" (or starting with it) -> error
 * - "85" -> battery 85 %. Some toys prefix an "s" ("s85"); accepted.
 * - "Z:11:0082059AD3BD" -> device type: model letter(s), firmware, address
 */
export function parseReply(text: string): Reply {
  const t = text.trim().replace(/;$/, "");
  if (/^ok$/i.test(t)) return { kind: "ok" };
  if (/^err/i.test(t)) return { kind: "error", text: t };
  const bat = /^s?(\d{1,3})$/i.exec(t);
  if (bat) {
    const n = Number(bat[1]);
    if (n >= 0 && n <= 100) return { kind: "battery", percent: n };
  }
  const dt = /^([A-Za-z]{1,3}):([^:]*)(?::([0-9A-Fa-f]{6,16}))?(?::.*)?$/.exec(t);
  if (dt) {
    const out: Reply = { kind: "deviceType", model: dt[1]!.toUpperCase() };
    if (dt[2]) out.firmware = dt[2];
    if (dt[3]) out.address = dt[3].toUpperCase();
    return out;
  }
  return { kind: "unknown", text: t };
}

/**
 * Friendly names for model letters that are well documented. Deliberately
 * small: an unknown letter is shown as is rather than guessed.
 */
const MODEL_NAMES: Record<string, string> = {
  S: "Lush",
  Z: "Hush",
  P: "Edge",
  W: "Domi",
  A: "Nora",
  C: "Nora",
  B: "Max",
  O: "Osci",
  L: "Ambi",
  ED: "Gush",
};

/** "Lush" for "S"; the letter itself when unknown */
export function modelName(letter: string): string {
  const k = letter.trim().toUpperCase();
  return MODEL_NAMES[k] ?? k;
}
