#!/usr/bin/env node
/*
 * Service worker unit tests: drive sw.js in a vm with a mock worker
 * environment (the same contract sw.js documents: importScripts, caches,
 * fetch, clients, skipWaiting).
 *
 * Two worlds are loaded from the SAME sw.js source:
 *   A. manifest GOOD — importScripts yields __SW_VERSION__/__SW_ASSETS__:
 *      install precaches into the versioned cache (with a retry pass for
 *      transient misses) and calls skipWaiting; activate deletes old
 *      versioned caches but never the shared cache; full fetch routing
 *      (navigations, build-info network-first, asset cache-first with
 *      write-back, offline fallback, share POST stash, non-interceptions).
 *   B. manifest BROKEN — importScripts throws (the fail-open hazard):
 *      install must NOT skipWaiting (the old worker keeps serving) and
 *      activate must NOT delete existing caches.
 *
 * Usage: node tests/sw.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SW_SRC = fs.readFileSync(path.join(REPO, 'sw.js'), 'utf8');

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; failures.push(name); console.log('FAIL  ' + name + (extra ? ' -- ' + extra : '')); }
}

// ------------------------------------------------------------ mock world --
const SW_URL = 'https://example.test/calibre/sw.js';
const ORIGIN_BASE = SW_URL.replace('sw.js', '');
const VERSION = 'test-v1';
const CACHE_NAME = 'calibre-web-' + VERSION;
const MANIFEST = ['./index.html', './offline.html', './app.js', './build-info.json',
  './worker.js', './wasm/calibre-bundle.zip'];

class MockCache {
  constructor() { this.map = new Map(); }
  async match(req) {
    const key = typeof req === 'string' ? req : req.url;
    return this.map.get(key) || null;
  }
  async add(req) {
    const url = typeof req === 'string' ? req : req.url;
    const resp = await world.fetch(new Request(url, { cache: 'reload' }));
    if (!resp.ok) throw new Error('fetch failed');
    this.map.set(url, resp);
  }
  async put(req, resp) { this.map.set(typeof req === 'string' ? req : req.url, resp); }
  async delete(req) { return this.map.delete(typeof req === 'string' ? req : req.url); }
  async keys() { return [...this.map.keys()].map(u => ({ url: u })); }
}

let world; // active world (MockCache.add closes over it)

// importScripts behavior: 'good' publishes the manifest onto self; 'broken'
// throws like a failed fetch of sw-manifest.js.
function makeWorld(manifestMode) {
  const w = {
    caches: {
      _stores: new Map(),
      async open(name) {
        if (!this._stores.has(name)) this._stores.set(name, new MockCache());
        return this._stores.get(name);
      },
      async keys() { return [...this._stores.keys()]; },
      async delete(name) { return this._stores.delete(name); },
    },
    networkOk: true,
    networkHits: 0,
    failOnce: new Set(), // URLs whose FIRST fetch throws (retry testing)
    listeners: {},
    firedEvents: {},
    logs: [],
    location: new URL(SW_URL),
    skipWaiting() { this.firedEvents.skipWaiting = true; return Promise.resolve(); },
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
    importScripts() {
      if (manifestMode === 'broken') throw new Error('sw-manifest.js not found');
      this.__SW_VERSION__ = VERSION;
      this.__SW_ASSETS__ = MANIFEST.slice();
    },
    clients: { async claim() { return undefined; } },
    console: {
      log(...a) { w.logs.push(['log', a.join(' ')]); },
      warn(...a) { w.logs.push(['warn', a.join(' ')]); },
      error(...a) { w.logs.push(['error', a.join(' ')]); },
    },
  };
  w.fetch = async (req) => {
    const url = typeof req === 'string' ? req : req.url;
    w.networkHits++;
    if (w.failOnce.has(url)) { w.failOnce.delete(url); throw new Error('transient flake'); }
    if (!w.networkOk) throw new Error('network down');
    return new Response('net:' + url, { status: 200 });
  };

  const sandbox = {
    caches: w.caches,
    fetch: (...a) => w.fetch(...a),
    location: w.location,
    self: w,
    importScripts: (...a) => w.importScripts(...a),
    clients: w.clients,
    // NOTE: no shorthand `console` here — it must stay the collecting mock,
    // or sw.js's warns/errors escape to the real stdout and w.logs stays empty.
    console: w.console,
    Request, Response, URL, Promise, Blob, File, FormData,
  };
  vm.createContext(sandbox);
  const prev = world;
  world = w;
  vm.runInContext(SW_SRC, sandbox);
  world = prev;
  return w;
}

async function fire(w, type, event) {
  const fns = w.listeners[type] || [];
  const waiters = [];
  const ev = { ...event, waitUntil: (p) => waiters.push(p), respondWith: (p) => { ev.__replied = p; } };
  for (const fn of fns) fn(ev);
  world = w;
  try { await Promise.all(waiters); } finally { world = null; }
  await new Promise(r => setTimeout(r, 0));
  return ev;
}

// =================================================== world A: manifest good --
{
  const w = makeWorld('good');
  // Pre-existing caches from a previous build + a stashed share.
  w.caches._stores.set('calibre-web-old-v0', new MockCache());
  w.caches._stores.set('calibre-web-shared', new MockCache());
  // One asset flakes on the first fetch: the retry pass must recover it.
  w.failOnce.add(new URL('./app.js', SW_URL).href);

  await fire(w, 'install', {});
  check('install: skipWaiting called (manifest present)', w.firedEvents.skipWaiting === true);
  const cache = await w.caches.open(CACHE_NAME);
  const cached = (await cache.keys()).map(k => k.url);
  const expected = MANIFEST.map(p => new URL(p, SW_URL).href);
  check('install: every manifest asset precached into the versioned cache',
    expected.every(u => cached.includes(u)),
    'missing: ' + expected.filter(u => !cached.includes(u)).join(', '));
  check('install: transient miss recovered by the retry pass',
    cached.includes(new URL('./app.js', SW_URL).href) && w.failOnce.size === 0);
  check('install: retry actually re-fetched (>= assets+1 network hits)',
    w.networkHits >= MANIFEST.length + 1, `hits ${w.networkHits}`);

  await fire(w, 'activate', {});
  const keysAfter = await w.caches.keys();
  check('activate: old versioned cache deleted', !keysAfter.includes('calibre-web-old-v0'), String(keysAfter));
  check('activate: shared cache preserved', keysAfter.includes('calibre-web-shared'));
  check('activate: own versioned cache preserved', keysAfter.includes(CACHE_NAME));

  // ---------------------------------------------------------- fetch routing --
  const navRequest = { url: ORIGIN_BASE, mode: 'navigate', method: 'GET' }; // Node Request rejects mode:navigate
  const navEv = await fire(w, 'fetch', { request: navRequest });
  check('navigation served (respondWith called)', !!navEv.__replied);
  const navResp = await navEv.__replied;
  const navText = await navResp.clone().text();
  check('navigation: cached index served before network',
    navText === 'net:' + new URL('./index.html', SW_URL).href, navText.slice(0, 80));

  w.networkOk = true;
  const infoUrl = new URL('./build-info.json', SW_URL).href;
  const hitsBefore = w.networkHits;
  const infoEv = await fire(w, 'fetch', { request: new Request(infoUrl) });
  const infoResp = await infoEv.__replied;
  check('build-info.json: network served when online', (await infoResp.text()).startsWith('net:') && w.networkHits > hitsBefore);

  // A NOT-precached same-origin asset: first fetch primes the cache (write-back),
  // second fetch with the network down must serve the cached copy.
  const assetUrl = new URL('./wasm/pyodide/pyodide.mjs', SW_URL).href;
  w.networkOk = true;
  await fire(w, 'fetch', { request: new Request(assetUrl) }); // primes cache
  w.networkOk = false;
  const assetEv = await fire(w, 'fetch', { request: new Request(assetUrl) });
  const assetResp = await assetEv.__replied;
  check('asset: cached copy served when offline',
    assetResp && (await assetResp.clone().text()).startsWith('net:'));

  // Navigation with nothing cached and network down -> offline.html fallback.
  w.networkOk = false;
  w.caches._stores.delete(CACHE_NAME);
  const offEv = await fire(w, 'fetch', { request: navRequest });
  const offResp = await offEv.__replied;
  check('offline navigation: 503 fallback body', offResp.status === 503);

  // share POST: files stashed, 303 redirect.
  w.networkOk = true;
  const fd = new FormData();
  fd.append('files', new File(['abc'], 'book.epub', { type: 'application/epub+zip' }));
  const shareUrl = new URL('./__share', SW_URL).href;
  const shareEv = await fire(w, 'fetch', { request: new Request(shareUrl, { method: 'POST', body: fd }) });
  const shareResp = await shareEv.__replied;
  check('share POST: answered with 303 redirect', shareResp.status === 303);
  check('share POST: redirects to ./', shareResp.headers.get('Location') === new URL('./', SW_URL).href);
  const sharedCache = await w.caches.open('calibre-web-shared');
  const sharedKeys = await sharedCache.keys();
  check('share POST: file stashed in the shared cache', sharedKeys.some(k => k.url.includes('__shared/0')));
  const stashed = await sharedCache.match(sharedKeys.find(k => k.url.includes('__shared/0')).url);
  check('share POST: file name travels in X-File-Name',
    stashed.headers.get('X-File-Name') === encodeURIComponent('book.epub'));
  check('share POST: count entry written', sharedKeys.some(k => k.url.endsWith('__shared/count')));

  // Non-GET, non-share POST: untouched.
  const postEv = await fire(w, 'fetch', { request: new Request(new URL('./app.js', SW_URL).href, { method: 'POST' }) });
  check('plain POST: not intercepted', !postEv.__replied);

  // data: URL: untouched.
  const dataEv = await fire(w, 'fetch', { request: new Request('data:text/plain,hi') });
  check('data: URL not intercepted', !dataEv.__replied);
}

// ================================================ world B: manifest broken --
{
  const w = makeWorld('broken');
  // A good previous build's cache exists and MUST survive.
  const good = new MockCache();
  good.map.set(new URL('./index.html', SW_URL).href, new Response('cached-index'));
  w.caches._stores.set('calibre-web-good-v9', good);

  await fire(w, 'install', {});
  check('broken manifest: install completes without skipWaiting (old worker stays)',
    w.firedEvents.skipWaiting !== true);
  check('broken manifest: failure is logged loudly',
    w.logs.some(([lvl, msg]) => lvl === 'error' && /__SW_ASSETS__/.test(msg)));

  await fire(w, 'activate', {});
  const keysAfter = await w.caches.keys();
  check('broken manifest: activate does NOT delete existing caches',
    keysAfter.includes('calibre-web-good-v9'), String(keysAfter));
  const stillGood = await w.caches.open('calibre-web-good-v9');
  check('broken manifest: good cache content intact',
    Boolean(await stillGood.match(new URL('./index.html', SW_URL).href)));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { failures.forEach(f => console.log('FAILED: ' + f)); process.exit(1); }
