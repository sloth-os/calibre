#!/usr/bin/env bash
# Build the calibre wasm bundle for the web app.
#
# Usage: build-bundle.sh <calibre-clone> <out-dir> [workdir]
#
# Produces in <out-dir>:
#   calibre-bundle.zip   site tree: patched src + shims + vendor wheels + resources
#   bundle-info.json     calibre version, upstream commit, pyodide version
#   pyodide/             the pyodide core distribution (js + wasm + stdlib)
#
# The bundle zip is fetched by the worker at runtime, unpacked into MEMFS,
# and booted. Wheels come from <workdir>/wheels (pure-python wheels from
# PyPI + wasm wheels from the pyodide CDN; see fetch-vendor-wheels.py).
set -euo pipefail

CALIBRE="$(readlink -f "${1:?usage: build-bundle.sh <calibre-clone> <out-dir> [workdir]}")"
OUT="$(readlink -f "${2:?usage: build-bundle.sh <calibre-clone> <out-dir> [workdir]}")"
WORK="${3:-$(mktemp -d)}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"   # patches/ dir
PYODIDE_VERSION="314.0.7"

echo "== calibre wasm bundle build =="
echo "calibre clone: $CALIBRE"
echo "output:        $OUT"
echo "workdir:       $WORK"

mkdir -p "$OUT" "$WORK/stage" "$WORK/pyodide"

# ---- 1. pyodide core -------------------------------------------------------
if [ ! -f "$WORK/pyodide/pyodide/pyodide.js" ]; then
    echo "-- fetching pyodide-core $PYODIDE_VERSION"
    curl -sL --retry 3 -o "$WORK/pyodide-core.tar.bz2" \
        "https://github.com/pyodide/pyodide/releases/download/${PYODIDE_VERSION}/pyodide-core-${PYODIDE_VERSION}.tar.bz2"
    tar xjf "$WORK/pyodide-core.tar.bz2" -C "$WORK/pyodide"
fi
rm -rf "$OUT/pyodide"
mkdir -p "$OUT/pyodide"
cp "$WORK"/pyodide/pyodide/{pyodide.js,pyodide.mjs,pyodide.asm.mjs,pyodide.asm.wasm,python_stdlib.zip,pyodide-lock.json,package.json} "$OUT/pyodide/"
echo "pyodide core staged ($(du -sh "$OUT/pyodide" | cut -f1))"

# ---- 2. vendor wheels ------------------------------------------------------
if [ ! -d "$WORK/vendor/wheels" ]; then
    echo "-- fetching vendor wheels"
    python3 "$HERE/fetch-vendor-wheels.py" "$WORK/vendor/wheels" "$PYODIDE_VERSION"
fi

# ---- 3. stage calibre src (patched) ----------------------------------------
echo "-- staging calibre source"
rm -rf "$WORK/stage/src"
mkdir -p "$WORK/stage/src"
# src/ top-level packages only; no .git, no tests dirs that ship separately
rsync -a --exclude='.git' --exclude='__pycache__' "$CALIBRE/src/" "$WORK/stage/src/"
python3 "$HERE/apply-patches.py" "$WORK/stage/src"

# ---- 4. resources ----------------------------------------------------------
echo "-- staging resources"
rm -rf "$WORK/stage/resources"
mkdir -p "$WORK/stage/resources"
rsync -a "$CALIBRE/resources/" "$WORK/stage/resources/"
# generated localization data (iso639/iso3166 .calibre_msgpack)
if [ ! -f "$WORK/iso-codes.zip" ]; then
    echo "-- downloading iso-codes data"
    curl -sL --retry 5 -C - -o "$WORK/iso-codes.zip" "https://download.calibre-ebook.com/iso-codes.zip"
fi
CALIBRE_WASM_WHEELS_DIR="$WORK/vendor/wheels" python3 "$HERE/build-resources.py" "$CALIBRE" "$WORK/stage/resources" "$WORK/iso-codes.zip"
# Liberation fonts (cover generator faces; same tarball calibre's build vendors)
if [ ! -d "$WORK/stage/resources/fonts/liberation" ]; then
    echo "-- fetching Liberation fonts"
    mkdir -p "$WORK/stage/resources/fonts/liberation"
    curl -sL --retry 5 -o "$WORK/liberation.tar.gz" \
        "https://github.com/liberationfonts/liberation-fonts/files/7261482/liberation-fonts-ttf-2.1.5.tar.gz"
    tar xzf "$WORK/liberation.tar.gz" -C "$WORK" --strip-components=1 \
        --wildcards '*/LiberationSerif-Regular.ttf' '*/LiberationSans-Regular.ttf' \
        '*/LiberationMono-Regular.ttf' '*/LiberationSerif-Bold.ttf' '*/LiberationSans-Bold.ttf'
    cp "$WORK"/Liberation*.ttf "$WORK/stage/resources/fonts/liberation/"
fi

# ---- 5. unpack wheels into the bundle tree ---------------------------------
echo "-- unpacking wheels"
rm -rf "$WORK/stage/vendor"
mkdir -p "$WORK/stage/vendor"
python3 - "$WORK/vendor/wheels" "$WORK/stage/vendor" <<'PY'
import sys, zipfile, os
wheels_dir, dest = sys.argv[1], sys.argv[2]
for name in sorted(os.listdir(wheels_dir)):
    if name.endswith('.whl'):
        with zipfile.ZipFile(os.path.join(wheels_dir, name)) as zf:
            zf.extractall(dest)
print(f'unpacked {len([n for n in os.listdir(wheels_dir) if n.endswith(".whl")])} wheels')
PY

# ---- 6. shims ---------------------------------------------------------------
echo "-- staging shims"
rm -rf "$WORK/stage/shims"
cp -R "$HERE/../shims" "$WORK/stage/shims"

# ---- 7. zip the bundle ------------------------------------------------------
echo "-- zipping bundle"
rm -f "$OUT/calibre-bundle.zip"
python3 - "$WORK/stage" "$OUT/calibre-bundle.zip" <<'PY'
import os, sys, zipfile
stage, out = sys.argv[1], sys.argv[2]
n = 0
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
    for root, dirs, files in os.walk(stage):
        dirs[:] = [d for d in dirs if d != '__pycache__']
        for f in files:
            p = os.path.join(root, f)
            zf.write(p, os.path.relpath(p, stage))
            n += 1
print(f'bundle: {n} files -> {out} ({os.path.getsize(out)/1e6:.1f} MB)')
PY

# ---- 8. bundle info ---------------------------------------------------------
CALIBRE_VERSION="$(python3 -c "
import re, sys
m = re.search(r'numeric_version\s*=\s*\(([^)]*)\)', open('$CALIBRE/src/calibre/constants.py').read())
print('.'.join(x.strip() for x in m.group(1).split(',')))
")"
CALIBRE_COMMIT="$(git -C "$CALIBRE" rev-parse HEAD)"
cat > "$OUT/bundle-info.json" <<EOF
{
  "version": "$CALIBRE_VERSION",
  "commit": "$CALIBRE_COMMIT",
  "pyodide": "$PYODIDE_VERSION",
  "builtAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
cat "$OUT/bundle-info.json"

echo "== bundle build complete =="
ls -la "$OUT"
