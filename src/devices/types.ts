// The device contract every driver implements (Lovense in src/lovense/toy.ts,
// DG-Lab Coyote in src/coyote/). The sync engine produces one DriveFrame per
// tick; the DeviceManager (manager.ts) fans it out to every device. Drivers
// own everything device specific: their own level scale, rate limits,
// packet cadence and safety caps. Pure types, no runtime code.

export type DeviceKind = "lovense" | "coyote-v2" | "coyote-v3";

/** What the script asks for at one instant, already multiplied by the hook gain. */
export interface DriveFrame {
  /** overall strength 0..1 */
  intensity: number;
  /** where the power sits between two channels: 0 = all A, 1 = all B, 0.5 = even */
  balance: number;
  /** pulse speed 0..1 (e-stim frequency; vibrators ignore it) */
  speed: number;
  /** explicit per-channel strengths 0..1 from mapped script axes; when set they replace intensity × balance for that channel */
  a?: number;
  b?: number;
  /**
   * The hook gain (0..1) that intensity, a and b already contain. Informational:
   * never multiply by it again. Lets a driver keep a minimum level from
   * exceeding what the gain allows (the Lovense minLevel does).
   */
  gain?: number;
}

export interface DeviceStatus {
  connection: "disconnected" | "connecting" | "connected" | "error";
  device?: string;      // name / model for display
  battery?: number;     // 0..100
  message?: string;
  /** what is being output right now, for meters: per channel 0..1 of the device's own range */
  output?: { a: number; b?: number };
  /** the device needs calibration before it outputs anything (e-stim) */
  needsCalibration?: boolean;
}

export interface ToyDevice {
  readonly kind: DeviceKind;
  /**
   * Stable per physical device (e.g. the Bluetooth id). May be a getter: before
   * the first connect there is no physical device yet, and the value is then
   * the kind (or a remembered id from an earlier visit).
   */
  readonly id: string;            // stable per physical device (e.g. Bluetooth id)
  connect(): Promise<void>;       // never rejects; call from a user gesture the first time
  disconnect(): void;             // outputs 0 first
  status(): DeviceStatus;
  onStatus(cb: (s: DeviceStatus) => void): () => void;
  /** called every ~50 ms while a scene plays; null = silence (paused, seeking, no script, stopped) */
  drive(frame: DriveFrame | null): void;
  /** one nudge burst (sharp, short); false when the device has no nudge or isn't calibrated for it */
  nudge(): boolean;
  /** a short feel-good test pulse */
  test(): void;
  /** output 0 immediately, keep the connection */
  stopNow(): void;
  /**
   * Optional: reconnect a device the browser granted on an earlier visit, without
   * a picker (no user gesture needed); quietly does nothing otherwise. Never
   * rejects. The manager calls it when an interactive scene opens, and to
   * retry a dropped link of a driver that doesn't set `selfReconnects`.
   */
  resume?(): Promise<void>;
  /**
   * Optional: true when the driver retries a dropped link on its own (the
   * Lovense driver does). Otherwise the manager retries with resume().
   */
  readonly selfReconnects?: boolean;
  /** Optional: release timers and listeners (the manager calls it on dispose). */
  dispose?(): void;
}

/** E-stim style devices also implement this for the calibration page. */
export interface CalibratableDevice extends ToyDevice {
  readonly channels: readonly ("a" | "b")[];
  /** stored calibration (per channel), undefined = not calibrated */
  calibration(): Calibration | undefined;
  setCalibration(c: Calibration | undefined): void;
  /**
   * Calibration probe: output this raw device level on one channel while `active` is true
   * ("hold to output" — the page calls it with active=false on release / blur / unmount).
   * kind "steady" = feel-good waveform, "burst" = the sharp nudge waveform.
   * Never exceeds the device's absolute maximum.
   *
   * While the button is held the page calls this about every 50 ms with
   * active=true and a level that ramps from 0 up to the chosen level over
   * ~1 s; one final call with active=false (level 0) ends it.
   */
  probe(channel: "a" | "b", level: number, kind: "steady" | "burst", active: boolean): void;
  /** the raw level range of one channel, e.g. { min: 0, max: 200 } */
  levelRange(): { min: number; max: number };
}

export interface ChannelCalibration {
  /** raw device levels */
  firstFelt: number;
  comfortMax: number;   // > firstFelt; script output lives in [firstFelt, comfortMax]
  nudge: number;        // > comfortMax
  hardMax: number;      // >= nudge; nothing ever exceeds it
}
export type Calibration = { a: ChannelCalibration; b?: ChannelCalibration; updatedAt: string };
