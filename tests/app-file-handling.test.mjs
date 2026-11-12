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

// ---- output profile wiring ----
// The profile list comes from the engine (formats-result.profiles), NOT a
// hardcoded JS array — so the dropdown always matches the shipped calibre.
check('profile dropdown built from engine-reported profiles (renderProfileOptions)',
  /renderProfileOptions/.test(app) && /availableProfiles = msg\.profiles/.test(app) &&
  /profileSelect\.appendChild/.test(app));
// doConvert must send output_profile ONLY for non-default selections (the
// no-options path stays byte-identical to the pre-profile protocol) and the
// worker must merge options via the CLI mechanism, not dead setattr code.
check('app.js sends options.output_profile only when non-default',
  /profile !== 'default'/.test(app) && /output_profile: profile/.test(app));
check('worker.js merges convert options via merge_ui_recommendations (CLI pattern)',
  /merge_ui_recommendations/.test(worker) && /OptionRecommendation\.HIGH/.test(worker) &&
  !/plumber\.options/.test(worker));
// The semantic invariant is "msg.options never reaches the generated Python
// source except wrapped in JSON.stringify" (raw JSON text spliced into code
// makes JS true/false/null Python NameErrors) plus "python json.loads the
// string it receives". Deliberately NOT pinned to the nested
// JSON.stringify(JSON.stringify(...)) call shape — a temp-var refactor is
// behavior-identical and must keep passing; the live weirdOpts conversion in
// worker-integration (bool/null/quote/unicode values) is the dynamic backstop.
check('worker.js never splices raw msg.options into python code (double-encode invariant)',
  (() => {
    // Every msg.options occurrence must either be WRAPPED by JSON.stringify
    // (any nesting/temp-var shape) or be a bare truthiness test — never a
    // value spliced into the generated python source.
    const occ = worker.match(/.{0,25}msg\.options.{0,5}/g) || [];
    return occ.length >= 1 && occ.every(s =>
      /JSON\.stringify\(\s*msg\.options/.test(s) || /msg\.options\s*\?/.test(s));
  })() &&
  /json\.loads\(options_json\)/.test(worker));
check('convert-result echoes the resolved profile back to the app',
  /profile: res\.profile/.test(worker) && /msg\.profile/.test(app));
// The selected profile's description must live in a persistent element, not
// only option[title] (hover-only; native touch pickers and screen readers
// never see it). Mirrors calibre GUI's always-visible profile_description.
// Content correctness (text === selected option's title, follows changes) is
// asserted dynamically in browser-smoke; the static gate pins only the
// wiring: a named sync function registered on the select's change event.
check('app.js keeps a persistent profile description in sync (#profile-note)',
  /function renderProfileNote/.test(app) &&
  /profileSelect\.addEventListener\('change', renderProfileNote\)/.test(app));
// doConvert captures format/profile up front; the selects must be disabled
// during a conversion so a mid-flight change cannot silently diverge from
// the running job. The invariant: ALL busy toggling inside doConvert goes
// through the single setBusy helper (buttons AND selects together) — no
// direct .disabled writes that could forget a select. Not pinned to an exact
// setBusy(false) COUNT: consolidating the two settle paths into a .finally()
// is behavior-preserving and must keep passing.
check('app.js disables both selects during conversion (single setBusy path in doConvert)',
  /function setBusy\(on\)/.test(app) &&
  /formatSelect\.disabled = on/.test(app) && /profileSelect\.disabled = on/.test(app) &&
  (() => {
    const body = app.slice(app.indexOf('function doConvert()'));
    const doConvertSrc = body.slice(0, body.indexOf('\n  function addDownload'));
    return /setBusy\(true\)/.test(doConvertSrc) && /setBusy\(false\)/.test(doConvertSrc) &&
      !/(convertBtn|clearBtn|formatSelect|profileSelect)\.disabled\s*=/.test(doConvertSrc);
  })());
// One job at a time: doConvert must reject while `converting` (a stacked
// second job's FIRST settle would clear `converting` + setBusy(false) while
// it is still running — re-enabling Clear mid-flight and un-deferring the
// service-worker controllerchange reload, destroying book.data and the
// download row), and handleIncomingFiles' Convert re-enable must respect
// `converting` too (an intake can land mid-conversion — the dropzone is
// never disabled). Dynamic backstop: browser-smoke dispatches a second
// synthetic click and asserts exactly one 'convert' message reaches the
// worker.
check('app.js enforces one conversion at a time (converting guards dispatch + intake)',
  (() => {
    const body = app.slice(app.indexOf('function doConvert()'));
    const doConvertSrc = body.slice(0, body.indexOf('\n  function addDownload'));
    return /if \(converting\) return;/.test(doConvertSrc) &&
      /if \(!converting\) convertBtn\.disabled = false;/.test(app) &&
      // no UNGUARDED intake re-enable anywhere (the pre-fix line shape)
      !/^\s*convertBtn\.disabled = false;\s*$/m.test(app);
  })());
// Converter reveal waits for BOTH engine-ready and formats-settled, so the
// profile select cannot un-hide after the card is already interactive and
// reflow the Convert button ~100px downward.
check('converter reveal gated on workerReady AND formatsLoaded (no late layout shift)',
  /function maybeRevealConverter/.test(app) &&
  /if \(!workerReady \|\| !formatsLoaded\) return;/.test(app) &&
  /formatsLoaded = true;/.test(app));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { failures.forEach(f => console.log('FAILED: ' + f)); process.exit(1); }
