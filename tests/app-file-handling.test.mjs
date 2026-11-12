#!/usr/bin/env node
/*
 * Contract test: PWA file handling entry points in app.js.
 *
 * Parses the real app.js source and asserts the file-handling contract:
 *   - launchQueue consumer registered at boot (buffered queue cannot miss)
 *   - share-target files consumed from the fixed SHARED_CACHE
 *   - file intake accepts picker / drag-drop / paste
 *   - worker protocol: init/convert/formats/metadata + boot-progress
 *
 * Usage: node tests/app-file-handling.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; failures.push(name); console.log('FAIL  ' + name + (extra ? ' -- ' + extra : '')); }
}

const app = fs.readFileSync(path.join(REPO, 'app.js'), 'utf8');
const worker = fs.readFileSync(path.join(REPO, 'worker.js'), 'utf8');

// ---- launchQueue: OS "Open with" handling ----
check('app.js registers a launchQueue consumer',
  /launchQueue\.setConsumer\s*\(/.test(app));
check('launchQueue consumer handles params.files (array-like)',
  /params\.files/.test(app));
check('setupLaunchQueue is called during boot',
  // the init block at the file tail calls it (the function definition also
  // matches the bare regex, so strip definitions of every setup* helper and
  // look for bare calls)
  (() => {
    const withoutDefs = app.replace(/^  function setup\w+\s*\([^)]*\)\s*\{[\s\S]*?\n  \}/gm, '');
    return /^\s*setupLaunchQueue\(\);/m.test(withoutDefs);
  })());

// ---- share target consumption ----
check('app.js consumes shared files from the fixed cache name',
  /caches\.open\(\s*SHARED_CACHE\s*\)/.test(app));
check('SHARED_CACHE matches sw.js (calibre-web-shared)',
  /SHARED_CACHE\s*=\s*'calibre-web-shared'/.test(app) &&
  /SHARED_CACHE\s*=\s*'calibre-web-shared'/.test(fs.readFileSync(path.join(REPO, 'sw.js'), 'utf8')));
check('shared files are deleted after reading (no double-ingest on reload)',
  /cache\.delete\(key\)/.test(app));

// ---- intake surfaces ----
check('picker intake: #file-input change handler', /fileInput\.addEventListener\('change'/.test(app));
check('drag-drop intake: drop handler reads dataTransfer.files',
  /ev\.dataTransfer\.files/.test(app));
check('paste intake: clipboardData.files', /clipboardData\.files/.test(app));

// ---- worker protocol ----
// The protocol resolves replies by message id; the app must accept every
// result type the worker can post.
check('worker protocol: init message',
  /send\('init'/.test(app) && /msg\.type === 'init'/.test(worker));
check('worker protocol: formats message + formats-result reply',
  /send\('formats'/.test(app) && /'formats-result'/.test(worker));
check('worker protocol: convert message + convert-result reply',
  /send\('convert'/.test(app) && /'convert-result'/.test(worker));
check('worker protocol: metadata message + metadata-result reply',
  /send\('metadata'/.test(app) && /'metadata-result'/.test(worker));
check('worker protocol: boot-progress handled by the app',
  /boot-progress/.test(worker) && /boot-progress/.test(app));

// ---- service worker registration ----
check('app.js registers sw.js', /navigator\.serviceWorker\.register\('\.\/sw\.js'/.test(app));
// The update signal is sw-manifest.js (HTTP-cached max-age=600 by Pages);
// 'none' keeps update checks from serving a stale manifest for up to 10 min.
check("app.js registers with { updateViaCache: 'none' }",
  /navigator\.serviceWorker\.register\('\.\/sw\.js',\s*\{\s*updateViaCache:\s*'none'\s*\}\)/.test(app));
// Returning users keep talking to the OLD service worker (old precache, old
// engine) until the page reloads: sw.js skipWaiting()s on healthy installs,
// and app.js must reload once on 'controllerchange'. The hadController guard
// (captured BEFORE register) keeps a first visit's clientsClaim-style
// controllerchange from looping reloads.
check('app.js one-shot reloads on controllerchange with a first-visit guard',
  /hadController\s*=\s*Boolean\(navigator\.serviceWorker\.controller\)/.test(app) &&
  /addEventListener\('controllerchange'/.test(app) &&
  /if\s*\(!hadController\s*\|\|\s*refreshing\)\s*return/.test(app) &&
  /refreshing\s*=\s*true/.test(app) &&
  /window\.location\.reload\(\)/.test(app));
// The reload must NOT fire mid-conversion: book.data and the worker session
// are memory-only, so controllerchange defers while `converting` and
// doConvert's error path takes the reload once the conversion ends (the
// success path keeps the page so the download row survives).
check('app.js defers the controllerchange reload while converting',
  /var converting = false;/.test(app) &&
  /var pendingReload = false;/.test(app) &&
  /if\s*\(converting\)\s*\{[\s\S]*?pendingReload = true;[\s\S]*?return;/.test(app) &&
  /converting = true;/.test(app) &&
  /if\s*\(pendingReload\)\s*window\.location\.reload\(\);/.test(app));

// ---- formats list wiring ----
check('format dropdown built from engine-reported formats (renderFormatOptions)',
  /renderFormatOptions/.test(app) && /formatSelect\.appendChild/.test(app));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { failures.forEach(f => console.log('FAILED: ' + f)); process.exit(1); }
