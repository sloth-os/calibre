# calibre WASM

[calibre](https://calibre-ebook.com)'s ebook conversion engine running entirely in your
browser via WebAssembly, published weekly to GitHub Pages as an installable,
offline-capable PWA. Convert EPUB, MOBI, AZW3, DOCX, TXT, HTML, FB2, ODT, RTF and
more — **no uploads, no server-side processing, works offline after the first load**.

**Live app: <https://sloth-os.github.io/calibre/>**

## How it works

calibre has no wasm build, so the engine is assembled at build time:

1. **Pyodide** (CPython 3.14 → WebAssembly — the same Python version calibre requires)
   provides the Python runtime, plus prebuilt wasm wheels for the C-extension
   dependencies (lxml, regex, Pillow, msgpack, pycryptodome).
2. **calibre's own source** (fetched fresh from upstream `kovidgoyal/calibre` every
   build) provides the actual conversion pipeline: `calibre.ebooks.conversion.plumber`
   — the same engine `ebook-convert` runs.
3. **Pure-Python shims** (`shims/`) stand in for the C extensions that cannot exist in
   a browser (no ICU, no Qt, no processes, no threads): collation, entity handling,
   encoding detection, a Pillow-backed `qt.core` for cover generation, and three
   small source patches for wasm constraints (documented in `patches/apply-patches.py`).

The worker (`worker.js`, an ES **module** worker — pyodide rejects classic workers
in browsers) fetches the bundle (~36 MB), unpacks it into the wasm filesystem, boots
calibre in ~10 s, and then converts ebooks entirely in memory.

### Format support

Everything calibre's plugin registry offers, **except** the formats whose engines are
native code that cannot run in a browser:

| | unavailable | why |
| --- | --- | --- |
| input | `pdf`, `lit`, `djvu`, `chm`, `recipe`, `rar`/`cbr` | pdftohtml binary, lzx/msdes, bzzdec, pychm, network+processes, unrar |
| output | `pdf`, `lit` | QtWebEngine rendering, lzx/msdes |

Everything else — EPUB, MOBI, AZW3, KEPUB, DOCX, HTMLZ, TXT, TXTZ, FB2, ODT, RTF,
PDB, PML, RB, SNB, TCR, OEB, ZIP/CBZ in — works, including generated covers.

### Output profiles

Besides the output format, the converter exposes calibre's **output profile**
chooser (the same "Page setup" dropdown as the desktop app): Default, Kindle and
every Kindle variant (PaperWhite, Voyage, Oasis, Scribe, Fire, DX), iPad, Kobo,
Nook, Sony Reader, PocketBook, generic e-ink, Tablet, and more. The profile tells
the engine how to optimize the output for a device — image rescaling to the
device screen, font-size mapping, and MOBI indexing. The list is enumerated at
runtime from calibre's own plugin registry (never hardcoded), so it always
matches the shipped engine; the chosen profile is echoed back after conversion
so an unsupported choice (which calibre silently falls back to Default) is
visible in the log.

## PWA / offline

- `manifest.webmanifest` names the app, icons, `standalone` display, and registers
  every supported ebook extension as `file_handlers` — so browsers offer
  "Install app" and, once installed, **"Open with › calibre"** for ebook files
  (PWA file handling).
- `sw.js` precaches the whole app (shell + engine bundle, versioned per build) and
  serves it cache-first: after one online visit the converter works with the network
  off.
- `share_target` (Android): share an ebook to the app; the service worker stashes it
  and the app converts it on next load.
- Launched files (open-with, double-click on a registered extension) arrive via
  `window.launchQueue` and convert exactly like dropped ones.

## Publishing

`.github/workflows/publish.yml` runs **every Monday 04:00 UTC** (and on push):

1. Resolves the latest upstream `kovidgoyal/calibre` master commit
   (or the `ref` you specify via `workflow_dispatch`).
2. Builds the wasm bundle: patched source + shims + vendor wheels + generated
   localization resources (`patches/build-bundle.sh`).
3. **Smoke-tests the actual bundle under Node**: boots the real worker and runs a
   real TXT→EPUB conversion with output validation (`tests/worker-integration.test.mjs`).
   A broken weekly build fails here instead of publishing.
4. Assembles the site and generates the service-worker precache manifest, then
   **gates the staged site before upload**: URL/layout contract checks derived from
   the sources themselves (`.github/scripts/check-site-layout.mjs`), the Node smoke
   re-run against the deployed geometry, and the whole site booted in headless
   Chromium (`tests/browser-smoke.test.mjs`) — the only gate that can see
   browser-only runtime guards and MIME handling.
5. Deploys to GitHub Pages.

`workflow_dispatch` with `skip_build: true` redeploys the site only, reusing the
bundle from the latest successful run (for UI fixes without a rebuild).

## Repository layout

| Path | Purpose |
| --- | --- |
| `index.html`, `app.js` | UI (no frameworks, no external resources) |
| `worker.js` | module Web Worker hosting the Pyodide runtime + calibre engine |
| `sw.js`, `offline.html`, `manifest.webmanifest` | PWA / offline / file-handling layer |
| `shims/` | pure-Python shims for calibre's C extensions + a Pillow-backed `qt.core` |
| `patches/build-bundle.sh` | assembles the wasm bundle (the heart of the build) |
| `patches/apply-patches.py` | the three minimal source patches for wasm (documented in place) |
| `patches/fetch-vendor-wheels.py` | wheels: pure-Python from PyPI, wasm builds from the pyodide CDN |
| `patches/build-resources.py` | generates the iso639/iso3166 resource files from iso-codes data |
| `.github/workflows/publish.yml` | weekly build & deploy pipeline |
| `tests/` | Node test suites + headless-Chromium browser smoke (worker integration drives the real bundle) |
| `icons/` | PWA icons (derived from calibre's logo) |
| `dev/` | local development scratch (gitignored) |

## Local development

```sh
# build the engine bundle (~36 MB output into /tmp/bundle-out)
./patches/build-bundle.sh /path/to/calibre /tmp/bundle-out

# run the tests (the worker integration boots the real engine)
node tests/run-all.mjs

# serve the site locally: build into ./wasm — build-bundle.sh's output
# layout (calibre-bundle.zip + pyodide/ side by side) IS the deployed
# geometry worker.js expects at the site root. Use the bundled dev server:
# worker.js is a module worker, and browsers reject module imports served
# with a non-JavaScript MIME type (python's http.server may).
./patches/build-bundle.sh /path/to/calibre ./wasm
cp wasm/bundle-info.json build-info.json   # version chip in the UI
node tests/serve.mjs 8080                  # http://localhost:8080

# optional: the real-browser smoke (headless Chromium boots the site and
# converts TXT->EPUB — catches browser-only guards the Node harness can't)
npm install --no-save playwright@1.65.0 && npx playwright install chromium
node tests/browser-smoke.test.mjs .
```

## License / attribution

calibre is GPL-3.0 © Kovid Goyal and contributors; its source is fetched from
upstream at build time. The shims, patches and web app in this repository are
GPL-3.0 as well. Pyodide (MPL-2.0) provides the Python runtime; vendored wheels
carry their own licenses (Pillow, lxml, css-parser, chardet, …).
