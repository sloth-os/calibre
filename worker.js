/*
 * worker.js — Pyodide host worker for the calibre WASM conversion engine.
 *
 * MESSAGE PROTOCOL (module worker — pyodide rejects classic workers):
 *   main -> worker: {id, type:'init'}
 *                   | {id, type:'convert', name, input: ArrayBuffer,
 *                      outputFormat, options?: {...}}
 *                   | {id, type:'formats'}
 *                   | {id, type:'metadata', name, input: ArrayBuffer}
 *                   | {type:'evict'}
 *   worker -> main: {id, type:'ready'} | {id, type:'boot-progress', stage, pct}
 *                   | {id, type:'convert-result', name, data: ArrayBuffer, size, log: [...]}
 *                   | {id, type:'formats-result', input: [...], output: [...]}
 *                   | {id, type:'metadata-result', metadata: {...}}
 *                   | {id, type:'error', message, log?: [...]}
 *                   | {id, type:'progress', line} (calibre log lines)
 *
 * BOOT SEQUENCE (the slow part, reported via boot-progress):
 *   1. dynamic import() of pyodide.mjs; loadPyodide (indexURL ./wasm/pyodide/)
 *   2. fetch calibre-bundle.zip (~25 MB, served from the SW cache when
 *      offline), stage it into MEMFS via Python's zipfile
 *   3. set sys.paths/resources/extensions locations, import the plumber
 *   4. report 'ready'
 *
 * Conversions run one at a time (the engine keeps global state in
 * /tmp-scoped dirs); a queue in the dispatch loop serializes them.
 *
 * Node-testable by contract: uses ONLY self.onmessage, self.postMessage,
 * dynamic import(), fetch, and JS built-ins.
 */
'use strict';

// ESM entry on purpose: pyodide (>= 0.28 / 3xx releases) throws "Classic web
// workers are not supported" when it detects importScripts in a browser
// worker, so this file runs as a MODULE worker (app.js spawns it with
// { type: 'module' }) and loads pyodide via dynamic import().
var PYODIDE_MJS_URL = './wasm/pyodide/pyodide.mjs';
var BUNDLE_URL = './wasm/calibre-bundle.zip';

var pyodide = null;      // pyodide API object once loaded
var engineReady = false; // plumber imported
var initPromise = null;  // single-flight boot
var busy = false;        // one conversion at a time
var inbox = [];          // queued messages while busy

function post(msg) {
  self.postMessage(msg);
}

// ------------------------------------------------------------------ boot ---

var BOOT_PYTHON = null; // set lazily below (large string)

function loadPyodideApi() {
  // Absolute specifier (https: in the browser, file: in the Node harness).
  return import(new URL(PYODIDE_MJS_URL, self.location.href).href).then(function (mod) {
    if (!mod || typeof mod.loadPyodide !== 'function') {
      throw new Error('loadPyodide is not exported by ' + PYODIDE_MJS_URL);
    }
    // Exposed on globalThis exactly like the old UMD importScripts did, so
    // the Node test harness can intercept the assignment (indexURL fixup).
    globalThis.loadPyodide = mod.loadPyodide;
    return globalThis.loadPyodide({
      indexURL: new URL('./wasm/pyodide/', self.location.href).href,
      stdout: function (line) { post({ type: 'progress', line: line }); },
      stderr: function (line) { post({ type: 'progress', line: line }); },
    });
  });
}

function fetchArrayBuffer(url) {
  return fetch(url).then(function (resp) {
    if (!resp || !resp.ok) {
      throw new Error('fetch(' + url + ') failed: HTTP ' + (resp && resp.status));
    }
    return resp.arrayBuffer();
  });
}

function boot() {
  post({ type: 'boot-progress', stage: 'pyodide', pct: 5 });
  return loadPyodideApi().then(function (py) {
    pyodide = py;
 post({ type: 'boot-progress', stage: 'bundle', pct: 35 });
    return fetchArrayBuffer(BUNDLE_URL);
  }).then(function (bundleBytes) {
    pyodide.FS.writeFile('/calibre-bundle.zip', new Uint8Array(bundleBytes));
    post({ type: 'boot-progress', stage: 'extract', pct: 55 });
    return pyodide.runPythonAsync(BOOT_PYTHON);
  }).then(function () {
    engineReady = true;
    post({ type: 'boot-progress', stage: 'ready', pct: 100 });
  });
}

function ensureInit() {
  if (!initPromise) {
    initPromise = boot().catch(function (e) {
      initPromise = null; // allow retry on the next message
      throw e;
    });
  }
  return initPromise;
}

// --------------------------------------------------------------- python ----

// The python side of the worker. Stage the bundle, import the engine, and
// expose convert_file() / list_formats() / read_metadata() as globals the
// dispatch loop calls via pyodide.runPython. All I/O is in MEMFS under
// /work; nothing touches the network.
BOOT_PYTHON = String.raw`
import os, sys, time, json, zipfile, traceback

t0 = time.time()
def _stage(msg):
    print(f'[boot:{time.time()-t0:.1f}s] {msg}', flush=True)

BUNDLE = '/calibre-bundle.zip'
WORK = '/work'

_stage('extracting bundle')
with zipfile.ZipFile(BUNDLE) as zf:
    zf.extractall('/site')
os.remove(BUNDLE)

# sys.path in pyodide is a _NamespacePath, not a plain list — assign a new
# list rather than mutating in place. (Bundle layout: src/, shims/,
# vendor/, resources/ — created by patches/build-bundle.sh.)
sys.path = ['/site/src', '/site/shims', '/site/vendor'] + list(sys.path)

# Resolution canary: the bundle EXCLUDES calibre's autogenerated src/qt/
# (a lazy PyQt6 loader stub that shadows our Pillow-backed shim whenever
# src/ precedes shims/ on sys.path — that shadowing broke every cover path
# with "ImportError: cannot import name 'QBuffer' from 'qt.core'"). Import
# qt eagerly so a future packaging mistake fails HERE, with the resolved
# file in the boot log, instead of surfacing mid-conversion.
import qt.core
_stage(f'qt.core: {qt.core.__file__}')
if not str(qt.core.__file__).startswith('/site/shims/'):
    # Hard-fail the boot instead of letting the stub shadow the shim: with
    # src/qt/ present, every image path dies mid-conversion with
    # "ImportError: cannot import name 'QBuffer'" — and calibre swallows some
    # of those failures into its log, so covers silently vanish. A loud boot
    # error here is always better than a quiet one there.
    raise ImportError(
        f'qt.core resolved to {qt.core.__file__}, expected the Pillow-backed '
        'shim under /site/shims/ — a packaging regression re-included '
        "calibre's autogenerated src/qt stub (see the rsync excludes in "
        'patches/build-bundle.sh).')

# calibre.constants reads these AT IMPORT — set them before importing calibre.
sys.resources_location = '/site/resources'
sys.extensions_location = '/site/src/calibre/plugins'
os.environ['CALIBRE_CONFIG_DIRECTORY'] = '/home/calibre-config'
os.makedirs('/home/calibre-config', exist_ok=True)
os.makedirs(WORK, exist_ok=True)

# The shims ship module-level overrides for calibre itself (calibre.gui2)
# and calibre_extensions.* — both are packages whose __path__ must include
# the shims tree or the real calibre-src package wins on every submodule
# import (package __path__ is consulted before sys.path for submodules).
import calibre
calibre.__path__ = ['/site/shims/calibre'] + list(calibre.__path__)

_stage('importing calibre')
from calibre import __version__ as CALIBRE_VERSION
_stage(f'calibre {CALIBRE_VERSION} imported')
from calibre.ebooks.conversion.plumber import Plumber
_stage('plumber imported')
from calibre.customize.ui import available_input_formats, available_output_formats, plugin_for_input_format, plugin_for_output_format
from calibre.ebooks.metadata.meta import get_metadata
_stage('engine ready')

SUPPORTED_INPUT = frozenset(available_input_formats())
SUPPORTED_OUTPUT = frozenset(available_output_formats())

# Formats whose engines cannot run in wasm (native code we do not ship).
WASM_UNSUPPORTED_INPUT = frozenset({
    'pdf',      # pdftohtml external binary
    'lit',      # lzx/msdes C extensions
    'djvu', 'djv',  # bzzdec C extension
    'chm',      # pychm C extension
    'recipe', 'downloaded_recipe',  # network + worker processes
    'rar', 'cbr', 'cb7', 'cbc',
    'cbz',      # comic input renders pages through ParallelJob threads
                # (threading is unavailable in wasm: "can't start new thread")
})
WASM_UNSUPPORTED_OUTPUT = frozenset({
    'pdf',      # QtWebEngine
    'lit',      # lzx/msdes
})

def list_formats():
    ins = sorted(f for f in SUPPORTED_INPUT if f not in WASM_UNSUPPORTED_INPUT)
    outs = sorted(f for f in SUPPORTED_OUTPUT if f not in WASM_UNSUPPORTED_OUTPUT)
    return json.dumps({'input': ins, 'output': outs, 'version': CALIBRE_VERSION})

_seq = 0
def convert_file(name, data, output_format, options=None):
    """Convert bytes -> (output_name, output_bytes, log_lines)."""
    global _seq
    _seq += 1
    jid = _seq
    indir = f'{WORK}/in{jid}'
    os.makedirs(indir, exist_ok=True)
    inpath = os.path.join(indir, name)
    outname = os.path.splitext(name)[0] + '.' + output_format
    outpath = os.path.join(indir, outname)
    with open(inpath, 'wb') as f:
        f.write(data)

    from calibre.utils.logging import Log
    log = Log(level=Log.WARN)
    lines = []
    orig_print = print
    try:
        plumber = Plumber(inpath, outpath, log=log)
        if options:
            for k, v in options.items():
                setattr(plumber.options, k, v)
        plumber.run()
        with open(outpath, 'rb') as f:
            out = f.read()
        return json.dumps({'ok': True, 'name': outname, 'data': out.hex(), 'log': lines})
    except Exception as e:
        tb = traceback.format_exc()
        return json.dumps({'ok': False, 'error': f'{type(e).__name__}: {e}', 'traceback': tb})
    finally:
        import shutil
        shutil.rmtree(indir, ignore_errors=True)

def read_metadata(name, data):
    """Read ebook metadata (title/authors/...) from bytes."""
    import io
    ext = os.path.splitext(name)[1].lstrip('.').lower()
    try:
        mi = get_metadata(io.BytesIO(data), ext)
        md = {
            'title': mi.title or '',
            'authors': list(mi.authors or []),
            'language': mi.language or '',
            'series': mi.series or '',
            'comments': (mi.comments or '')[:2000],
        }
        return json.dumps({'ok': True, 'metadata': md})
    except Exception as e:
        return json.dumps({'ok': False, 'error': f'{type(e).__name__}: {e}'})
`;

// ---------------------------------------------------------------- dispatch --

function pyCall(code) {
  // runPythonAsync everywhere: after the async boot, sync runPython can
  // deadlock on pyodide's event loop in worker contexts; the async form
  // pumps the loop and behaves identically for these short calls.
  return pyodide.runPythonAsync(code);
}

self.onmessage = function (ev) {
  var msg = ev.data;
  if (!msg || typeof msg !== 'object') return;
  if (busy && msg.type !== 'init') {
    inbox.push(msg);
    return;
  }
  dispatch(msg);
};

function pumpQueue() {
  if (busy || inbox.length === 0) return;
  var next = inbox.shift();
  busy = true;
  dispatchBusy(next);
}

function dispatch(msg) {
  ensureInit().then(
 function () {
      if (msg.type === 'init') {
        post({ id: msg.id, type: 'ready' });
        return;
      }
      busy = true;
      dispatchBusy(msg);
    },
    function (err) {
      post({ id: msg.id, type: 'error', message: 'boot failed: ' + (err && err.message ? err.message : err) });
    }
  );
}

function dispatchBusy(msg) {
  Promise.resolve()
    .then(function () {
      switch (msg.type) {
        case 'formats':
          return pyCall('list_formats()').then(function (jsonStr) {
            var fmts = JSON.parse(jsonStr);
            post({
              id: msg.id,
              type: 'formats-result',
              input: fmts.input,
              output: fmts.output,
              version: fmts.version,
            });
          });
        case 'convert':
          return runConvert(msg);
        case 'metadata':
          return runMetadata(msg);
        case 'evict':
          return undefined; // work dirs are per-job; nothing persistent to evict
        default:
          post({ id: msg.id, type: 'error', message: 'Unknown message type: ' + String(msg.type) });
          return undefined;
      }
    })
    .catch(function (e) {
      post({ id: msg.id, type: 'error', message: e && e.message ? e.message : String(e) });
    })
    .then(function () {
      busy = false;
      pumpQueue();
    });
}

function runConvert(msg) {
  var name = String(msg.name || 'book');
  var fmt = String(msg.outputFormat || 'epub').toLowerCase();
  var bytes = new Uint8Array(msg.input);
  var hex = '';
  var CHUNK = 0x8000;
  for (var i = 0; i < bytes.length; i += CHUNK) {
    hex += bytesToHex(bytes.subarray(i, i + CHUNK));
  }
  var optsJson = msg.options ? JSON.stringify(msg.options) : 'None';
  var code = 'convert_file(' + JSON.stringify(name) + ', bytes.fromhex(' + JSON.stringify(hex) + '), ' +
 JSON.stringify(fmt) + ', ' + optsJson + ')';
  return pyodide.runPythonAsync(code).then(function (resultJson) {
    var res = JSON.parse(resultJson);
    if (!res.ok) {
      post({ id: msg.id, type: 'error', message: res.error, log: res.log || [] });
      return;
    }
    var outBytes = hexToBytes(res.data);
    post({
      id: msg.id,
      type: 'convert-result',
      name: res.name,
      data: outBytes.buffer,
      size: outBytes.length,
      log: res.log || [],
    });
  });
}

function runMetadata(msg) {
  var name = String(msg.name || 'book');
  var bytes = new Uint8Array(msg.input);
  var hex = '';
  var CHUNK = 0x8000;
  for (var i = 0; i < bytes.length; i += CHUNK) {
    hex += bytesToHex(bytes.subarray(i, i + CHUNK));
  }
  var code = 'read_metadata(' + JSON.stringify(name) + ', bytes.fromhex(' + JSON.stringify(hex) + '))';
  return pyodide.runPythonAsync(code).then(function (resultJson) {
    var res = JSON.parse(resultJson);
    if (!res.ok) {
      post({ id: msg.id, type: 'error', message: res.error });
      return;
    }
    post({ id: msg.id, type: 'metadata-result', metadata: res.metadata });
  });
}

function bytesToHex(u8) {
  var hex = [];
  for (var i = 0; i < u8.length; i++) {
    hex.push((u8[i] >>> 4).toString(16));
    hex.push((u8[i] & 15).toString(16));
  }
  return hex.join('');
}

function hexToBytes(hex) {
  var out = new Uint8Array(hex.length >> 1);
  for (var i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}
