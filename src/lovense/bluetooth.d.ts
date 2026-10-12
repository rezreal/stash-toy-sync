// Minimal Web Bluetooth types: only the parts src/lovense uses. A module
// (not global declarations) so it never clashes with @types/web-bluetooth if
// that is added later; the real browser objects fit these shapes. Event
// targets are narrowed to add/removeEventListener so test fakes stay small.
// Spec: https://webbluetoothcg.github.io/web-bluetooth/

export type BluetoothServiceUUID = number | string;
export type BluetoothCharacteristicUUID = number | string;

export interface BleEventTarget {
  addEventListener(type: string, listener: (e: Event) => void): void;
  removeEventListener(type: string, listener: (e: Event) => void): void;
}

export interface BluetoothLEScanFilter {
  name?: string;
  namePrefix?: string;
  services?: BluetoothServiceUUID[];
}

export interface RequestDeviceOptions {
  filters?: BluetoothLEScanFilter[];
  acceptAllDevices?: boolean;
  optionalServices?: BluetoothServiceUUID[];
}

export interface BluetoothCharacteristicProperties {
  readonly broadcast: boolean;
  readonly read: boolean;
  readonly writeWithoutResponse: boolean;
  readonly write: boolean;
  readonly notify: boolean;
  readonly indicate: boolean;
  readonly authenticatedSignedWrites?: boolean;
  readonly reliableWrite?: boolean;
  readonly writableAuxiliaries?: boolean;
}

export interface BluetoothRemoteGATTCharacteristic extends BleEventTarget {
  readonly uuid: string;
  readonly properties: BluetoothCharacteristicProperties;
  /** the last value read or notified ("characteristicvaluechanged") */
  readonly value?: DataView | null;
  readValue(): Promise<DataView>;
  startNotifications(): Promise<BluetoothRemoteGATTCharacteristic>;
  stopNotifications(): Promise<BluetoothRemoteGATTCharacteristic>;
  /** deprecated alias of writeValueWithResponse in current Chrome */
  writeValue?(value: BufferSource): Promise<void>;
  writeValueWithResponse?(value: BufferSource): Promise<void>;
  writeValueWithoutResponse?(value: BufferSource): Promise<void>;
}

export interface BluetoothRemoteGATTService {
  readonly uuid: string;
  readonly isPrimary?: boolean;
  getCharacteristic(characteristic: BluetoothCharacteristicUUID): Promise<BluetoothRemoteGATTCharacteristic>;
  getCharacteristics(characteristic?: BluetoothCharacteristicUUID): Promise<BluetoothRemoteGATTCharacteristic[]>;
}

export interface BluetoothRemoteGATTServer {
  readonly connected: boolean;
  connect(): Promise<BluetoothRemoteGATTServer>;
  disconnect(): void;
  getPrimaryService(service: BluetoothServiceUUID): Promise<BluetoothRemoteGATTService>;
  /** only the services listed in optionalServices/filters are returned */
  getPrimaryServices(service?: BluetoothServiceUUID): Promise<BluetoothRemoteGATTService[]>;
}

/** fires "gattserverdisconnected" */
export interface BluetoothDevice extends BleEventTarget {
  readonly id: string;
  readonly name?: string | null;
  readonly gatt?: BluetoothRemoteGATTServer | null;
}

/** navigator.bluetooth; getDevices() is missing in some browsers / behind a flag */
export interface Bluetooth {
  requestDevice(options: RequestDeviceOptions): Promise<BluetoothDevice>;
  getDevices?(): Promise<BluetoothDevice[]>;
  getAvailability?(): Promise<boolean>;
}
