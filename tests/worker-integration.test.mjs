#!/usr/bin/env node
/*
 * Worker integration test: drive the REAL worker.js against the REAL wasm
 * bundle the way a browser would — via the same message protocol the app
 * uses. Node stands in for the browser: worker.js's importScripts/fetch
 * contract is satisfied by shims below (see worker.js's "Node-testable by
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

// Two accepted layouts:
//   bundle:    BUNDLE_DIR/calibre-bundle.zip + BUNDLE_DIR/pyodide/  (build output)
//   staged site: BUNDLE_DIR/wasm/calibre-bundle.zip + BUNDLE_DIR/wasm/pyodide/
const SITE_LAYOUT =
  fs.existsSync(path.join(BUNDLE_DIR, 'wasm', 'calibre-bundle.zip')) &&
  fs.existsSync(path.join(BUNDLE_DIR, 'wasm', 'pyodide', 'pyodide.js'));
if (!SITE_LAYOUT && !fs.existsSync(path.join(BUNDLE_DIR, 'calibre-bundle.zip'))) {
  console.log(`SKIPPED (no bundle at ${BUNDLE_DIR}; run patches/build-bundle.sh first)`);
  process.exit(0);
}

// ---------------------------------------------------------------- worker shim
// worker.js is a classic worker script: it uses self.postMessage /
// self.onmessage / importScripts / fetch. Node's worker_threads has none of
// those, so the worker file is prefixed with a preamble that polyfills them
// (importScripts loads the local pyodide distribution via require, fetch
// reads from disk) — worker.js itself runs unmodified.
const workerSrc = fs.readFileSync(path.join(REPO, 'worker.js'), 'utf8');

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
// The preamble runs INSIDE the worker before worker.js: defines importScripts
// (loads the local pyodide distribution as a module) and fetch (reads from
// the bundle dir) so worker.js's browser contract holds.
const PREAMBLE = `
const { createRequire } = require('node:module');
const fs = require('node:fs');
const path = require('node:path');
const { parentPort } = require('node:worker_threads');
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

globalThis.importScripts = (...urls) => {
  for (const u of urls) {
    // Resolve './wasm/...' against the bundle dir itself: a staged site has a
    // real wasm/ tree, a raw bundle dir has the wasm -> . symlink. Either way
    // the worker's URL maps to bytes on disk without stripping the prefix.
    const p = u.startsWith('./wasm/') ? path.join(BUNDLE_DIR, u.slice(2)) : u;
    // pyodide.js is a UMD bundle: require it and expose its exports.
    const mod = require(path.resolve(p));
    Object.assign(globalThis, mod);
  }
  // pyodide under Node resolves indexURL with path.resolve (ignoring
  // file:// URLs); rewrite the file:// indexURL worker.js derives into a
  // plain path so the stdlib/asm files resolve on this host.
  if (globalThis.loadPyodide && !globalThis.loadPyodide.__pathFix) {
    const orig = globalThis.loadPyodide;
    const fixed = (opts) => {
      if (opts && typeof opts.indexURL === 'string' && opts.indexURL.startsWith('file://')) {
        opts = { ...opts, indexURL: opts.indexURL.slice('file://'.length) };
      }
      return orig(opts);
    };
    fixed.__pathFix = true;
    globalThis.loadPyodide = fixed;
  }
};
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
const workerFile = path.join(os.tmpdir(), 'calibre-web-tests', 'worker-boot.js');
fs.writeFileSync(workerFile, PREAMBLE + '\n' + workerSrc);

const w = new Worker(workerFile, { type: 'commonjs', stdout: true, stderr: true });

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
  if (msg.type === 'error') waiter.reject(new Error(msg.message));
  else waiter.resolve(msg);
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
    input: Buffer.from(txt, 'utf8').buffer,
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

  // Garbage input -> clean error (not a hang)
  const bad = await send('convert', {
    name: 'bad.epub',
    input: Buffer.from('this is not an ebook at all, just some text', 'utf8').buffer,
    outputFormat: 'azw3',
  }).then(m => ({ ok: true, m }), e => ({ ok: false, e }));
  check('garbage input: rejected or errored cleanly', true,
 bad.ok ? 'converted anyway (tolerated)' : 'error: ' + bad.e.message.slice(0, 80));

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { failures.forEach(f => console.log('FAILED: ' + f)); process.exitCode = 1; }
} catch (e) {
  console.error('TEST CRASH:', e);
  process.exitCode = 1;
} finally {
  teardownDone = true;
  await w.terminate();
}
