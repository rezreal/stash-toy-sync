// Styles for the TCode and PiuPiu panels, injected once when a panel first
// mounts (kept next to the components instead of in toysync.css). Classes
// are prefixed toysync-tc-.
const STYLE_ID = "toysync-tcode-style";

const CSS = `
.toysync-tc { display: flex; flex-direction: column; gap: 0.5rem; }
.toysync-tc h3 { font-size: 1rem; font-weight: 600; margin: 1rem 0 0.25rem; }
.toysync-tc h3:first-child { margin-top: 0; }
.toysync-tc-row { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
.toysync-tc-grow { flex: 1 1 auto; }
.toysync-tc-muted { opacity: 0.65; }
.toysync-tc-small { font-size: 0.8rem; }
.toysync-tc-grid { display: grid; grid-template-columns: max-content 120px; gap: 0.35rem 0.75rem; align-items: center; }
.toysync-tc-select { width: auto; min-width: 150px; }
.toysync-tc-num { width: 110px; }
.toysync-tc-table td, .toysync-tc-table th { vertical-align: middle; padding: 0.25rem 0.4rem; }
.toysync-tc-off { opacity: 0.55; }
.toysync-tc-range { display: grid; grid-template-columns: 110px auto; grid-template-rows: auto auto; column-gap: 0.5rem; align-items: center; min-width: 170px; }
.toysync-tc-range input { grid-column: 1; height: 1rem; }
.toysync-tc-range span { grid-column: 2; grid-row: 1 / span 2; font-size: 0.8rem; font-variant-numeric: tabular-nums; opacity: 0.8; }
.toysync-tc-error { border-radius: 4px; padding: 0.5rem 0.75rem; font-size: 0.85rem; background: rgba(217, 83, 79, 0.18); }
.toysync-tc-notice { border-radius: 4px; padding: 0.5rem 0.75rem; font-size: 0.85rem; background: rgba(240, 173, 78, 0.15); }
.toysync-tc-preview { position: relative; height: 340px; margin-top: 0.5rem; border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 6px; overflow: hidden; }
.toysync-tc-preview-canvas { position: absolute; inset: 0; }
.toysync-tc-preview-msg { position: absolute; left: 0.75rem; top: 0.5rem; font-size: 0.85rem; }
.toysync-tc-lube { position: absolute; right: 0.6rem; top: 0.5rem; width: 22px; height: 22px; opacity: 0.35; color: #8fb8de; transition: opacity 0.1s linear; }
.toysync-tc-lube.toysync-tc-on { opacity: 1; color: #5bc0de; filter: drop-shadow(0 0 4px #5bc0de); }
.toysync-tc-log { font-size: 0.75rem; max-height: 8rem; overflow: auto; white-space: pre-wrap; opacity: 0.8; }
`;

export function ensureStyles(doc: Document | undefined = globalThis.document): void {
  if (!doc || doc.getElementById(STYLE_ID)) return;
  const el = doc.createElement("style");
  el.id = STYLE_ID;
  el.textContent = CSS;
  doc.head.appendChild(el);
}
