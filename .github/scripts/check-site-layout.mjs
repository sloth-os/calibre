#!/usr/bin/env node
// Site-layout gate for the staged Pages tree.
//
// Usage: node check-site-layout.mjs <site-dir>
//
// The bundle smoke test validates wasm-stage CONTENT; this validates the
// deployed GEOMETRY: every URL the browser-side code will actually request
// must exist in the staged tree, derived from the sources of truth rather
// than a hard-coded list — worker.js's path constants, index.html/app.js
// script+worker references, manifest.webmanifest icons/start_url/share
// target, and the generated sw-manifest.js (both directions: every listed
// asset exists, every staged file is listed). A staging step that flattens
// or renames a directory fails HERE, not on the live site.
//
// Node ESM, zero npm dependencies (Node >= 18). Exit 0 = layout good.
import fs from 'node:fs';
import path from 'node:path';

const USAGE = 'usage: node check-site-layout.mjs <site-dir>';

let failures = 0;
let checks = 0;
function check(name, ok, detail) {
  checks++;
  if (ok) {
    console.log(`  ok    ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`);
  }
}
function failHard(message) {
  console.error(`check-site-layout: ${message}`);
  process.exit(2);
}

const arg = process.argv[2];
if (!arg) failHard(`expected exactly one <site-dir> argument\n${USAGE}`);
const SITE = path.resolve(arg);
if (!fs.existsSync(SITE) || !fs.statSync(SITE).isDirectory()) {
  failHard(`not a directory: ${arg}`);
}

function read(rel) {
  return fs.readFileSync(path.join(SITE, rel), 'utf8');
}
function exists(rel) {
  return fs.existsSync(path.join(SITE, rel));
}
// './wasm/x.js?v=1' -> 'wasm/x.js' (site-relative, '/'-separated)
function toRel(url) {
  return String(url).split('?')[0].split('#')[0].replace(/^\.\//, '').replace(/^\/+/, '');
}
// Client-side URL literals must be RELATIVE: the site deploys under the
// /calibre/ subpath, where a root-absolute '/worker.js' resolves against the
// ORIGIN ROOT and 404s — silently, with every other check still green (the
// exact incident class this gate exists for). Normalize + police in one step.
function relUrl(raw, what) {
  const s = String(raw);
  check(`${what} ('${s}') is relative — root-absolute/scheme URLs break the subpath deploy`,
    !/^\//.test(s) && !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s));
  return toRel(s);
}
function literal(source, regex, what) {
  const m = regex.exec(source);
  if (!m) failHard(`cannot find ${what} in worker/app sources — gate is out of date`);
  return m[1];
}

// ---------------------------------------------------------------- worker.js --
// The engine's boot geometry: dynamic import(PYODIDE_MJS_URL),
// fetch(BUNDLE_URL), loadPyodide({indexURL}) — pyodide loads its asm/stdlib/
// lock files relative to indexURL, so the whole directory must be intact.
console.log('worker.js geometry');
const worker = read('worker.js');
const pyodideUrl = relUrl(literal(worker, /var PYODIDE_MJS_URL = '([^']+)';/, 'PYODIDE_MJS_URL'), 'PYODIDE_MJS_URL');
const bundleUrl = relUrl(literal(worker, /var BUNDLE_URL = '([^']+)';/, 'BUNDLE_URL'), 'BUNDLE_URL');
const indexUrlRaw = relUrl(literal(worker, /indexURL: new URL\('([^']+)', self\.location\.href\)/, 'indexURL'), 'indexURL');
const indexUrl = indexUrlRaw || './'; // toRel('./') === '' — keep './' for dirname comparison

check(`${pyodideUrl} exists`, exists(pyodideUrl));
check(`${bundleUrl} exists`, exists(bundleUrl));
check(`indexURL dir ${indexUrl} exists`, fs.existsSync(path.join(SITE, indexUrl)) &&
  fs.statSync(path.join(SITE, indexUrl)).isDirectory());
check('indexURL dir matches PYODIDE_MJS_URL location',
  path.posix.dirname(pyodideUrl) + '/' === indexUrl,
  `${path.posix.dirname(pyodideUrl)}/ vs ${indexUrl}`);
// What pyodide itself imports/fetches from indexURL at load time (pyodide.mjs
// is the entry, pyodide.asm.mjs the wasm loader module, the rest are fetched).
for (const core of ['pyodide.mjs', 'pyodide.asm.mjs', 'pyodide.asm.wasm',
  'python_stdlib.zip', 'pyodide-lock.json']) {
  check(`${indexUrl}${core} exists`, exists(indexUrl + core));
}
// Pyodide throws "Classic web workers are not supported" in any browser
// worker where importScripts works — guard the deployed bytes directly (the
// Node harness cannot trip this browser-only check).
check('worker.js never calls importScripts (module worker only)',
  !/\bimportScripts\s*\(/.test(worker));

// ------------------------------------------------------------- app shell --
console.log('app shell geometry');
check('index.html exists', exists('index.html'));
const indexHtml = read('index.html');
for (const src of indexHtml.matchAll(/<script[^>]+src="([^"]+)"/g)) {
  check(`index.html script ${src[1]} exists`, exists(relUrl(src[1], `script ${src[1]}`)));
}
// <link href>s (manifest, icons, stylesheets) are as load-bearing as script
// srcs: a broken manifest link silently kills install/share/file-handling.
for (const link of indexHtml.matchAll(/<link[^>]+href="([^"]+)"/g)) {
  check(`index.html link ${link[1]} exists`, exists(relUrl(link[1], `link ${link[1]}`)));
}
const app = read('app.js');
const workerPath = relUrl(literal(app, /new Worker\('([^']+)'(?:,\s*\{[^}]*\})?\)/, 'new Worker(...)'), 'new Worker(...)');
check("app.js spawns the worker with { type: 'module' } (pyodide rejects classic workers)",
  /new Worker\('[^']+',\s*\{\s*type:\s*'module'\s*\}\)/.test(app));
check(`app.js worker ${workerPath} exists`, exists(workerPath));
const swPath = relUrl(literal(app, /serviceWorker\.register\('([^']+)'(?:,\s*\{[^}]*\})?\)/, 'serviceWorker.register(...)'), 'serviceWorker.register(...)');
check(`app.js registers ${swPath} and it exists`, exists(swPath));
// sw.js is byte-stable across builds; the update signal is sw-manifest.js,
// which Pages serves with max-age=600. Without updateViaCache:'none' the HTTP
// cache can hide a new manifest from update checks for up to 10 minutes.
check("app.js registers with { updateViaCache: 'none' } (manifest updates not HTTP-cached)",
  /serviceWorker\.register\('[^']+',\s*\{\s*updateViaCache:\s*'none'\s*\}\)/.test(app));

// ---------------------------------------------------- manifest.webmanifest --
console.log('web app manifest geometry');
let manifest;
try {
  manifest = JSON.parse(read('manifest.webmanifest'));
} catch (err) {
  failHard(`manifest.webmanifest does not parse: ${err.message}`);
}
if (manifest.start_url) {
  const startRel = relUrl(manifest.start_url, 'start_url');
  check(`start_url ${manifest.start_url} resolves`, exists(startRel) || startRel === '');
}
for (const icon of manifest.icons || []) {
  check(`icon ${icon.src} exists`, exists(relUrl(icon.src, `icon ${icon.src}`)));
}
// A share_target action is a POST to a virtual route: GitHub Pages never
// accepts POSTs to static files, so "exists on disk" proves nothing — sw.js
// must intercept that EXACT route (it matches url.pathname against SHARE_URL).
// Substring matches against sw.js source are not evidence (e.g. './count'
// matches the './__shared/count' cache-key literal). file_handlers actions
// are GET navigations: an intercepted route OR a real navigable file works.
const sw = read('sw.js');
const shareRoute = toRel(literal(sw, /SHARE_URL = new URL\('([^']+)', self\.location\)/, 'SHARE_URL'))
  .replace(/\/$/, '');
if (manifest.share_target) {
  const action = manifest.share_target.action || './';
  check(`share_target action ${action} is the route sw.js intercepts ('${shareRoute}')`,
    toRel(action).replace(/\/$/, '') === shareRoute);
}
for (const fh of manifest.file_handlers || []) {
  if (!fh.action || fh.action === './') continue; // plain app navigation
  const route = toRel(fh.action).replace(/\/$/, '');
  check(`file_handler action ${fh.action} intercepted by sw.js or navigable on disk`,
    route === shareRoute || sw.includes(`new URL('${fh.action}', self.location)`) || exists(route));
}

// -------------------------------------------------------- sw-manifest.js --
// Generated by generate-sw-manifest.mjs; sw.js precaches exactly this list.
console.log('sw-manifest.js');
if (!exists('sw-manifest.js')) {
  failHard('sw-manifest.js missing — run generate-sw-manifest.mjs first');
}
const swManifest = read('sw-manifest.js');
const version = literal(swManifest, /self\.__SW_VERSION__ = "([^"]*)";/, '__SW_VERSION__');
check('version stamp non-empty', version.length > 0);
const assetsStart = swManifest.indexOf('self.__SW_ASSETS__ = [');
if (assetsStart < 0) failHard('cannot find __SW_ASSETS__ in sw-manifest.js');
const assetsEnd = swManifest.indexOf('];', assetsStart);
if (assetsEnd < 0) failHard('unterminated __SW_ASSETS__ in sw-manifest.js');
let assets;
try {
  assets = JSON.parse(swManifest.slice(assetsStart + 'self.__SW_ASSETS__ = '.length, assetsEnd + 1));
} catch (err) {
  failHard(`__SW_ASSETS__ is not valid JSON: ${err.message}`);
}
check(`asset list non-empty (${assets.length} entries)`, assets.length > 0);
for (const asset of assets) {
  check(`listed ${asset} exists`, exists(toRel(asset)));
}
// Everything the runtime needs offline must be precached.
const required = ['./index.html', './offline.html', './app.js', './worker.js',
  './manifest.webmanifest', `./${pyodideUrl}`, `./${bundleUrl}`];
for (const need of required) {
  check(`precache includes ${need}`, assets.includes(need));
}
// Reverse direction: every staged file must be listed (generator exclusions
// mirrored: dotfiles, node_modules/, tests/, and the three top-level files
// that must never be precached). If staging grows a file the generator did
// not see — or the generator ran against the wrong directory — fail here.
const SKIP_DIRS = new Set(['node_modules', 'tests']);
const TOP_EXCLUDES = new Set(['sw.js', 'sw-manifest.js', 'build-info.json']);
const onDisk = [];
(function walk(dir, rel) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (entry.name.startsWith('.')) continue;
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    let isDir = entry.isDirectory();
    if (entry.isSymbolicLink()) {
      try { isDir = fs.statSync(full).isDirectory(); } catch { continue; }
    }
    if (isDir) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full, relPath);
    } else if (rel === '' && TOP_EXCLUDES.has(entry.name)) {
      continue;
    } else {
      onDisk.push(`./${relPath}`);
    }
  }
})(SITE, '');
const listed = new Set(assets);
const unlisted = onDisk.filter((f) => !listed.has(f));
check('every staged file is precached', unlisted.length === 0,
  unlisted.slice(0, 10).join(', '));

// ------------------------------------------------------- build-info.json --
console.log('build metadata');
check('build-info.json exists', exists('build-info.json'));
if (exists('build-info.json')) {
  let info;
  try {
    info = JSON.parse(read('build-info.json'));
  } catch (err) {
    info = null;
    check('build-info.json parses', false, err.message);
  }
  if (info) {
    check('build-info.json parses', true);
    check('version field present', typeof info.version === 'string' && info.version !== '');
    check('pyodide field present', typeof info.pyodide === 'string' && info.pyodide !== '');
  }
}

console.log(`\ncheck-site-layout: ${checks - failures}/${checks} checks passed`);
if (failures) {
  console.error(`::error::site layout check failed: ${failures} problem(s) — the staged tree does not match the URLs the app requests`);
  process.exit(1);
}
