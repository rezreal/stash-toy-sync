#!/usr/bin/env bash
# Builds dist/ - a stash package source: the plugin zip plus the index.yml that
# advertises it. Point stash at the published index.yml under
# Settings > Plugins > Available Plugins > Add Source.
#
# Needs node (for the bundle) and python3.
set -euo pipefail

ID="toysync"
NAME="Toy Sync"
DESC="Drives Lovense vibrators and other Bluetooth toys (e-stim drivers plug in) from the scene's funscript while it plays in stash's scene player."

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIST="$ROOT/dist"

VERSION="$(sed -n 's/^version: *//p' "$ROOT/plugin/$ID.yml" | tr -d '"' | head -1)"
[ -n "$VERSION" ] || { echo "could not read version from plugin/$ID.yml" >&2; exit 1; }

(cd "$ROOT" && node build.mjs)

rm -rf "$DIST"
mkdir -p "$DIST"

ID="$ID" NAME="$NAME" DESC="$DESC" VERSION="$VERSION" ROOT="$ROOT" DIST="$DIST" python3 <<'PY'
import hashlib, os, time, zipfile

ID, DIST, ROOT = os.environ["ID"], os.environ["DIST"], os.environ["ROOT"]

# stash writes each zip entry verbatim under plugins/<id>/, so the zip has to be
# flat - a wrapping directory would nest as plugins/<id>/<id>/...
members = [
    (f"{ROOT}/plugin/{ID}.yml", f"{ID}.yml"),
    (f"{ROOT}/plugin/{ID}.js",  f"{ID}.js"),
    (f"{ROOT}/plugin/{ID}.css", f"{ID}.css"),
    (f"{ROOT}/README.md",       "README.md"),
]

zpath = f"{DIST}/{ID}.zip"
with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as z:
    for src, name in members:
        if not os.path.exists(src):
            raise SystemExit(f"missing {src}")
        # fixed timestamp so an unchanged build produces an unchanged sha256
        info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o644 << 16
        with open(src, "rb") as f:
            z.writestr(info, f.read())

sha = hashlib.sha256(open(zpath, "rb").read()).hexdigest()
date = os.environ.get("SOURCE_DATE") or time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime())

with open(f"{DIST}/index.yml", "w") as f:
    f.write(
        f"- id: {ID}\n"
        f"  name: {os.environ['NAME']}\n"
        f"  version: {os.environ['VERSION']}\n"
        f"  date: {date}\n"
        f"  path: {ID}.zip\n"
        f"  sha256: {sha}\n"
        f"  metadata:\n"
        f"    description: {os.environ['DESC']}\n"
    )

print(f"built {zpath}  ({os.environ['VERSION']}, sha256 {sha[:12]}...)")
PY
