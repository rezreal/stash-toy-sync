# Toy Sync

A **UI-only** [stash](https://github.com/stashapp/stash) plugin (v0.31.0) that
drives Bluetooth toys from a scene's funscript while the scene plays in
stash's own scene player. No vendor app, no server-side component: the
browser talks to the devices directly over **Web Bluetooth**.

Devices:

- **Lovense** vibrators (built in).
- **DG-Lab Coyote 2.0 / 3.0** e-stim: the plugin is built for them (two
  channels, calibration, nudges); their drivers live in `src/coyote/` and plug
  in through the driver registry (see *For driver authors*). Until they are
  part of the build, only Lovense is listed.

Several devices can be connected at once; all of them follow the same script.
It never touches stash's Handy/interactive client; both can run side by side.

## Upgrading from Lovense Sync 0.1

The plugin id changed from `lovense` to `toysync`. Remove the old `lovense`
plugin folder (or uninstall it) and install Toy Sync; stash keeps settings per
plugin id, so set them again under Settings › Plugins › Toy Sync. Other
plugins using `lovense:gain`, `lovense:status` or `window.stashLovense` keep
working for this version (see *Hook contract*).

## Setup

1. **Browser:** Chrome or Edge (desktop or Android). Firefox and Safari have no
   Web Bluetooth.
2. **Secure page:** open stash over **https** or **http://localhost**. Web
   Bluetooth is disabled on plain http pages.
3. **Install the plugin:** Settings › Plugins › Available Plugins › Add
   Source with `https://rezreal.github.io/stash-toy-sync/index.yml`, then
   install Toy Sync from it. Or copy `toysync.yml`, `toysync.js` and
   `toysync.css` into a `toysync` folder in stash's `plugins` directory and
   reload plugins.
4. **Turn the device on** and make sure its vendor app (Lovense Remote /
   Connect, DG-Lab) is **not connected to it**. A device connected to a phone
   stops advertising and won't appear in the browser.
5. Open an **interactive scene** (one with a funscript). Below the player is a
   small bar: click **Connect Lovense** (or open the devices page) and pick
   the device in the browser's Bluetooth list.

The browser remembers the permission. Where Chrome supports
`navigator.bluetooth.getDevices()`, devices reconnect on their own the next
time an interactive scene or a Toy Sync page opens; otherwise click Connect
again. If the link drops while connected, the plugin keeps trying to
reconnect until you press **Stop** or **Disconnect**.

## Pages

There is no menu entry; the bar under the player links to the pages. Each
page keeps its state in the URL, so the browser's back and forward buttons
and reloading work.

### The bar under the player

Shown for interactive scenes, and on any scene while a device is connected:

- **Toy Sync**: link to the devices page.
- Each connected device: name, battery %, and a live output meter (one, or
  A and B for two-channel devices).
- **Connect …** buttons while nothing is connected (the click is the user
  gesture the Bluetooth picker needs).
- **Calibrate …** when an e-stim device needs calibration first.
- **Stop**: outputs 0 on every device, disconnects them all and stops
  reconnecting.
- Device messages that say what to do, and a note when the scene has no
  funscript (the devices stay off).

### `/toysync`: devices and mapping

- Every supported device kind with **Connect / Disconnect / Test / Stop**,
  status, battery, live meters per channel, the stored calibration and a
  **Calibrate** link for e-stim devices (highlighted when calibration is
  needed).
- How scripts drive the devices, and the effective mapping of the open or
  last scene (which axis feeds intensity, balance, speed, channel A and B).
- A summary of the current settings (they live in Settings › Plugins ›
  Toy Sync).

### `/toysync/calibrate?device=<kind>&channel=a|b&step=1..4|review`

The calibration wizard for e-stim devices, on its own page, one channel at a
time. Each step has a level control (− / + and a slider, shown as the raw
device level and % of its range) and a large **hold-to-output** button:

1. **First felt**: the lowest level you can feel. Script output starts here.
2. **Comfort max**: as strong as the strongest part of a scene should be.
   Script output never goes above it.
3. **Nudge**: a short, sharp burst above comfort max, used for nudges
   (other plugins can request them). Try it, then confirm "sharp but OK".
4. **Hard max**: the absolute ceiling, at least the nudge level. Nothing is
   ever sent above it.
5. **Review & save**.

Output runs **only while the button is held** (pointer down, or Space held),
ramping from 0 up to the chosen level over about a second instead of jumping.
Releasing, the pointer leaving the button, losing focus, switching tabs or
windows, changing step and leaving the page all stop it at once. The Stop
button stops the device outright.

Every step, channel or device change is a browser history entry, so back,
forward and reload return to the same step; invalid parameters are corrected
in place. Levels picked so far are kept for the tab (sessionStorage); saved
calibrations live in the browser's localStorage under
`toysync.calibration.<kind>.<device id>`, per physical device. Channel A is
calibrated first; channel B is saved next to it. If no e-stim device is
connected, the page says so and links to `/toysync`.

## How the script becomes output

The funscript is fetched from stash (`/scene/{id}/funscript`, relative to
stash's base URL) for scenes marked interactive. Every ~50 ms the plugin turns
it into one **frame** for this instant, which every device reads in its own
way:

| Part | Range | From the main stroke | Used by |
| --- | --- | --- | --- |
| intensity | 0..1 overall strength | speed mode: stroke speed; position mode: depth | all devices |
| balance | 0 = channel A, 1 = channel B | depth: pos 100 (out) = A, deepest = B | e-stim |
| speed | 0..1 pulse speed | stroke speed | e-stim (frequency) |
| a / b | 0..1 per-channel strength | – (only from mapped axes) | e-stim |

**From the stroke** (the main axis, with the file's `range` applied):

- **speed mode** (default): intensity = |Δpos| / Δt (position units per
  second) of the segment the playhead is in, divided by *Full-power speed*
  (default 300), clamped to 0–1, smoothed with a ~150 ms filter. Still parts,
  and the time before the first or after the last action, are 0.
- **position mode**: intensity = depth / 100 with depth = 100 − pos
  (funscript position 100 is the top of the stroke = out, 0 the deepest
  point). A file marked `inverted` is taken as is (depth = pos). *Invert
  position mode* flips the intensity (not the balance).
- **balance** = depth / 100 in both modes (0.5 outside the script).
- **speed** = stroke speed / *Full-power speed*, lightly smoothed (~60 ms).

**Multi-axis scripts:** axes embedded in the funscript (v1.1
`axes: [{ id, actions }]` or v2 `channels: { name: … }`) can drive any part.
The *Axis mapping* setting maps axis ids to targets, e.g.
`volume=intensity, alpha=balance, e1=a, e2=b, pulse_frequency=speed`. When it
is empty, these are detected automatically (case-insensitive):

| Axis | Target |
| --- | --- |
| `volume` | intensity |
| `alpha` | balance |
| `e1`, `a`, `channel_a` | a |
| `e2`, `b`, `channel_b` | b |
| `pulse_frequency`, `frequency` | speed |

Axis positions 0–100 become 0..1. Precedence: a mapped axis beats the
stroke-derived value; direct `a` / `b` replace intensity × balance for their
channel; anything not mapped follows the stroke. A script with mapped axes but
no stroke works too (intensity is then the stronger of `a` / `b`). A mapped
`a` / `b` axis outside its actions is 0 on that channel.

**Gain** from other plugins multiplies intensity, `a` and `b`, never balance
or speed.

**Snap pulses:** if the funscript has a `snap` axis, each rising edge lifts
intensity (and `a` / `b`) to full for 300 ms (× gain), at most 3 pulses per
second.

**Latency:** the script is read *Latency compensation* ms ahead of the video
(positive values make the devices run earlier, to make up for Bluetooth lag).

**Lovense:** level = round(20 × intensity × Strength), clamped to 0–20. With a
*Minimum level*, any intensity above 0 gives at least that level (never above
what Strength × gain allow; still 0 when the script is still). Lovense sends
only changes, at most one command every 100 ms, never overlapping writes.

**E-stim:** each channel's strength is `a` / `b` when the script maps them,
else intensity panned by balance (A = intensity × min(1, 2 × (1 − balance)),
B = intensity × min(1, 2 × balance): both at full intensity in the middle).
It becomes a device level inside the channel's calibration: 0 at or below
0.005, else first felt + strength × (comfort max − first felt), never above
hard max. Speed sets the pulse frequency between *E-stim frequency at
slowest* and *at fastest*. An uncalibrated channel outputs nothing.

## Settings

Settings › Plugins › Toy Sync. All optional.

| Setting | Type | Default | Meaning |
| --- | --- | --- | --- |
| `mode` | STRING | `speed` | `speed` or `position` (how the stroke becomes intensity) |
| `speedFull` | NUMBER | 300 | position units/second that count as full intensity / full speed |
| `latencyMs` | NUMBER | 0 | read the script this many ms ahead (negative = behind) |
| `invert` | BOOLEAN | off | flip position mode's intensity |
| `snapPulse` | BOOLEAN | on | pulses on the funscript's snap axis |
| `axisMap` | STRING | – | `axis=target` pairs for multi-axis scripts; empty = auto-detect |
| `nudgeCooldownSec` | NUMBER | 4 | least seconds between two nudges (at least 2) |
| `nudgesPerMinute` | NUMBER | 6 | most nudges in any rolling minute (0–10, 0 = off) |
| `estimSpeedMinHz` | NUMBER | 10 | e-stim pulse frequency at speed 0 |
| `estimSpeedMaxHz` | NUMBER | 100 | e-stim pulse frequency at speed 1 (must be above the minimum, else both defaults apply) |
| `strength` | NUMBER | 100 | Lovense: 0–100 %, caps everything (levels, pulses, Test) |
| `minLevel` | NUMBER | 0 | Lovense: 0–20, the lowest level while the script moves |
| `namePrefix` | STRING | – | Lovense: extra Bluetooth name prefix for the picker |

Values are read leniently: missing, empty or invalid values use the default,
out-of-range numbers are clamped (frequencies to 1–1000 Hz).

## Hook contract for other plugins (version 2)

Other UI plugins (e.g. Skilltree) can scale the output, request nudges and
follow the state, without importing this plugin. Everything goes through
`window`.

**Gain**

```js
window.dispatchEvent(new CustomEvent("toysync:gain", {
  detail: { source: "skilltree", gain: 0.5 },   // gain in 0..1
}));
window.dispatchEvent(new CustomEvent("toysync:gain", {
  detail: { source: "skilltree", gain: null },  // null removes the source
}));
```

Each `source` keeps one factor (clamped to 0..1). The effective gain is the
product of all present factors (1 when there are none) and applies
immediately. It multiplies intensity and the direct channels, not balance or
speed. Events with a missing/empty source or a non-numeric gain are ignored.
`lovense:gain` is still accepted as an alias.

**Nudge**

```js
window.dispatchEvent(new CustomEvent("toysync:nudge", {
  detail: { source: "skilltree", reason: "looked away" },
}));
window.addEventListener("toysync:nudge-result", (e) => {
  // { source, reason, accepted: true, devices: 1 }   forwarded; devices = how many nudged
  // { source, reason, accepted: false, dropped: "cooldown" | "rate" | "no-scene" | "disabled" | "invalid" }
});
```

A request asks for **one** nudge: a short, sharp burst at the calibrated nudge
level on every device that has one (vibrators don't). The plugin enforces,
however often it is asked:

- at most one nudge per *Nudge cooldown* (default 4 s, never below 2 s),
- at most *Nudges per minute* in any rolling minute (default 6, never above
  10),
- never while no scene is open in the player.

Requests over the limits are **dropped, never queued**; each one is answered
with `toysync:nudge-result` and logged to the console. Only accepted nudges
count towards the limits.

**Status**

```js
window.addEventListener("toysync:status", (e) => {
  const s = e.detail;
  // { devices: [{ kind: "lovense" | "coyote-v2" | "coyote-v3", id,
  //               status: { connection: "disconnected" | "connecting" | "connected" | "error",
  //                         device?, battery?, message?, output?: { a, b? }, needsCalibration? } }],
  //   frame: { intensity, balance, speed, a?, b?, gain? } | null,   // null = silence
  //   gain: 0..1 }
});
```

Dispatched whenever a device's status, the gain, or silence/output changes;
changes of the output alone (frame values, meters) at most 5 times per
second, the latest always delivered.

**API**

```js
window.stashToySync.version            // 2
window.stashToySync.status()           // the status object above
window.stashToySync.connect("lovense") // from a click handler: may open the Bluetooth picker
```

**Legacy (Lovense Sync 0.1), for this version only:** `lovense:status` (the
Lovense status `{ connection, device?, battery?, model?, level?, message? }`)
is still dispatched, and `window.stashLovense` (`version: 1`,
`deprecated: true`, `status()`, `connect()`) still works.

## Safety

- **Nothing exceeds a channel's hard max.** E-stim output lives between first
  felt and comfort max; nudges go to the nudge level; the calibration probe
  never exceeds the device's absolute maximum.
- **0 on pause, seek, stop, leaving the scene and a dropped link.** Output
  only runs while the video is actually playing (not paused, ended, seeking or
  buffering) with a script. Every stop sends an explicit 0, and 0 is held a
  little longer than the rate limits so a quick resume can't swallow it.
  Closing the tab sends a best-effort 0.
- **Nudges never escalate.** A nudge is one burst at the calibrated level;
  requests are rate-limited, dropped rather than queued, and never sent
  without an open scene.
- **E-stim: below the waist only.** Never place electrodes across the chest,
  near the heart, on the head or neck. Not with a pacemaker, heart condition,
  epilepsy or during pregnancy. Start low.
- **Stop** under the player stops and disconnects every device; *Strength*
  caps Lovense output (including snap pulses, minimum level and Test).
- The plugin never powers a device off. Switch it off with its button.
- If anything feels wrong, pause the video, press Stop, or switch the device
  off.

## For driver authors

Drivers implement `ToyDevice` (and, for e-stim, `CalibratableDevice`) from
`src/devices/types.ts` and register a factory once at import time:

```ts
// src/coyote/register.ts
import { registerDriver } from "../devices/registry.ts";
registerDriver("coyote-v3", (ctx) => createCoyoteV3(ctx), { label: "DG-Lab Coyote 3.0", description: "E-stim, two channels" });
```

and `src/index.tsx` imports that module (the spot is marked). The factory gets
a `DriverContext`: `settings()` (the parsed settings, e.g. `estimSpeedMinHz`),
`onSettings(cb)`, `timers` and `now`. The `DeviceManager` creates one device
per kind, calls `drive(frame | null)` from every engine tick (about every
50 ms while a scene plays, plus right away on pause, seek and gain changes;
not at all while no scene page is open), fans nudges and stops out, and
retries a dropped link with `resume()` unless the driver sets
`selfReconnects`. `src/devices/estim.ts` (`channelIntensities`,
`channelLevels`, `estimFrequencyHz`) and `src/devices/calibration.ts`
(`levelFor`, `validateCalibration`, `loadCalibration` / `saveCalibration`)
hold the shared e-stim maths and storage.

## Lovense protocol notes

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

Every push to `main` type-checks, tests, builds and publishes the package
source to GitHub Pages (`.github/workflows/release.yml`).

Node 22 runs the TypeScript tests directly (type stripping), so the code uses
erasable syntax only. React comes from `window.PluginApi` at runtime and is
never bundled.

## License

AGPL-3.0-only, like stash.
