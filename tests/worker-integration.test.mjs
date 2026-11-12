#!/usr/bin/env node
/*
 * Worker integration test: drive the REAL worker.js against the REAL wasm
 * bundle the way a browser would — via the same message protocol the app
 * uses. Node stands in for the browser: worker.js runs as an ESM module
 * worker (the same kind app.js spawns in a browser) with its import()/fetch
 * contract satisfied by shims below (see worker.js's "Node-testable by
 * contract" note).
 *
 * Usage: node tests/worker-integration.test.mjs [bundle-dir]
 *   bundle-dir defaults to /tmp/bundle-out (patches/build-bundle.sh output).
 *   It may also be a STAGED SITE directory (site-publish): the test detects
 *   the deployed layout (wasm/pyodide/ nested, wasm/calibre-bundle.zip) and
 *   boots against it with no rewriting, so CI validates the exact geometry
 *   GitHub Pages will serve.
 *
 * Verifies: boot, formats listing, TXT->EPUB conversion with a valid EPUB
 * result (zip + mimetype), and the error path (garbage input).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const BUNDLE_DIR = process.argv[2] ? path.resolve(process.argv[2]) : '/tmp/bundle-out';

let pass = 0, fail = 0;
let teardownDone = false;
const failures = [];
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; failures.push(name); console.log('FAIL  ' + name + (extra ? ' -- ' + extra : '')); }
}

// Node >= 23 backs Buffers with shared 64 KB slabs: `.buffer` is the WHOLE
// slab (byteLength 65536, possibly carrying other allocations' leftovers),
// not just this string's bytes — and worker.js reads the whole backing store
// (new Uint8Array(msg.input)). Sending `.buffer` fed the engine tens of KB of
// NULs/garbage and made this suite flaky (~1 in 3: "embedded null byte" /
// "All strings must be XML compatible"). Slice exactly, like the browser's
// file.arrayBuffer() and TextEncoder do.
function exactUtf8(str) {
  const b = Buffer.from(str, 'utf8');
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

// Two accepted layouts:
//   bundle:    BUNDLE_DIR/calibre-bundle.zip + BUNDLE_DIR/pyodide/  (build output)
//   staged site: BUNDLE_DIR/wasm/calibre-bundle.zip + BUNDLE_DIR/wasm/pyodide/
// Marker = the entry the runtime actually loads (pyodide.mjs — the module
// worker's import target). Keying on a file nothing loads (e.g. the unused
// pyodide.js UMD build) would silently SKIP this suite the moment that file
// is cleaned up from the bundle.
const SITE_LAYOUT =
  fs.existsSync(path.join(BUNDLE_DIR, 'wasm', 'calibre-bundle.zip')) &&
  fs.existsSync(path.join(BUNDLE_DIR, 'wasm', 'pyodide', 'pyodide.mjs'));
if (!SITE_LAYOUT && !fs.existsSync(path.join(BUNDLE_DIR, 'calibre-bundle.zip'))) {
  const missing = `no engine at ${BUNDLE_DIR} (need wasm/calibre-bundle.zip + wasm/pyodide/pyodide.mjs, or calibre-bundle.zip at the root)`;
  // An explicitly passed dir (CI) without an engine is a HARD failure: a
  // silent SKIP there is exactly the green-but-unverified hole this suite
  // exists to close. The default dir (local dev) may legitimately be absent.
  if (process.argv[2]) {
    console.error('FAIL: ' + missing);
    process.exit(1);
  }
  console.log(`SKIPPED (${missing}; run patches/build-bundle.sh first)`);
  process.exit(0);
}

// ---------------------------------------------------------------- worker shim
// worker.js is a MODULE worker script: it uses self.postMessage /
// self.onmessage / dynamic import() / fetch. Node's worker_threads has none
// of the browser globals, so the worker file is prefixed with a preamble
// that polyfills them (fetch reads from disk; import() of pyodide.mjs works
// natively via file:// URLs) — worker.js itself runs unmodified.
const workerSrc = fs.readFileSync(path.join(REPO, 'worker.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(REPO, 'app.js'), 'utf8');

// Pyodide's "Classic web workers are not supported" guard only fires in
// BROWSERS (its env detection sees Node first), so the harness cannot trip
// that wire itself — assert the contract statically instead.
check('worker.js never calls importScripts (pyodide rejects classic workers)',
  !/\bimportScripts\s*\(/.test(workerSrc));
check("worker.js imports the ESM pyodide entry",
  /PYODIDE_MJS_URL = '\.\/wasm\/pyodide\/pyodide\.mjs'/.test(workerSrc));
check("app.js spawns worker.js with { type: 'module' }",
  /new Worker\('\.\/worker\.js',\s*\{\s*type:\s*'module'\s*\}\)/.test(appSrc));

console.log(`booting worker with ${SITE_LAYOUT ? 'staged site' : 'bundle'} layout at`, BUNDLE_DIR);

// The worker resolves ./wasm/pyodide/... relative to its own location. In a
// staged site that path is real; for a raw bundle dir a wasm -> . symlink
// mirrors the deployed layout so every URL resolves without touching
// worker.js. (symlinkSync EEXIST is fine — a real wasm/ dir wins.)
try {
  fs.symlinkSync('.', path.join(BUNDLE_DIR, 'wasm'), 'dir');
} catch (e) {
  if (e.code !== 'EEXIST') throw e;
}
// The preamble runs INSIDE the module worker before worker.js: defines the
// browser globals worker.js expects (self/location/postMessage/onmessage/
// fetch) plus a loadPyodide assignment interceptor — importScripts is
// deliberately NOT shimmed: module workers do not have it, and pyodide
// rejects any browser environment where it does work.
const PREAMBLE = `
import fs from 'node:fs';
import path from 'node:path';
import { parentPort } from 'node:worker_threads';
const BUNDLE_DIR = ${JSON.stringify(BUNDLE_DIR)};

// Browser worker contract on top of worker_threads:
// self.postMessage -> parentPort.postMessage, self.onmessage -> parentPort
// (a MessagePort keeps the worker alive until terminated, matching a
// browser worker's lifecycle).
globalThis.self = globalThis;
globalThis.location = { href: 'file://' + BUNDLE_DIR + '/' };
globalThis.postMessage = (m) => parentPort.postMessage(m);
Object.defineProperty(globalThis, 'onmessage', {
  configurable: true,
  set(fn) { parentPort.on('message', (d) => fn({ data: d })); },
  get() { return undefined; },
});

// worker.js dynamic-import()s pyodide.mjs through an absolute file:// URL
// derived from location.href (native ESM import — no shim needed), then
// assigns globalThis.loadPyodide. Intercept the ASSIGNMENT: pyodide under
// Node resolves indexURL with path.resolve, which mangles file:// URLs, so
// rewrite the file:// indexURL worker.js derives into a plain path.
let __loadPyodide = null;
Object.defineProperty(globalThis, 'loadPyodide', {
  configurable: true,
  set(fn) {
    __loadPyodide = (opts) => {
      if (opts && typeof opts.indexURL === 'string' && opts.indexURL.startsWith('file://')) {
        opts = { ...opts, indexURL: opts.indexURL.slice('file://'.length) };
      }
      return fn(opts);
    };
  },
  get() { return __loadPyodide; },
});
globalThis.fetch = async (url) => {
  const s = String(url);
  let p = s.startsWith('file://') ? s.slice('file://'.length) : s;
  if (!path.isAbsolute(p)) p = path.join(BUNDLE_DIR, p.replace(/^\\//, ''));
  if (!fs.existsSync(p)) {
    // worker paths carry a wasm/ prefix that maps to the bundle root.
    const alt = path.join(BUNDLE_DIR, p.replace(/^.*?wasm\\//, ''));
    if (fs.existsSync(alt)) p = alt;
  }
  const data = fs.readFileSync(p);
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
    json: async () => JSON.parse(data.toString('utf8')),
  };
};
`;

fs.mkdirSync(path.join(os.tmpdir(), 'calibre-web-tests'), { recursive: true });
// .mjs so Node unambiguously treats the concatenated preamble+worker as ESM,
// exactly like a browser module worker.
// pid-suffixed: concurrent runs of this suite must not overwrite each
// other's boot file (a shared name lets one process boot another's harness).
const workerFile = path.join(os.tmpdir(), 'calibre-web-tests', `worker-boot-${process.pid}.mjs`);
fs.writeFileSync(workerFile, PREAMBLE + '\n' + workerSrc);

const w = new Worker(workerFile, { type: 'module', stdout: true, stderr: true });

let nextId = 1;
const pending = new Map();
function send(type, payload) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    w.postMessage({ id, type, ...payload });
  });
}

const bootLines = [];
w.on('message', (msg) => {
  if (msg.type === 'boot-progress' || msg.type === 'progress') {
    if (msg.line) bootLines.push(msg.line);
    if (msg.stage) console.log('  [boot]', msg.stage, `(${msg.pct}%)`);
 return;
  }
  const waiter = pending.get(msg.id);
  if (!waiter) return;
  pending.delete(msg.id);
  if (msg.type === 'error') {
    const err = new Error(msg.message);
    err.engineLog = msg.log; // calibre traceback lines, when the worker has them
    waiter.reject(err);
  } else waiter.resolve(msg);
});
w.on('error', (e) => { console.error('worker error:', e); process.exitCode = 1; });
w.on('exit', (c) => {
  // A nonzero exit during teardown (after the checks printed) is a teardown
  // artifact, not a test failure — the assertions above already decided.
  if (c !== 0 && !teardownDone) console.error('worker exited', c);
});

// ------------------------------------------------------------------- tests --
try {
  console.log('waiting for boot...');
  const ready = await send('init', {});
  check('worker boots to ready', true);
  console.log('boot log tail:', bootLines.slice(-3).join(' | '));

  const fmts = await send('formats', {});
  check('formats: input list non-empty', Array.isArray(fmts.input) && fmts.input.length > 5,
    `got ${fmts.input && fmts.input.length}`);
  check('formats: output list non-empty', Array.isArray(fmts.output) && fmts.output.length > 5,
    `got ${fmts.output && fmts.output.length}`);
  check('formats: epub + mobi + azw3 available',
 ['epub', 'mobi', 'azw3'].every(f => fmts.output.includes(f)),
    String(fmts.output));
  check('formats: pdf NOT offered (unsupported in wasm)', !fmts.output.includes('pdf'));
  check('formats: version reported', typeof fmts.version === 'string' && fmts.version.length > 0, fmts.version);

  // TXT -> EPUB
  const txt = ('Chapter One\n\nThe quick brown fox jumps over the lazy dog. '.repeat(100) +
 '\n\nChapter Two\n\nIt was the best of times. '.repeat(100));
  const conv = await send('convert', {
 name: 'test.txt',
    input: exactUtf8(txt),
    outputFormat: 'epub',
  });
  check('convert TXT->EPUB returns a result', conv.type === 'convert-result', JSON.stringify(conv).slice(0, 100));
  check('convert: output name .epub', /\.epub$/.test(conv.name || ''), conv.name);
  check('convert: bytes non-trivial', conv.size > 1000, `size ${conv.size}`);

  // Validate the EPUB: zip magic + mimetype entry
  const bytes = Buffer.from(conv.data);
  check('epub: zip magic', bytes[0] === 0x50 && bytes[1] === 0x4b, bytes.subarray(0, 2).toString('hex'));
  const zipEnd = bytes.indexOf(Buffer.from('mimetypeapplication/epub+zip'));
  check('epub: mimetype entry present', zipEnd > 0);

  // Garbage input -> clean engine-level error (or a tolerated conversion),
  // never a hang or a worker crash. send() rejects precisely on the worker's
  // {type:'error'} message; a hang would surface as the run-level timeout
  // instead, so any resolution/rejection here is a clean outcome.
  const bad = await send('convert', {
    name: 'bad.epub',
    input: exactUtf8('this is not an ebook at all, just some text'),
    outputFormat: 'azw3',
  }).then(m => ({ ok: true, m }), e => ({ ok: false, e }));
  check('garbage input: rejected or errored cleanly',
    bad.ok ? bad.m.type === 'convert-result'
 : bad.e instanceof Error && bad.e.message.length > 0,
 bad.ok ? 'converted anyway (tolerated): ' + JSON.stringify(bad.m).slice(0, 80)
 : 'clean error: ' + String(bad.e && bad.e.message).slice(0, 120));

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { failures.forEach(f => console.log('FAILED: ' + f)); process.exitCode = 1; }
} catch (e) {
  console.error('TEST CRASH:', e);
  if (e && Array.isArray(e.engineLog) && e.engineLog.length) {
    console.error('--- engine log tail ---');
    e.engineLog.slice(-25).forEach((l) => console.error('  ' + l));
  }
  process.exitCode = 1;
} finally {
  teardownDone = true;
  await w.terminate();
}
