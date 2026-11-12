// DG-LAB Coyote 2.0 driver (kind "coyote-v2"): the transport over the
// strength / waveform characteristics (protocol-v2.ts) and its factory.
//
// - Levels 0..200 map to raw strength via the device's max power (1507).
// - The strength is written only when it changes (the device keeps it);
//   each channel's waveform every packet (one is good for 100 ms). A
//   packet has no 25 ms slots here, so a channel counts as on when at least
//   half of the plan's slots are.
// - After every (re)connect the first packet writes strength 0.
// - Strength notifications that are lower than what was written (and not an
//   echo of a recent write) are the wheel turned down: that becomes the
//   channel's ceiling until reconnect.
import type { DriverContext } from "../devices/registry.ts";
import type {
  BluetoothDevice,
  BluetoothRemoteGATTCharacteristic,
  BluetoothRemoteGATTServer,
} from "../lovense/bluetooth.d.ts";
import type { Channel } from "./ack.ts";
import { createCoyoteDevice, wheelMessage, type CoyoteDevice, type CoyoteDeviceOptions, type CoyoteTransport } from "./device.ts";
import { bytesOf, errName, LinkFailure, MSG_PICK_AGAIN, type LinkIo } from "./link.ts";
import type { ChannelPlan, Plan } from "./plan.ts";
import {
  DEFAULT_MAX_POWER,
  decodeStrength,
  encodeStrength,
  encodeWave,
  LEVEL_MAX,
  levelToRaw,
  parseBattery,
  parseMaxPower,
  rawToLevelFloor,
  SILENT_WAVE,
  V2_BATTERY,
  V2_BATTERY_SERVICE,
  V2_CONFIG,
  V2_NAME_PREFIX,
  V2_SERVICE,
  V2_STRENGTH,
  V2_WAVE_A,
  V2_WAVE_B,
  waveForPeriod,
  Z_SHARP,
  Z_SOFT,
  type V2Wave,
} from "./protocol-v2.ts";

export const V2_LABEL = "Coyote 2.0";

export const MSG_V2_NOT_CHOSEN =
  "No Coyote 2.0 chosen. Turn it on, close the DG-LAB app (a Coyote connected to the app is invisible to the browser) " +
  "and pick “D-LAB ESTIM01” from the browser's Bluetooth list.";
export const MSG_V2_WRONG_DEVICE =
  "This device has no Coyote 2.0 service. Is it a Coyote 2.0? For a Coyote 3.0 (“47L121000”) use the Coyote 3.0 driver.";

/** a strength notification that matches a write this recent is our own echo */
export const ECHO_WINDOW_MS = 1000;

/** the waveform for one channel at `target` (silent when off or under half the slots on) */
export function v2Wave(ch: ChannelPlan, target: number): V2Wave {
  if (target <= 0) return SILENT_WAVE;
  const onSlots = ch.slots.filter((s) => s > 0).length;
  if (onSlots * 2 < ch.slots.length) return SILENT_WAVE;
  return waveForPeriod(ch.periodMs, ch.sharp ? Z_SHARP : Z_SOFT);
}

export interface V2Transport extends CoyoteTransport {
  readonly kind: "coyote-v2";
  /** the max power in use (from 1507, else 1400) */
  maxPower(): number;
}

export interface V2TransportOptions {
  now?: () => number;
}

export function createV2Transport(opts: V2TransportOptions = {}): V2Transport {
  const clock = opts.now ?? (() => Date.now());
  let io: LinkIo | undefined;
  let strengthCh: BluetoothRemoteGATTCharacteristic | undefined;
  let waveA: BluetoothRemoteGATTCharacteristic | undefined;
  let waveB: BluetoothRemoteGATTCharacteristic | undefined;
  let maxPower = DEFAULT_MAX_POWER;
  /** the raw strength last written (undefined = unknown, write next packet) */
  let written: { a: number; b: number } | undefined;
  let confirmed = false;
  let recent: { a: number; b: number; at: number }[] = [];
  let ceil = { a: LEVEL_MAX, b: LEVEL_MAX };
  let turned = new Set<Channel>();
  let hello = true;
  let listener: () => void = () => undefined;

  const onStrength = (): void => {
    const s = decodeStrength(bytesOf(strengthCh?.value));
    if (!s || !written) return;
    const t = clock();
    recent = recent.filter((r) => t - r.at <= ECHO_WINDOW_MS);
    let changed = false;
    for (const c of ["a", "b"] as const) {
      const v = s[c];
      if (v >= written[c] || recent.some((r) => r[c] === v)) continue;
      const level = rawToLevelFloor(v, maxPower);
      if (level < ceil[c]) {
        ceil = { ...ceil, [c]: level };
        turned.add(c);
        changed = true;
      }
      written = { ...written, [c]: v };
    }
    if (changed) listener();
  };

  function writeStrength(rawA: number, rawB: number, front = false): Promise<void> {
    if (!io || !strengthCh) return Promise.resolve();
    const w = { a: rawA, b: rawB };
    written = w;
    confirmed = false;
    recent.push({ ...w, at: clock() });
    return io.write(strengthCh, encodeStrength(rawA, rawB), front).then(
      () => {
        if (written === w) confirmed = true;
      },
      (e: unknown) => {
        if (written === w) written = undefined; // unknown again: rewrite next packet
        throw e;
      },
    );
  }

  return {
    kind: "coyote-v2",
    label: V2_LABEL,
    requestOptions: () => ({
      filters: [{ namePrefix: V2_NAME_PREFIX }],
      optionalServices: [V2_SERVICE, V2_BATTERY_SERVICE],
    }),
    isOwnName: (name) => !!name && name.startsWith(V2_NAME_PREFIX),
    batteryService: V2_BATTERY_SERVICE,
    batteryCharacteristic: V2_BATTERY,
    parseBattery,
    notChosenMessage: MSG_V2_NOT_CHOSEN,
    async open(server: BluetoothRemoteGATTServer, _device: BluetoothDevice, linkIo: LinkIo) {
      let svc;
      try {
        svc = await server.getPrimaryService(V2_SERVICE);
      } catch (e) {
        const n = errName(e);
        if (n === "SecurityError") throw new LinkFailure(MSG_PICK_AGAIN, { repick: true });
        if (n === "NotFoundError") throw new LinkFailure(MSG_V2_WRONG_DEVICE);
        throw e;
      }
      let s: BluetoothRemoteGATTCharacteristic;
      let a: BluetoothRemoteGATTCharacteristic;
      let b: BluetoothRemoteGATTCharacteristic;
      try {
        s = await svc.getCharacteristic(V2_STRENGTH);
        a = await svc.getCharacteristic(V2_WAVE_A);
        b = await svc.getCharacteristic(V2_WAVE_B);
      } catch (e) {
        if (errName(e) === "NotFoundError") throw new LinkFailure(MSG_V2_WRONG_DEVICE);
        throw e;
      }
      maxPower = DEFAULT_MAX_POWER;
      try {
        const cfg = await svc.getCharacteristic(V2_CONFIG);
        if (cfg.properties.read) maxPower = parseMaxPower(bytesOf(await cfg.readValue()));
      } catch {
        // undocumented characteristic: keep the conservative default
      }
      if (s.properties.notify) {
        s.addEventListener("characteristicvaluechanged", onStrength);
        try {
          await s.startNotifications();
        } catch {
          s.removeEventListener("characteristicvaluechanged", onStrength);
        }
      }
      io = linkIo;
      strengthCh = s;
      waveA = a;
      waveB = b;
      written = undefined;
      confirmed = false;
      recent = [];
      ceil = { a: LEVEL_MAX, b: LEVEL_MAX };
      turned = new Set();
      hello = true;
    },
    detach() {
      strengthCh?.removeEventListener("characteristicvaluechanged", onStrength);
      io = undefined;
      strengthCh = undefined;
      waveA = undefined;
      waveB = undefined;
      confirmed = false;
    },
    tick(plan: Plan, _now: number) {
      if (!io || !strengthCh || !waveA || !waveB || io.busy()) return false;
      let ta = 0;
      let tb = 0;
      if (hello) hello = false;
      else {
        ta = Math.min(plan.a.level, ceil.a);
        tb = Math.min(plan.b.level, ceil.b);
      }
      const rawA = levelToRaw(ta, maxPower);
      const rawB = levelToRaw(tb, maxPower);
      if (!written || written.a !== rawA || written.b !== rawB) writeStrength(rawA, rawB).catch(() => undefined);
      io.write(waveA, encodeWave(ta > 0 ? v2Wave(plan.a, ta) : SILENT_WAVE)).catch(() => undefined);
      io.write(waveB, encodeWave(tb > 0 ? v2Wave(plan.b, tb) : SILENT_WAVE)).catch(() => undefined);
      return true;
    },
    zero() {
      if (!io || !strengthCh || !waveA || !waveB) return Promise.resolve();
      const s = writeStrength(0, 0, true);
      const a = io.write(waveA, encodeWave(SILENT_WAVE), true);
      const b = io.write(waveB, encodeWave(SILENT_WAVE), true);
      return Promise.all([s, a, b]).then(() => undefined);
    },
    settled: () => !!written && written.a === 0 && written.b === 0 && confirmed,
    ceilings: () => ({ ...ceil }),
    message: () => wheelMessage(ceil, turned),
    setListener(cb) {
      listener = cb;
    },
    maxPower: () => maxPower,
  };
}

export function createCoyoteV2(ctx: DriverContext, opts: CoyoteDeviceOptions = {}): CoyoteDevice {
  return createCoyoteDevice(ctx, createV2Transport({ now: ctx.now }), opts);
}
