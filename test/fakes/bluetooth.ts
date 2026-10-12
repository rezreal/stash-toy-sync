// Fake Web Bluetooth objects (no real radio) for the Lovense tests, after
// Skilltree's test/sensors/fakes.ts, plus writable characteristics that
// record the commands and a toy that answers them.
import type {
  Bluetooth,
  BluetoothCharacteristicProperties,
  BluetoothDevice,
  BluetoothRemoteGATTCharacteristic,
  BluetoothRemoteGATTServer,
  BluetoothRemoteGATTService,
  BluetoothServiceUUID,
  RequestDeviceOptions,
} from "../../src/lovense/bluetooth.d.ts";

export class FakeTarget {
  listeners = new Map<string, Set<(e: Event) => void>>();
  addEventListener(type: string, cb: (e: Event) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(cb);
  }
  removeEventListener(type: string, cb: (e: Event) => void): void {
    this.listeners.get(type)?.delete(cb);
  }
  dispatch(type: string): void {
    for (const cb of [...(this.listeners.get(type) ?? [])]) cb({ type } as Event);
  }
  count(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}

export function domError(name: string, message = name): Error {
  const e = new Error(message);
  e.name = name;
  return e;
}

const key = (u: BluetoothServiceUUID): string => String(u).toLowerCase();

export function props(p: Partial<BluetoothCharacteristicProperties> = {}): BluetoothCharacteristicProperties {
  return {
    broadcast: false,
    read: false,
    writeWithoutResponse: false,
    write: false,
    notify: false,
    indicate: false,
    ...p,
  };
}

const text = (b: BufferSource): string => {
  const u =
    b instanceof ArrayBuffer ? new Uint8Array(b) : new Uint8Array(b.buffer as ArrayBuffer, b.byteOffset, b.byteLength);
  return String.fromCharCode(...Array.from(u));
};

export interface WriteRecord {
  cmd: string;
  how: "withoutResponse" | "withResponse" | "writeValue";
  t?: number;
}

export class FakeCharacteristic extends FakeTarget implements BluetoothRemoteGATTCharacteristic {
  value: DataView | null = null;
  notifying = false;
  startError: Error | undefined;
  readonly uuid: string;
  readonly properties: BluetoothCharacteristicProperties;
  writes: WriteRecord[] = [];
  /** writes currently in flight (to prove they never overlap) */
  inFlight = 0;
  maxInFlight = 0;
  /** when set, each write waits for release() */
  manual = false;
  private releases: ((err?: Error) => void)[] = [];
  /** the next writes fail with this */
  writeError: Error | undefined;
  /** called with each written command (e.g. a toy replying) */
  onWrite: ((cmd: string) => void) | undefined;
  clock: { now(): number } | undefined;
  constructor(uuid: string, properties: BluetoothCharacteristicProperties) {
    super();
    this.uuid = key(uuid);
    this.properties = properties;
  }
  async readValue(): Promise<DataView> {
    throw domError("NotSupportedError");
  }
  async startNotifications(): Promise<BluetoothRemoteGATTCharacteristic> {
    if (this.startError) throw this.startError;
    this.notifying = true;
    return this;
  }
  async stopNotifications(): Promise<BluetoothRemoteGATTCharacteristic> {
    this.notifying = false;
    return this;
  }
  private async doWrite(b: BufferSource, how: WriteRecord["how"]): Promise<void> {
    const cmd = text(b);
    this.writes.push({ cmd, how, ...(this.clock ? { t: this.clock.now() } : {}) });
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      if (this.manual) {
        await new Promise<void>((resolve, reject) => this.releases.push((err) => (err ? reject(err) : resolve())));
      }
      if (this.writeError) throw this.writeError;
      this.onWrite?.(cmd);
    } finally {
      this.inFlight--;
    }
  }
  /** finishes the oldest manual write */
  release(err?: Error): void {
    this.releases.shift()?.(err);
  }
  get waiting(): number {
    return this.releases.length;
  }
  writeValueWithoutResponse = (b: BufferSource) => this.doWrite(b, "withoutResponse");
  writeValueWithResponse = (b: BufferSource) => this.doWrite(b, "withResponse");
  writeValue = (b: BufferSource) => this.doWrite(b, "writeValue");
  /** commands only, without the battery / type queries */
  vibrates(): string[] {
    return this.writes.map((w) => w.cmd).filter((c) => c.startsWith("Vibrate:"));
  }
  /** a notification carrying this text */
  notifyText(s: string): void {
    const u = new Uint8Array([...s].map((c) => c.charCodeAt(0)));
    this.value = new DataView(u.buffer);
    this.dispatch("characteristicvaluechanged");
  }
}

export class FakeService implements BluetoothRemoteGATTService {
  readonly uuid: string;
  chars: FakeCharacteristic[];
  constructor(uuid: string, chars: FakeCharacteristic[]) {
    this.uuid = key(uuid);
    this.chars = chars;
  }
  async getCharacteristic(c: BluetoothServiceUUID): Promise<FakeCharacteristic> {
    const hit = this.chars.find((x) => x.uuid === key(c));
    if (!hit) throw domError("NotFoundError", "No Characteristics matching UUID found in Service.");
    return hit;
  }
  async getCharacteristics(): Promise<FakeCharacteristic[]> {
    if (this.chars.length === 0) throw domError("NotFoundError", "No Characteristics found in service.");
    return this.chars;
  }
}

export class FakeServer implements BluetoothRemoteGATTServer {
  connected = false;
  connects = 0;
  connectError: Error | undefined;
  /** services the origin may access (optionalServices); undefined = all */
  allowed: Set<string> | undefined;
  readonly dev: FakeDevice;
  services: FakeService[];
  constructor(dev: FakeDevice, services: FakeService[]) {
    this.dev = dev;
    this.services = services;
  }
  async connect(): Promise<BluetoothRemoteGATTServer> {
    this.connects++;
    if (this.connectError) throw this.connectError;
    this.connected = true;
    return this;
  }
  disconnect(): void {
    if (!this.connected) return;
    this.connected = false;
    this.dev.dispatch("gattserverdisconnected");
  }
  async getPrimaryService(s: BluetoothServiceUUID): Promise<FakeService> {
    const list = await this.getPrimaryServices();
    const hit = list.find((x) => x.uuid === key(s));
    if (!hit) throw domError("NotFoundError", "No Services matching UUID found in Device.");
    return hit;
  }
  async getPrimaryServices(): Promise<FakeService[]> {
    if (!this.connected) throw domError("NetworkError", "GATT Server is disconnected.");
    if (this.allowed && this.allowed.size === 0) throw domError("SecurityError", "Origin is not allowed to access any service.");
    const list = this.services.filter((x) => !this.allowed || this.allowed.has(x.uuid));
    if (list.length === 0) throw domError("NotFoundError", "No Services found in device.");
    return list;
  }
  /** the radio link drops (out of range, switched off) */
  drop(): void {
    if (!this.connected) return;
    this.connected = false;
    this.dev.dispatch("gattserverdisconnected");
  }
}

export class FakeDevice extends FakeTarget implements BluetoothDevice {
  readonly id: string;
  readonly name: string | null;
  readonly gatt: FakeServer;
  constructor(id: string, name: string | null, services: FakeService[]) {
    super();
    this.id = id;
    this.name = name;
    this.gatt = new FakeServer(this, services);
  }
}

export class FakeBluetooth implements Bluetooth {
  granted: FakeDevice[] = [];
  requestResult: FakeDevice | Error;
  requests: RequestDeviceOptions[] = [];
  getDevices?: () => Promise<BluetoothDevice[]>;
  constructor(result: FakeDevice | Error, withGetDevices = true) {
    this.requestResult = result;
    if (withGetDevices) this.getDevices = async () => this.granted;
  }
  async requestDevice(options: RequestDeviceOptions): Promise<BluetoothDevice> {
    this.requests.push(options);
    if (this.requestResult instanceof Error) throw this.requestResult;
    const d = this.requestResult;
    // the grant covers exactly the services named in this request
    d.gatt.allowed = new Set((options.optionalServices ?? []).map(key));
    if (!this.granted.includes(d)) this.granted.push(d);
    return d;
  }
}

export class MemStorage {
  m = new Map<string, string>();
  getItem(k: string): string | null {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, v);
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
}

export const LUSH_SERVICE = "5a300001-0024-4bd4-bbd5-a6920e4c5653";
export const LUSH_TX = "5a300002-0024-4bd4-bbd5-a6920e4c5653";
export const LUSH_RX = "5a300003-0024-4bd4-bbd5-a6920e4c5653";

/** a Lush-like toy: TX (write + writeWithoutResponse), RX (notify); answers DeviceType / Battery */
export function fakeToy(opts: { id?: string; name?: string; battery?: number; model?: string } = {}) {
  const tx = new FakeCharacteristic(LUSH_TX, props({ write: true, writeWithoutResponse: true }));
  const rx = new FakeCharacteristic(LUSH_RX, props({ notify: true }));
  const dev = new FakeDevice(opts.id ?? "toy-1", opts.name ?? "LVS-Lush42", [new FakeService(LUSH_SERVICE, [tx, rx])]);
  const toy = { tx, rx, dev, battery: opts.battery ?? 85, model: opts.model ?? "S" };
  tx.onWrite = (cmd) => {
    // replies come asynchronously, as notifications
    queueMicrotask(() => {
      if (!rx.notifying) return;
      if (cmd === "DeviceType;") rx.notifyText(`${toy.model}:11:0082059AD3BD;`);
      else if (cmd === "Battery;") rx.notifyText(`${toy.battery};`);
      else rx.notifyText("OK;");
    });
  };
  return toy;
}
