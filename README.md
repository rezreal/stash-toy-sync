# Lovense Sync

A **UI-only** [stash](https://github.com/stashapp/stash) plugin (v0.31.0) that
drives Lovense **vibrators** over **Web Bluetooth** from a scene's funscript
while the scene plays in stash's own scene player. No Lovense app, no
server-side component: the browser talks to the toy directly.

It never touches stash's Handy/interactive client; both can run side by side.

## Setup

1. **Browser:** Chrome or Edge (desktop or Android). Firefox and Safari have no
   Web Bluetooth.
2. **Secure page:** open stash over **https** or **http://localhost**. Web
   Bluetooth is disabled on plain http pages.
3. **Install the plugin:** add the package source (the `index.yml` built by
   `./build.sh`) under Settings › Plugins › Available Plugins, or copy
   `lovense.yml`, `lovense.js` and `lovense.css` into a `lovense` folder in
   stash's `plugins` directory and reload plugins.
4. **Turn the toy on** and make sure the **Lovense Remote / Connect app is not
   connected to it** (close the app or disconnect the toy there). A toy that is
   connected to a phone stops advertising and won't appear in the browser.
5. Open an **interactive scene** (one with a funscript). Below the player is a
   small bar: click **Lovense · Connect** and pick the toy (`LVS-…` or `LOVE-…`)
   in the browser's Bluetooth list.

The browser remembers the permission. Where Chrome supports
`navigator.bluetooth.getDevices()`, the toy reconnects on its own the next
time an interactive scene opens; otherwise click Connect again. If the link
drops while connected, the plugin keeps trying to reconnect (every few
seconds) until you press **Stop**.

## The control

Shown under the player for interactive scenes, and on any scene while a toy is
connected:

- **Lovense · Connect** while no toy is connected (the click is the user
  gesture the Bluetooth picker needs).
- The toy's name/model, battery % (polled every minute), and a live **level
  meter** (0–20, the level last sent to the toy).
- **Test**: a 1 s pulse at level 10 × Strength.
- **Stop**: sends `Vibrate:0;`, disconnects and stops reconnecting.
- A note when the scene has no funscript (the toy stays off), and status or
  error messages that say what to do.

## How the script becomes vibration

The funscript is fetched from stash (`/scene/{id}/funscript`, relative to
stash's base URL) for scenes marked interactive. The main stroke axis is used,
with the file's `range` applied.

- **speed** (default): intensity = |Δpos| / Δt (position units per second)
  of the segment the playhead is in, divided by *Full-power speed* (default
  300), clamped to 0–1, smoothed with a ~150 ms exponential filter so short
  spikes don't jerk the motor. Still parts, and the time before the first or
  after the last action, are 0.
- **position**: intensity = depth / 100 with depth = 100 − pos (funscript
  position 100 is the top of the stroke = out, 0 the deepest point). A file
  marked `inverted` is taken as is (depth = pos). *Invert position mode*
  flips the result. Outside the script: 0.

Level = round(20 × intensity × Strength × gain), clamped to 0–20. With a
*Minimum level*, any intensity above 0 gives at least that level (never above
what Strength × gain allow; still 0 when the script is still).

**Snap pulses:** if the funscript has a `snap` axis (v1.1 `axes[]` or v2.0
`channels{}`), each rising edge adds a 300 ms full-intensity pulse (× Strength
× gain), at most 3 pulses per second.

**Latency:** the script is read *Latency compensation* ms ahead of the video
(positive values make the toy run earlier, to make up for Bluetooth lag).

The plugin sends only changes, at most one command every 100 ms (the latest
wanted level wins), and never overlaps writes.

## Settings

Settings › Plugins › Lovense Sync. All optional.

| Setting | Type | Default | Meaning |
| --- | --- | --- | --- |
| `mode` | STRING | `speed` | `speed` or `position` |
| `strength` | NUMBER | 100 | 0–100 %, caps everything (levels, pulses, Test) |
| `speedFull` | NUMBER | 300 | position units/second that count as full power in speed mode |
| `minLevel` | NUMBER | 0 | 0–20, the lowest level while the script moves |
| `latencyMs` | NUMBER | 0 | read the script this many ms ahead (negative = behind) |
| `invert` | BOOLEAN | off | flip position mode |
| `snapPulse` | BOOLEAN | on | pulses on the funscript's snap axis |
| `namePrefix` | STRING | – | extra Bluetooth name prefix for the picker |

Values are read leniently: missing, empty or invalid values use the default,
out-of-range numbers are clamped.

## Hook contract for other plugins

Other UI plugins (e.g. Skilltree) can scale the output and follow the state.

**Gain** — dispatch on `window`:

```js
window.dispatchEvent(new CustomEvent("lovense:gain", {
  detail: { source: "skilltree", gain: 0.5 },   // gain in 0..1
}));
window.dispatchEvent(new CustomEvent("lovense:gain", {
  detail: { source: "skilltree", gain: null },  // null removes the source
}));
```

Each `source` keeps one factor (clamped to 0..1). The effective gain is the
product of all present factors (1 when there are none) and applies
immediately (the 100 ms rate limit still applies). Gain 0 sends `Vibrate:0;`.
Events with a missing/empty source or a non-numeric gain are ignored.

**Status** — listen on `window`:

```js
window.addEventListener("lovense:status", (e) => {
  const s = e.detail;
  // { connection: "disconnected" | "connecting" | "connected" | "error",
  //   device?: "LVS-Lush42", battery?: 85, model?: "Lush",
  //   level?: 0..20 (last sent, while connected), message?: string }
});
```

Dispatched whenever the status or the sent level changes; changes of the
level alone at most 5 times per second (the latest level is always
delivered).

**API** — `window.stashLovense`:

```js
window.stashLovense.version   // 1
window.stashLovense.status()  // the status object above
window.stashLovense.connect() // call from a click handler: may open the Bluetooth picker
```

## Safety

- **Pausing stops the toy.** Output only runs while the video is actually
  playing (not paused, ended, seeking or buffering). Every stop — pause, end,
  seek, leaving the scene, gain 0, disconnect — sends an explicit
  `Vibrate:0;`; the plugin holds 0 a little longer than the rate limit so a
  quick resume can't swallow it. Closing the tab sends a best-effort
  `Vibrate:0;`.
- **Stop** under the player stops the toy and disconnects.
- **Strength** caps the output, including snap pulses, minimum level and Test.
- The plugin never sends `PowerOff;`. Switch the toy off with its button.
- If anything feels wrong, pause the video, press Stop, or switch the toy off.

## Protocol notes

Lovense doesn't publish its BLE protocol; this follows the community
documentation (e.g. buttplug.io). Toys advertise as `LVS-…` (newer) or
`LOVE-…` (older). Service UUIDs differ by model, so the picker requests every
`XX300001-002Y-4bd4-bbd5-a6920e4c5653` (XX = 40–5f, Y = 3, 4) plus
`0000fff0-…` and Nordic UART `6e400001-…`. The first service with a writable
characteristic is used (TX = `…0002…` / `fff2` / `6e400002`, RX =
`…0003…` / `fff1` / `6e400003`, falling back to the characteristic
properties). Commands: `DeviceType;`, `Battery;`, `Vibrate:N;` (0–20, all
motors). Only a few well-known model letters are named (S Lush, Z Hush, P
Edge, W Domi, A/C Nora, B Max, O Osci, L Ambi, ED Gush); others show the
letter.

## Development

```bash
npm install
npm run check      # typecheck, tests (node --test, fakes only), bundle
./build.sh         # dist/: plugin zip + index.yml (a stash plugin source)
```

Node 22 runs the TypeScript tests directly (type stripping), so the code uses
erasable syntax only. React comes from `window.PluginApi` at runtime and is
never bundled.

## License

AGPL-3.0-only, like stash.
