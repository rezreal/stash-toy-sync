// Minimal Web Serial types: only the parts src/tcode uses (TypeScript's DOM
// lib has none). A module, not global declarations, so real browser objects
// and small test fakes both fit. Spec: https://wicg.github.io/serial/

export interface SerialPortInfo {
  usbVendorId?: number;
  usbProductId?: number;
}

export interface SerialPortLike {
  /** non-null while the port is open (in this page, by anyone) */
  readonly readable: ReadableStream<Uint8Array> | null;
  /** a fresh stream may be offered after a failed write */
  readonly writable: WritableStream<Uint8Array> | null;
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  getInfo(): SerialPortInfo;
}

/** navigator.serial; fires "disconnect" with the port as the event target */
export interface SerialLike {
  requestPort(options?: { filters?: SerialPortInfo[] }): Promise<SerialPortLike>;
  getPorts(): Promise<SerialPortLike[]>;
  addEventListener(type: "disconnect" | "connect", listener: (ev: { target: unknown }) => void): void;
  removeEventListener?(type: "disconnect" | "connect", listener: (ev: { target: unknown }) => void): void;
}
