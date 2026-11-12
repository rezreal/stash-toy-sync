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

- **TCode strokers** (OSR2 / SR6 / SSR1 over Web Serial) and the **Hismith
  PiuPiu** lube launcher: the drivers from the former *TCode Player* plugin
  plug in through the same registry as self-timed devices (see *For driver
  authors*).

Several devices can be connected at once, also several of the same kind (two
Coyotes, two Lovense toys, two strokers; see *Several devices of one kind*),
and all follow the scene's script; each scene can say per device which
script channel drives what (the scene page's **Interactive** tab). It never
touches stash's Handy/interactive client; both can run side by side.

## Coming from TCode Player

Toy Sync takes over what the *TCode Player* plugin did: the Interactive tab,
the navbar menu and the per-scene mapping. Scene mappings saved by TCode
Player (`tcode_map`) are read and converted automatically (see *Per-scene
mapping*); `tcode_map` itself is never changed or removed. While TCode Player
is still installed, the devices page and the Interactive tab show a notice:
uninstall it under Settings › Plugins, or the stroker is driven twice.

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

The navbar menu and the bar under the player link to the pages. Each page
keeps its state in the URL, so the browser's back and forward buttons and
reloading work.

### The navbar menu

An icon in stash's navbar (next to the other utility icons) with a status
dot: grey = nothing connected, green = connected, glowing = a device is
outputting. It opens a panel with:

- every device by its name (several of one kind are listed separately):
  state, **Connect / Disconnect**, and the driver's own actions (TCode: Home,
  Motion on/off);
- **Stop all**: outputs 0 on every device and disconnects them (like Stop
  under the player);
- links to the devices page and the calibration page.

Escape or a click outside closes it; keyboard focus moves into the panel when
it opens and back to the icon when it closes.

### The scene page's Interactive tab

A tab next to stash's own scene tabs. For the open scene:

- **Script channels**: every channel of the funscript (`stroke` is the main
  axis, embedded axes by their id) with a preview line; an orange marker
  follows the video.
- **Scene offset (ms)**: shifts the script against the video for this scene
  (positive = devices run earlier; adds to *Latency compensation*).
- Per device (connected or not; two Coyotes are two sections, by name), its
  state, live output meters, Connect / Disconnect, its preview (TCode: the 3D
  view) and one row per channel:
  - **Target**: what the channel drives on this device (the device's own
    targets, grouped; or Off). Lovense: Vibration. Coyote: Auto, Intensity,
    Channel A, Channel B, Balance A↔B, Pulse frequency. TCode: its axes.
  - **Invert** and **Min / Max** (0–100): the channel's full range is lerped
    into this window, so the motion keeps its shape (Min above Max flips it).
  - **Test**: sweeps the channel's target where the driver supports it
    (TCode), otherwise the device's short test pulse.
  - **Default**: back to the device's default for that channel.
- **Save to scene** stores the mapping in the scene; **Revert** goes back to
  what is stored; **Use defaults** (then Save) removes the scene's mapping.

Changes apply live while the scene plays, before saving.

### The bar under the player

Shown for interactive scenes, and on any scene while a device is connected
(it also binds the scene: script, saved mapping and clock):

- **Toy Sync**: link to the devices page.
- Each connected device: its name, battery %, and a live output meter (one,
  or A and B for two-channel devices).
- **Connect …** buttons (one per device) while nothing is connected (the
  click is the user gesture the Bluetooth picker needs).
- **Calibrate …** when an e-stim device needs calibration first.
- **Stop**: outputs 0 on every device, disconnects them all and stops
  reconnecting.
- Device messages that say what to do, and a note when the scene has no
  funscript (the devices stay off).

### `/toysync`: devices and mapping

- Every supported device kind, with a card per device of that kind:
  its name (**Rename** in place), **Connect / Disconnect / Test / Stop**,
  status, battery, live meters per channel, the stored calibration and a
  **Calibrate** link for e-stim devices (highlighted when calibration is
  needed), the driver's own actions and settings panel (TCode: preset and
  axis limits), and for self-timed devices which scene they are playing.
  **Add another …** adds a device of that kind; **Remove** (on every device
  but the first of a kind, after a confirmation) disconnects it and forgets
  it in this browser.
- How scripts drive the devices, and the default mapping of the open or last
  scene (which axis feeds intensity, balance, speed, channel A and B).
- A summary of the current settings (they live in Settings › Plugins ›
  Toy Sync).

### `/toysync/calibrate?device=<device id>&channel=a|b&step=1..4|review`

`device` is the device's id (`coyote-v3`, `coyote-v3:2`, see *Several
devices of one kind*); links with just the kind open the first device of
that kind.


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
`toysync.calibration.<kind>.<physical id>`, per physical device (the
Bluetooth id), whichever Toy Sync device it is connected as. Channel A is
calibrated first; channel B is saved next to it. If no e-stim device is
connected, the page says so and links to `/toysync`.

## Per-scene mapping

Without a saved mapping every device uses its default (for Lovense and Coyote
exactly the behaviour described under *How the script becomes output*; TCode
maps channel names to axes from its device profile). A scene's own mapping is
stored in the scene custom field **`toysync_map`**, a JSON string you can also
edit by hand:

```json
{ "v": 1, "offsetMs": 40,
  "devices": {
    "coyote-v3": { "mapping": { "stroke": { "target": "auto" }, "e1": { "target": "a", "max": 80 } } },
    "lovense":   { "mapping": { "stroke": { "target": "intensity", "min": 10, "max": 70 } } },
    "tcode":     { "mapping": { "pitch": { "target": "R2", "invert": true, "min": 20, "max": 80 },
                                "surge": { "target": "off" } },
                   "options": { "generate": "gentle" } } } }
```

- `devices` is keyed by device id: the kind for the first device of a kind
  (`lovense`, `coyote-v2`, `coyote-v3`, `tcode`, `piupiu`), `<kind>:2`,
  `<kind>:3`, … for further ones (`"coyote-v3:2": { … }`); `mapping` by script
  channel id (lowercase; `stroke` = the main axis). Every device has its own
  entry: a second Coyote never uses the first one's, and without an entry it
  uses its driver's default.
- An entry is `{ target, invert?, min?, max? }` (min/max 0–100, default 0 and
  100). Fields left out come from the device's default for that channel, so
  `{ "invert": true }` inverts the default target; `"target": "off"` switches
  the channel off for that device. Channels not listed keep the default.
- `options` holds per-scene options of a device (TCode: `generate`, the
  per-scene *Fill in missing axes* level). The tab shows them read-only.
- `offsetMs` is the scene offset.

**Migration from TCode Player.** When a scene has no `toysync_map` but a
`tcode_map`, it is converted when read (in memory): its per-channel
`{ axis, invert, min, max }` become `devices.tcode.mapping` entries
(`axis` → `target`; TCode names like `R1` become channel `r1`; entries without
`axis` keep the default axis), its `offsetMs` the scene offset and its
`generate` `devices.tcode.options.generate` (the first TCode device). TCode Player's older per-file
form (`{ "files": { "<oshash>": … } }`) uses the entry of the scene's first
file (by oshash, then md5), else the first one. Save writes `toysync_map`;
`tcode_map` is never written or removed. Use defaults + Save removes
`toysync_map`, except while the scene still has a `tcode_map`: then an empty
`toysync_map` is written, so the old mapping doesn't come back on the next
read.

## Several devices of one kind

Every device Toy Sync drives is a *device* entry of this browser, by
default one per kind. **Add another …** on `/toysync` adds one more of that
kind (two Coyotes, two Lovense toys, two TCode strokers, …).

- **Ids.** The first device of a kind has the kind as its id (`coyote-v3`),
  so everything saved before stays valid; further ones are `coyote-v3:2`,
  `coyote-v3:3`, … (the lowest free number). Scene mappings and calibration
  links use these ids, so they mean the same device in every browser that
  set up its devices the same way.
- **Names.** Each device has a name (default: the driver's name, then
  "… 2", "… 3"); rename it on its card. Menus, the bar and the scene tab use
  it.
- **Per browser.** Which devices exist and their names live in this
  browser's localStorage (`toysync.instances`), because the hardware belongs
  to the machine. Without an entry there is one device per kind.
- **Own device, own mapping.** Each device remembers its own physical
  device and reconnects only that one: the first under the key used before
  (`lovense.device`, `toysync.coyote-v3.device`, `toysync.tcode.port`,
  `toysync.piupiu.device`), the others under `<that key>.<device id>`.
  Only the first falls back to a granted device found by its Bluetooth name
  (or TCode Player's remembered port / launcher), and a Coyote only when that
  name is unambiguous: with two granted Coyotes and nothing remembered, the
  browser's picker lets you choose. Each device has its own
  per-scene mapping and, for TCode, its own profile (the first in the plugin
  setting `tcodeProfile`, further ones in `tcodeProfiles`, a JSON object by
  device id; a new one starts from the defaults).
- **One at a time.** Devices set their Bluetooth links up one after another:
  a second one waits ("Waiting for another device to finish connecting…"),
  because two simultaneous connects make some Bluetooth stacks hang. A
  Coyote that doesn't answer within 20 s is given up (and retried); clicking
  Connect on a device stuck connecting starts over, and so does a click when
  the Bluetooth picker has been pending for a few seconds without showing
  (a double-click doesn't open two).
- **Never twice.** A physical device is held by one Toy Sync device at a
  time: reconnecting skips devices another one holds, and picking one that
  is already connected elsewhere is refused (`Already connected as "…"`).
  Web Serial has no id that tells two identical boards apart, so two TCode
  devices remember the board type and each takes the first matching port
  that isn't open yet.
- **Remove** disconnects the device (0 first), forgets which physical
  device it was and frees it; its calibration stays stored (per physical
  device), scenes keep its saved mapping. The first device of a kind can't
  be removed.
- Nudges, *Stop*, *Stop all* and the gain reach every device.

## How the script becomes output

The funscript is fetched from stash (`/scene/{id}/funscript`, relative to
stash's base URL) for scenes marked interactive. Self-timed devices (TCode,
PiuPiu) read the script and the video's position themselves. For the others,
every ~50 ms the plugin turns the script into a **frame** for this instant,
one per device from that device's mapping (the default mapping gives
every device the same frame), which each device reads in its own way:

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

With the per-scene mapping, a target is fed by the channel mapped to it (after
its invert and min/max window): the main stroke gives its mode-dependent
intensity for intensity / a / b, its depth for balance and its speed for
speed; any other channel gives its position / 100. The **Auto** target (the
default for the stroke on e-stim devices) feeds intensity, balance and speed
from the stroke as above, each only while no other channel is mapped to it.

**Gain** from other plugins multiplies intensity, `a` and `b`, never balance
or speed.

**Snap pulses:** if the funscript has a `snap` axis, each rising edge lifts
intensity (and `a` / `b`) to full for 300 ms (× gain), at most 3 pulses per
second.

**Latency:** the script is read *Latency compensation* ms plus the scene
offset ahead of the video (positive values make the devices run earlier, to
make up for Bluetooth lag).

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
  // { devices: [{ instanceId: "coyote-v3" | "coyote-v3:2" | …, name: "Left",
  //               kind: "lovense" | "coyote-v2" | "coyote-v3" | "tcode" | "piupiu", id,
  //               status: { connection: "disconnected" | "connecting" | "connected" | "error",
  //                         device?, battery?, message?, output?: { a, b? }, needsCalibration? } }],
  //   frame: { intensity, balance, speed, a?, b?, gain? } | null,   // null = silence
  //   gain: 0..1 }
});
```

`devices` has one entry per device, also several of one kind;
`instanceId` is the device id (see *Several devices of one kind*), `name`
its name, `id` the physical device. Dispatched whenever a device's status
(or name), the gain, or silence/output changes;
changes of the output alone (frame values, meters) at most 5 times per
second, the latest always delivered.

**API**

```js
window.stashToySync.version            // 2
window.stashToySync.status()           // the status object above
window.stashToySync.connect("lovense") // from a click handler: may open the Bluetooth picker
window.stashToySync.connect("coyote-v3:2") // a device id works too; a kind means its first device
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
- **Self-timed devices** (TCode, PiuPiu) follow the same rules from their
  own clock: they get no program while no scene with a script is open, and
  Stop, Stop all, leaving the scene and closing the tab stop them too.
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
`onSettings(cb)`, `timers`, `now`, and per device:

- `instance`: `{ id, name, ordinal }` (`"coyote-v3:2"`, its current name, 2;
  ordinal 1 = the first of its kind). Keep anything remembered per device
  apart with `instanceStorageKey(key, ctx.instance)` from
  `src/devices/instances.ts` (the first keeps `key`, so upgrades forget
  nothing).
- `claims`: the page-wide registry of which device holds which physical
  device (`isClaimed(key, byInstance?)`, `claim(key, instanceId)`,
  `release(key, instanceId)`; `src/devices/claims.ts`, `instanceClaims()`
  binds it to one instance). Claim the physical id when picking a device,
  release it on disconnect and dispose, skip devices another instance holds
  when reconnecting on your own, and refuse a picked one with
  `alreadyConnectedMessage(name)`.

The `DeviceManager` calls the factory once per device of that kind, calls
`drive(frame | null)` from every engine tick (about every 50 ms while a
scene plays, plus right away on pause, seek and gain changes; not at all
while no scene page is open), fans nudges and stops out, and retries a
dropped link with `resume()` unless the driver sets `selfReconnects`. `src/devices/estim.ts` (`channelIntensities`,
`channelLevels`, `estimFrequencyHz`) and `src/devices/calibration.ts`
(`levelFor`, `validateCalibration`, `loadCalibration` / `saveCalibration`)
hold the shared e-stim maths and storage.

**Optional members** (all in `src/devices/types.ts`):

| Member | Used by |
| --- | --- |
| `mappingTargets()` → `{ id, label, group? }[]` | the Interactive tab's target picker (grouped by `group`) |
| `defaultMapping(channels)` → `{ [channelId]: { target, invert?, min?, max? } }` | the mapping of channels a scene doesn't override; without it DriveFrame devices get the built-in one from *Axis mapping*, self-timed devices start with everything off |
| `actions()` → `{ id, label, run() }[]` | buttons in the navbar menu and on the device's card (TCode: Home, Motion on/off) |
| `settingsPanel` (React component, props `{ device }`) | rendered in the device's card on `/toysync` |
| `preview` (React component, props `{ device, program }`) | rendered in the device's section of the Interactive tab (`program` is the device's `DeviceProgram` or null) |
| `testChannel(channelId)` | the Interactive tab's per-channel Test button; without it the button calls `test()` |
| `forget()` | removing a device on `/toysync`: drop the remembered physical device (called after `disconnect()`, before `dispose()`) |

**Self-timed devices** (`selfTimed: true`, `SelfTimedDevice`) time their own
output (TCode sends every 10–20 ms) and never get frames. Instead the manager
calls `setProgram(program)` when a scene with a script opens, whenever the
program changes (a live edit in the Interactive tab, a different script, the
device's options), and `setProgram(null)` when the scene closes or has no
script; an unchanged program isn't sent again. A `DeviceProgram` is
`{ sceneId, clock, channels, mapping, options?, gain() }` (mapping and options
are that device's own): `channels` are
every `ScriptChannel` of the funscript (`stroke` with the file's `range`
applied and its `inverted` flag kept as `inverted`; embedded axes with their
own range/inverted applied by the parser), `mapping` the device's effective
mapping without the channels that are off. `clock` is a `PlaybackClock`:
`scriptMs()` = video time (video.js time when available) × 1000 + scene offset
+ *Latency compensation*, undefined without a video; `playing()`; and
`onChange(cb)` with `play`, `pause` (also on waiting), `seek` (also when the
scene offset changes), `ended` and `scene`. It is cheap to call at 100 Hz.
`stopNow()`, `nudge()`, `test()` and `disconnect()` reach self-timed devices
like any other; on pause, seek and stop they must output nothing until the
clock plays again.

**Plugin settings of a driver** go through `src/stash/pluginConfig.ts`:
`readPluginConfig(id)`, `mergePluginConfig(id, patch)` (stash's
`configurePlugin` replaces a plugin's whole map, so this reads, merges and
writes, one merge at a time; a key set to `undefined` is removed) and
`readOtherPluginConfig("TCodePlayer")` for a one-time import. Keep structured
values as JSON strings.

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
