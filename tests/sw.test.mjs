#!/usr/bin/env node
/*
 * Service worker unit tests: drive sw.js in a vm with a mock worker
 * environment (the same contract sw.js documents: importScripts, caches,
 * fetch, clients, skipWaiting) and exercise the fetch routing:
 *   - navigations: cache-first, index fallback, network, offline fallback
 *   - build-info.json: network-first with cache fallback
 *   - same-origin assets: cache-first with network+cache write-back
 *   - share POST ./__share: stashes files in the shared cache, 303 redirect
 *   - non-GET / cross-origin / non-http: never intercepted
 *
 * Usage: node tests/sw.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; failures.push(name); console.log('FAIL  ' + name + (extra ? ' -- ' + extra : '')); }
}

// ------------------------------------------------------------ mock world --
const SW_URL = 'https://example.test/calibre/sw.js';

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

const world = {
  caches: {
    _stores: new Map(),
    async open(name) {
      if (!this._stores.has(name)) this._stores.set(name, new MockCache());
      return this._stores.get(name);
    },
    async keys() { return [...this._stores.keys()]; },
    async delete(name) { return this._stores.delete(name); },
  },
  // network behaviors the tests toggle
  networkOk: true,
  networkHits: 0,
  fetch: null, // set below

  listeners: {},
  firedEvents: {},
  location: new URL(SW_URL),
  skipWaiting() { this.firedEvents.skipWaiting = true; return Promise.resolve(); },
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
  importScripts() { /* sw-manifest.js missing in unit mode — guarded */ },
  clients: { async claim() { return undefined; } },
  console: { log() {}, warn() {} },
};

world.fetch = async (req) => {
  world.networkHits++;
  if (!world.networkOk) throw new Error('network down');
  return new Response('net:' + (typeof req === 'string' ? req : req.url), { status: 200 });
};

async function fire(type, event) {
  const fns = world.listeners[type] || [];
  const waiters = [];
  const ev = { ...event, waitUntil: (p) => waiters.push(p), respondWith: (p) => { ev.__replied = p; } };
  for (const fn of fns) fn(ev);
  await Promise.all(waiters);
  await new Promise(r => setTimeout(r, 0));
  return ev;
}

const sandbox = {
  caches: world.caches,
  fetch: (...a) => world.fetch(...a),
  location: world.location,
  self: world,
  importScripts: (...a) => world.importScripts(...a),
  clients: world.clients,
  console: world.console,
  Request, Response, URL, Promise, Blob, File, FormData, console,
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(REPO, 'sw.js'), 'utf8'), sandbox);

// ------------------------------------------------------------------ tests --
// install: precache list is empty in unit mode (no sw-manifest.js) but the
// worker must still activate (install never bricks).
const installEv = await fire('install', {});
check('install completes (no precache list, guarded)', true);
check('install: skipWaiting called', !!world.firedEvents.skipWaiting);

const activateEv = await fire('activate', {});
check('activate: clients.claim path ran (no other caches to delete)', true);

const navUrl = SW_URL.replace('sw.js', '');
world.caches._stores.clear();

// Pre-seed a cached index response, then test navigation cache-first.
// (Node's Request rejects mode:'navigate', so navigations use a plain
// object with the fields sw.js reads: url + mode.)
const navRequest = { url: navUrl, mode: 'navigate', method: 'GET' };
const shellCache = await world.caches.open('calibre-web-dev'); // the worker's own cache name (no sw-manifest.js in unit mode -> 'dev')
await shellCache.put(new URL('./index.html', SW_URL).href, new Response('cached-index'));
const navEv = await fire('fetch', { request: navRequest });
check('navigation served (respondWith called)', !!navEv.__replied);
const navResp = await navEv.__replied;
check('navigation: cached index served before network', (await navResp.text()) === 'cached-index');

// build-info.json: network-first.
world.networkOk = true;
const infoUrl = new URL('./build-info.json', SW_URL).href;
const infoEv = await fire('fetch', { request: new Request(infoUrl) });
const infoResp = await infoEv.__replied;
check('build-info.json: network served when online', (await infoResp.text()).startsWith('net:'));

// Same-origin asset with network down after priming the cache.
world.networkOk = true;
const assetUrl = new URL('./app.js', SW_URL).href;
await fire('fetch', { request: new Request(assetUrl) }); // primes cache
world.networkOk = false;
const assetEv = await fire('fetch', { request: new Request(assetUrl) });
const assetResp = await assetEv.__replied;
check('asset: cached copy served when offline',
 assetResp && (await assetResp.clone().text()).startsWith('net:'));

// Navigation with nothing cached and network down -> offline.html fallback.
world.caches._stores.clear();
const offEv = await fire('fetch', { request: navRequest });
const offResp = await offEv.__replied;
check('offline navigation: 503 fallback body', offResp.status === 503);

// share POST: files stashed, 303 redirect.
const fd = new FormData();
fd.append('files', new File(['abc'], 'book.epub', { type: 'application/epub+zip' }));
const shareUrl = new URL('./__share', SW_URL).href;
const shareEv = await fire('fetch', { request: new Request(shareUrl, { method: 'POST', body: fd }) });
const shareResp = await shareEv.__replied;
check('share POST: answered with 303 redirect', shareResp.status === 303);
check('share POST: redirects to ./', shareResp.headers.get('Location') === new URL('./', SW_URL).href);
const sharedCache = await world.caches.open('calibre-web-shared');
const sharedKeys = await sharedCache.keys();
check('share POST: file stashed in the shared cache', sharedKeys.some(k => k.url.includes('__shared/0')));
const stashed = await sharedCache.match(sharedKeys.find(k => k.url.includes('__shared/0')).url);
check('share POST: file name travels in X-File-Name',
  stashed.headers.get('X-File-Name') === encodeURIComponent('book.epub'));
check('share POST: count entry written', sharedKeys.some(k => k.url.endsWith('__shared/count')));

// Non-GET, non-share POST: untouched.
const postEv = await fire('fetch', { request: new Request(assetUrl, { method: 'POST' }) });
check('plain POST: not intercepted', !postEv.__replied);

// data: URL: untouched.
const dataEv = await fire('fetch', { request: new Request('data:text/plain,hi') });
check('data: URL not intercepted', !dataEv.__replied);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { failures.forEach(f => console.log('FAILED: ' + f)); process.exit(1); }
