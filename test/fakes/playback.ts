// A fake video as a PlaybackClock, for self-timed devices (TCode, PiuPiu).
// Stands in for the <video> element TCode Player's tests used:
// - advancing: currentTime runs on with performance.now() while playing
//   (output.test's PlayingVideo)
// - frozen: currentTime only changes when a test sets it (lube.test's FakeVideo)
import type { DeviceProgram, PlaybackClock, PlaybackEvent, ScriptChannel } from "../../src/devices/types.ts";
import { parseFunscript } from "../../src/funscript/parse.ts";

export class FakeVideo implements PlaybackClock {
  paused = true;
  ended = false;
  advancing: boolean;
  offsetMs = 0;
  private t = 0;
  private wall = 0;
  private listeners = new Set<(e: PlaybackEvent) => void>();

  constructor(opts: { advancing?: boolean } = {}) {
    this.advancing = opts.advancing ?? false;
  }

  get currentTime(): number {
    return this.paused || !this.advancing ? this.t : this.t + (performance.now() - this.wall) / 1000;
  }
  set currentTime(v: number) {
    this.t = v;
    this.wall = performance.now();
  }

  scriptMs(): number | undefined {
    return this.currentTime * 1000 + this.offsetMs;
  }
  playing(): boolean {
    return !this.paused && !this.ended;
  }
  onChange(cb: (e: PlaybackEvent) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }
  emit(e: PlaybackEvent): void {
    for (const cb of [...this.listeners]) cb(e);
  }
  get subscribers(): number {
    return this.listeners.size;
  }

  play(): void {
    this.wall = performance.now();
    this.paused = false;
    this.emit("play");
  }
  pause(): void {
    this.t = this.currentTime;
    this.paused = true;
    this.emit("pause");
  }
  seek(seconds: number): void {
    this.currentTime = seconds;
    this.emit("seek");
  }
}

/** A funscript's channels as Toy Sync hands them to devices: "stroke" plus each extra axis by its key. */
export function scriptChannels(json: unknown): ScriptChannel[] {
  const f = parseFunscript(json);
  const out: ScriptChannel[] = [];
  if (f.actions.length) out.push({ id: "stroke", actions: f.actions });
  for (const [id, actions] of f.axes) out.push({ id, actions });
  return out;
}

export function fakeProgram(opts: {
  sceneId?: string;
  clock: PlaybackClock;
  script?: unknown;
  channels?: ScriptChannel[];
  /** default: the device's defaultMapping(channels) */
  mapping?: DeviceProgram["mapping"];
  device?: { defaultMapping?(c: readonly ScriptChannel[]): DeviceProgram["mapping"] };
  options?: Record<string, unknown>;
}): DeviceProgram {
  const channels = opts.channels ?? scriptChannels(opts.script);
  const mapping = opts.mapping ?? opts.device?.defaultMapping?.(channels) ?? {};
  const program: DeviceProgram = { sceneId: opts.sceneId ?? "1", clock: opts.clock, channels, mapping, gain: () => 1 };
  if (opts.options) program.options = opts.options;
  return program;
}
