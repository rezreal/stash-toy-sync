// A scriptable ToyDevice (and CalibratableDevice) that records every call.
import type { Calibration, CalibratableDevice, DeviceKind, DeviceStatus, DriveFrame } from "../../src/devices/types.ts";

export interface ProbeCall {
  channel: "a" | "b";
  level: number;
  kind: "steady" | "burst";
  active: boolean;
}

export class FakeDevice implements CalibratableDevice {
  readonly kind: DeviceKind;
  id: string;
  readonly channels: readonly ("a" | "b")[] = ["a", "b"];
  selfReconnects?: boolean;
  st: DeviceStatus = { connection: "disconnected" };
  frames: (DriveFrame | null)[] = [];
  calls: string[] = [];
  probes: ProbeCall[] = [];
  canNudge = true;
  cal: Calibration | undefined;
  /** what connect() / resume() end in */
  connectResult: DeviceStatus["connection"] = "connected";
  resumeResult: DeviceStatus["connection"] = "connected";
  throwOnDrive = false;
  private listeners = new Set<(s: DeviceStatus) => void>();

  constructor(kind: DeviceKind = "coyote-v3", id = `${kind}-1`) {
    this.kind = kind;
    this.id = id;
  }

  setStatus(s: DeviceStatus): void {
    this.st = s;
    for (const cb of [...this.listeners]) cb(s);
  }
  async connect(): Promise<void> {
    this.calls.push("connect");
    this.setStatus({ connection: this.connectResult });
  }
  async resume(): Promise<void> {
    this.calls.push("resume");
    this.setStatus({ connection: this.resumeResult });
  }
  disconnect(): void {
    this.calls.push("disconnect");
    this.setStatus({ connection: "disconnected" });
  }
  status(): DeviceStatus {
    return this.st;
  }
  onStatus(cb: (s: DeviceStatus) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  drive(frame: DriveFrame | null): void {
    if (this.throwOnDrive) throw new Error("boom");
    this.frames.push(frame);
  }
  nudge(): boolean {
    this.calls.push("nudge");
    return this.canNudge;
  }
  test(): void {
    this.calls.push("test");
  }
  stopNow(): void {
    this.calls.push("stopNow");
  }
  calibration(): Calibration | undefined {
    return this.cal;
  }
  setCalibration(c: Calibration | undefined): void {
    this.cal = c;
  }
  probe(channel: "a" | "b", level: number, kind: "steady" | "burst", active: boolean): void {
    this.probes.push({ channel, level, kind, active });
  }
  levelRange(): { min: number; max: number } {
    return { min: 0, max: 200 };
  }
}
