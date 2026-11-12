// DG-LAB Coyote 3.0 driver (kind "coyote-v3"): the transport over the
// B0 / BF / B1 protocol (protocol-v3.ts) and its factory.
//
// - After every (re)connect: BF with the soft limits (calibrated hardMax per
//   channel, 200 uncalibrated or while that channel is probed), then a B0
//   that sets both strengths to 0 absolutely.
// - Every packet carries 4 × 25 ms of waveform per channel. Strength
//   changes go out absolutely under a sequence number and wait for the B1
//   answer (ack.ts). While the device may still be above the wanted level,
//   the waveform intensity is scaled down so the output never overshoots.
// - A wheel turned down on the device becomes that channel's ceiling until
//   reconnect, and the status says so.
import type { DriverContext } from "../devices/registry.ts";
import type {
  BluetoothDevice,
  BluetoothRemoteGATTCharacteristic,
  BluetoothRemoteGATTServer,
} from "../lovense/bluetooth.d.ts";
import { createStrengthTracker, type Channel } from "./ack.ts";
import { createCoyoteDevice, wheelMessage, type CoyoteDevice, type CoyoteDeviceOptions, type CoyoteTransport } from "./device.ts";
import { bytesOf, errName, LinkFailure, MSG_PICK_AGAIN, type LinkIo } from "./link.ts";
import type { ChannelPlan, Plan } from "./plan.ts";
import {
  encodeB0,
  encodeBF,
  frequencyByte,
  isDfuName,
  parseBattery,
  parseNotify,
  SILENT_V3_WAVE,
  V3_BATTERY,
  V3_BATTERY_SERVICE,
  V3_NAME_PREFIX,
  V3_NOTIFY,
  V3_SERVICE,
  V3_WRITE,
  type V3Wave,
} from "./protocol-v3.ts";

export const V3_LABEL = "Coyote 3.0";

export const MSG_V3_NOT_CHOSEN =
  "No Coyote 3.0 chosen. Turn it on, close the DG-LAB app (a Coyote connected to the app is invisible to the browser) " +
  "and pick it from the browser's Bluetooth list (“47L121000”, or unnamed). If the list stays empty, its firmware may " +
  "be in privacy mode, which hides the name: after switching it on, press and hold both wheels to make it visible " +
  "again, then click Connect.";
export const MSG_V3_UPDATE_MODE =
  "This Coyote 3.0 is in firmware update mode (“47L121000_O3”). Finish or cancel the update in the DG-LAB app, " +
  "switch it off and on again, then click Connect.";
export const MSG_V3_WRONG_DEVICE =
  "This device has no Coyote 3.0 pulse service. Is it a Coyote 3.0? For a Coyote 2.0 (“D-LAB ESTIM01”) use the " +
  "Coyote 2.0 driver.";

/** the waveform for one channel at `target` while the device may be at up to `upper` */
export function v3Wave(ch: ChannelPlan, target: number, upper: number): V3Wave {
  if (target <= 0 || !ch.slots.some((s) => s > 0)) return SILENT_V3_WAVE;
  const scale = upper > target ? target / upper : 1;
  const f = frequencyByte(ch.periodMs);
  return { freq: [f, f, f, f], intensity: ch.slots.map((s) => Math.round(s * scale)) };
}

export interface V3Transport extends CoyoteTransport {
  readonly kind: "coyote-v3";
}

export function createV3Transport(): V3Transport {
  const tracker = createStrengthTracker();
  let io: LinkIo | undefined;
  let tx: BluetoothRemoteGATTCharacteristic | undefined;
  let rx: BluetoothRemoteGATTCharacteristic | undefined;
  let limitsSent: { a: number; b: number } | undefined;
  let hello = true;
  let turned = new Set<Channel>();
  let listener: () => void = () => undefined;

  const onNotify = (): void => {
    const n = parseNotify(bytesOf(rx?.value));
    if (!n) return;
    if (n.type === "b1") {
      const down = tracker.onB1(n.seq, n.a, n.b);
      if (down.length > 0) {
        for (const c of down) turned.add(c);
        listener();
      }
    }
    // BE (the soft limits echoed) and unknown headers (0x51, 0x53, …) need nothing
  };

  function send(bytes: Uint8Array<ArrayBuffer>, front = false): Promise<void> {
    if (!io || !tx) return Promise.resolve();
    return io.write(tx, bytes, front);
  }

  return {
    kind: "coyote-v3",
    label: V3_LABEL,
    requestOptions: () => ({
      filters: [{ namePrefix: V3_NAME_PREFIX }, { services: [V3_SERVICE] }],
      optionalServices: [V3_SERVICE, V3_BATTERY_SERVICE],
    }),
    isOwnName: (name) => !!name && name.startsWith(V3_NAME_PREFIX) && !isDfuName(name),
    batteryService: V3_BATTERY_SERVICE,
    batteryCharacteristic: V3_BATTERY,
    parseBattery,
    notChosenMessage: MSG_V3_NOT_CHOSEN,
    async open(server: BluetoothRemoteGATTServer, device: BluetoothDevice, linkIo: LinkIo) {
      if (isDfuName(device.name)) throw new LinkFailure(MSG_V3_UPDATE_MODE);
      let svc;
      try {
        svc = await server.getPrimaryService(V3_SERVICE);
      } catch (e) {
        const n = errName(e);
        if (n === "SecurityError") throw new LinkFailure(MSG_PICK_AGAIN, { repick: true });
        if (n === "NotFoundError") throw new LinkFailure(MSG_V3_WRONG_DEVICE);
        throw e;
      }
      let w: BluetoothRemoteGATTCharacteristic;
      let r: BluetoothRemoteGATTCharacteristic;
      try {
        w = await svc.getCharacteristic(V3_WRITE);
        r = await svc.getCharacteristic(V3_NOTIFY);
      } catch (e) {
        if (errName(e) === "NotFoundError") throw new LinkFailure(MSG_V3_WRONG_DEVICE);
        throw e;
      }
      r.addEventListener("characteristicvaluechanged", onNotify);
      try {
        await r.startNotifications();
      } catch (err) {
        // still usable: changes are retried every 500 ms without answers
        console.warn("[toysync] Coyote 3.0 notifications unavailable", err);
      }
      io = linkIo;
      tx = w;
      rx = r;
      tracker.reset();
      limitsSent = undefined;
      hello = true;
      turned = new Set();
    },
    detach() {
      rx?.removeEventListener("characteristicvaluechanged", onNotify);
      io = undefined;
      tx = undefined;
      rx = undefined;
    },
    tick(plan: Plan, now: number) {
      if (!io || !tx || io.busy()) return false;
      const lim = plan.limits;
      if (!limitsSent || limitsSent.a !== lim.a || limitsSent.b !== lim.b) {
        const sent = { a: lim.a, b: lim.b };
        limitsSent = sent;
        send(encodeBF(lim.a, lim.b)).catch(() => {
          if (limitsSent === sent) limitsSent = undefined; // resend next packet
        });
      }
      if (hello) {
        hello = false;
        const cmd = tracker.zero(now);
        send(encodeB0({ ...cmd, a: SILENT_V3_WAVE, b: SILENT_V3_WAVE })).catch(() => undefined);
        return true;
      }
      const cmd = tracker.next({ a: plan.a.level, b: plan.b.level }, now);
      const ceil = tracker.ceiling();
      const upper = tracker.upperBound();
      const a = v3Wave(plan.a, Math.min(plan.a.level, ceil.a), upper.a);
      const b = v3Wave(plan.b, Math.min(plan.b.level, ceil.b), upper.b);
      send(encodeB0({ ...cmd, a, b })).catch(() => undefined);
      return true;
    },
    zero(now: number) {
      if (!io || !tx) return Promise.resolve();
      const cmd = tracker.zero(now);
      return send(encodeB0({ ...cmd, a: SILENT_V3_WAVE, b: SILENT_V3_WAVE }), true);
    },
    settled: () => tracker.settled(),
    ceilings: () => tracker.ceiling(),
    message: () => wheelMessage(tracker.ceiling(), turned),
    setListener(cb) {
      listener = cb;
    },
  };
}

export function createCoyoteV3(ctx: DriverContext, opts: CoyoteDeviceOptions = {}): CoyoteDevice {
  return createCoyoteDevice(ctx, createV3Transport(), opts);
}
