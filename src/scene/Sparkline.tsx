// A script channel's preview line with a marker that follows the video
// (adapted from TCode Player). One requestAnimationFrame loop moves every
// marker on the page; it only runs while a sparkline is mounted.
import type { ScriptChannel } from "../devices/types.ts";

interface Playhead {
  el: HTMLElement;
  end: number;
  last: number | undefined | null;
}

const playheads = new Set<Playhead>();
let raf = 0;
let readTime: () => number | undefined = () => undefined;

function frame(): void {
  raf = 0;
  if (playheads.size === 0) return;
  const t = readTime();
  for (const p of playheads) {
    const v = t === undefined ? null : t;
    if (v === p.last) continue;
    p.last = v;
    if (v === null) {
      p.el.style.display = "none";
      continue;
    }
    p.el.style.display = "";
    p.el.style.left = `${Math.max(0, Math.min(1, v / p.end)) * 100}%`;
  }
  raf = window.requestAnimationFrame(frame);
}

function addPlayhead(p: Playhead, time: () => number | undefined): () => void {
  readTime = time;
  playheads.add(p);
  if (!raf) raf = window.requestAnimationFrame(frame);
  return () => {
    playheads.delete(p);
  };
}

export interface SparklineProps {
  channel: ScriptChannel;
  /** the video's length in ms (0 = unknown: the last action ends the line) */
  durationMs: number;
  /** the video time in ms now, undefined without a video */
  time: () => number | undefined;
}

export function Sparkline(props: SparklineProps) {
  const { channel, durationMs, time } = props;
  const canvas = React.useRef<HTMLCanvasElement | null>(null);
  const head = React.useRef<HTMLDivElement | null>(null);
  const acts = channel.actions;
  const end = acts.length > 0 ? Math.max(durationMs || 0, acts[acts.length - 1]!.at) || 1 : 1;

  React.useEffect(() => {
    if (!head.current) return;
    return addPlayhead({ el: head.current, end, last: undefined }, time);
  }, [end, time]);

  React.useEffect(() => {
    const c = canvas.current;
    if (!c || acts.length === 0) return;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth || 240;
    const h = c.clientHeight || 28;
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = getComputedStyle(c).color;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    // at most ~2 points per pixel
    const step = Math.max(1, Math.floor(acts.length / (w * 2)));
    const flip = channel.inverted === true;
    for (let i = 0; i < acts.length; i += step) {
      const a = acts[i]!;
      const pos = flip ? 100 - a.pos : a.pos;
      const x = (a.at / end) * w;
      const y = h - 2 - (pos / 100) * (h - 4);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }, [acts, end, channel.inverted]);

  return (
    <div className="toysync-spark-wrap" aria-hidden="true">
      <canvas ref={canvas} className="toysync-spark" />
      <div ref={head} className="toysync-playhead" style={{ display: "none" }} />
    </div>
  );
}
