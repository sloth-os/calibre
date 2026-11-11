# calibre-web — architecture

## What this repository is

A publishing overlay that runs calibre's ebook-conversion engine in the
browser via Pyodide (CPython 3.14 → WebAssembly), built weekly from the
upstream calibre clone at ~/software/calibre (sloth-os/calibre mirror of
kovidgoyal/calibre) and deployed to GitHub Pages as an offline-capable PWA.

## Why Pyodide

calibre has no wasm build and no emscripten toolchain support: its C
extensions link against Qt/ICU/podofo/ffmpeg native libraries. But the
conversion engine (calibre.ebooks.conversion.plumber + plugins) is a
pure-Python pipeline whose native needs reduce to a small set of C
extensions with pure-Python equivalents or acceptable approximations.
Pyodide ships CPython 3.14 as wasm (matching calibre's requires-python
>= 3.14) plus prebuilt wasm wheels for the C-extension dependencies
(lxml, regex, Pillow, msgpack, pycryptodome, fonttools).

## Layout

```
.github/workflows/publish.yml    weekly build + Pages deploy (the heart)
.github/scripts/build-bundle.sh  assemble the wasm payload (src+shims+wheels+resources)
.github/scripts/apply-patches.py calibre source patches for wasm (kept minimal)
.github/scripts/wasm-smoke-test.mjs  Node roundtrip: TXT->EPUB->AZW3->MOBI
.github/scripts/generate-sw-manifest.mjs  precache list + cache version
shims/calibre_extensions/        pure-Python C-extension shims (icu, speedup, ...)
shims/qt/                        Pillow-backed qt.core stand-in
shims/html5_parser/ lxml-based html5-parser stand-in
app.js / index.html              UI (no frameworks, no external resources)
worker.js                        Web Worker hosting the Pyodide runtime
sw.js / offline.html / manifest.webmanifest  PWA / offline layer
icons/                           PWA icons
tests/                           Node-run contract tests (PWA, shims, SW)
wasm/                            build output — gitignored; CI generates it
```

## The wasm payload (wasm/)

CI assembles (see build-bundle.sh):
  pyodide-*.tar.bz2     the pyodide core distribution (runtime + stdlib)
  calibre-bundle.tar.xz src tree (patched) + shims + vendor wheels + resources
  bundle-info.json      calibre version, upstream commit, build stamp

The worker stages the bundle into MEMFS at boot: /site/vendor (wheels),
/site/shims, /site/calibre-src, /site/resources, then imports calibre.

## C-extension shims

  speedup      barename/namespace/clean_xml_chars/parse_date/parse_iso8601/
               pread_all/O_CLOEXEC (pure Python, exact semantics from C)
  icu          collator (casefold key), case mapping, chr/ord, normalize
 tokenizer    init() raises -> tinycss pure-Python tokenizer; color3/4 parse
  fast_html_entities  HTML entity replacement (HTML5 numeric/named rules)
  cPalmdoc     Palmdoc compress/decompress (ported; py_compress_doc is
               calibre's own reference implementation)
  translator   .mo catalog parser (GNU gettext format)
  uchardet     encoding detection via chardet wheel
  html5_parser lxml-based parse() for the OEB HTML pipeline
  qt           Pillow-backed QImage/QPainter/QFont/QImageReader/Writer

Formats deliberately unavailable: PDF output (QtWebEngine), LIT/DJVU/CHM
(lzx/bzzdec/pychm native). The app's format list reflects this.

## PWA

- manifest.webmanifest: standalone, file_handlers for every supported
  ebook extension (open-with on desktop Chromium)
- share_target: Android share sheet (files stashed by sw.js in a fixed
  cache, consumed on next load)
- sw.js: precache manifest generated at build (all assets + wasm payload),
  cache-first with versioned cache names, navigations network-first with
  offline fallback
- launchQueue: delivered files convert directly (PWA file handling)
