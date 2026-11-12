/*
 * calibre WASM — service worker.
 *
 * Precaches the app shell (app.js, worker.js, icons, the pyodide runtime and
 * the calibre bundle) listed by the CI-generated sw-manifest.js and serves it
 * cache-first, so the whole engine keeps working offline after the first
 * load. Every URL is RELATIVE to this script's own location, so the site
 * works from any GitHub Pages subpath and a plain local static server.
 */

'use strict';

// Written by CI: node .github/scripts/generate-sw-manifest.mjs <site-dir>
// Defines self.__SW_VERSION__ and self.__SW_ASSETS__.
// During local development the file may not exist yet — a failed
// importScripts must not brick the install, so it is guarded.
try {
  importScripts('./sw-manifest.js');
} catch (err) {
  console.warn('[sw] sw-manifest.js unavailable, running without a precache list: ' + (err && err.message ? err.message : err));
}

var CACHE = 'calibre-web-' + (self.__SW_VERSION__ || 'dev');
// Files arriving via the manifest share_target are stashed under this FIXED
// name: the app-shell cache is version-keyed and deleted on every build, but
// a shared file the app has not consumed yet must survive an update.
var SHARED_CACHE = 'calibre-web-shared';
var ASSETS = Array.isArray(self.__SW_ASSETS__) ? self.__SW_ASSETS__.slice() : [];

// Absolute URLs for the precache list, resolved against this script's own
// location (works from any subpath the site is published under).
var ASSET_URLS = ASSETS.map(function (entry) {
  return new URL(entry, self.location).href;
});
var INDEX_URL = new URL('./index.html', self.location).href;
var OFFLINE_URL = new URL('./offline.html', self.location).href;
// Endpoint the manifest share_target POSTs to (intercepted in fetch).
var SHARE_URL = new URL('./__share', self.location);

// Last-resort navigation body, used only if offline.html itself is not cached.
var OFFLINE_HTML =
  '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width, initial-scale=1">' +
  '<meta name="color-scheme" content="dark light"><title>Offline</title></head>' +
  '<body style="margin:0;display:flex;align-items:center;justify-content:center;' +
  'min-height:100vh;font:16px/1.5 system-ui,sans-serif;background:#21252b;color:#e6e9ef">' +
  '<main style="max-width:34rem;margin:1.5rem;padding:2rem;text-align:center">' +
  '<h1 style="font-size:1.3rem">You are offline</h1>' +
  '<p>You are offline and this page was not cached.</p>' +
  '<p><button type="button" onclick="location.reload()" ' +
  'style="font:inherit;padding:.5rem 1rem;cursor:pointer">Retry</button></p>' +
  '</main></body></html>';

function offlineResponse() {
  return new Response(OFFLINE_HTML, {
    status: 503,
    statusText: 'Service Unavailable',
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}

function isHttp(url) {
  return url.protocol === 'http:' || url.protocol === 'https:';
}

function requestUrl(request) {
  try {
    return new URL(typeof request === 'string' ? request : request.url);
  } catch (err) {
    return null;
  }
}

/* ---------------------------------------------------------------- install */

self.addEventListener('install', function (event) {
  event.waitUntil(
    (async function () {
      if (ASSET_URLS.length === 0) {
        // sw-manifest.js failed to load (or is empty). FAIL CLOSED: do not
        // skipWaiting — a previously active worker (with a complete versioned
        // cache) keeps serving, and this worker must never delete caches if
        // it does activate (first install; see the activate guard). A
        // fail-open install here would replace a good build with an empty
        // 'calibre-web-dev' cache and wipe the user's offline engine with no
        // automatic repair: sw.js is byte-stable across builds, so no update
        // check would ever retry the failed importScripts.
        console.error('[sw] __SW_ASSETS__ is missing or empty — refusing to supersede the active worker');
        return;
      }
      const cache = await caches.open(CACHE);
      // Precache one by one: a single huge addAll() fails atomically, and the
      // ~36 MB payload should cache whatever it can on flaky links. Every
      // miss gets one retry — transient failures (flaky links, a CDN serving
      // its own stale 404s right after a redeploy) resolve on the second
      // pass. A durable hole self-heals online via the cache-first network
      // fallback's cache.put.
      let queue = ASSET_URLS;
      for (let pass = 1; pass <= 2 && queue.length; pass++) {
        const missed = [];
        await Promise.all(queue.map(async function (url) {
          try {
            await cache.add(new Request(url, { cache: 'reload' }));
          } catch (err) {
            console.warn('[sw] precache miss (pass ' + pass + '): ' + url +
              ' (' + (err && err.message ? err.message : err) + ')');
            missed.push(url);
          }
        }));
        queue = missed;
      }
      console.log('[sw] precache complete for ' + CACHE +
        (queue.length ? ' with ' + queue.length + ' hole(s): ' + queue.join(', ') : ''));
      await self.skipWaiting();
    })()
  );
});

/* --------------------------------------------------------------- activate */

self.addEventListener('activate', function (event) {
  event.waitUntil(
    (async function () {
      if (ASSET_URLS.length > 0) {
        const keys = await caches.keys();
        await Promise.all(
          keys
            .filter(function (key) { return key !== CACHE && key !== SHARED_CACHE; })
            .map(function (key) { return caches.delete(key); })
        );
      } else {
        // Manifest-less activation (first install with a broken
        // sw-manifest.js fetch): never delete the versioned caches — they are
        // the only complete copy of the engine this origin has.
        console.warn('[sw] activate without a manifest — leaving existing caches untouched');
      }
      await self.clients.claim();
    })()
  );
});

/* ------------------------------------------------------------------ fetch */

// Navigations: cache-first (the exact request, then ./index.html), then the
// network (uncached, so a new weekly build is picked up), then ./offline.html.
async function navigationResponse(request) {
  try {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(request, { ignoreSearch: true });
    if (hit) return hit;
    const index = await cache.match(INDEX_URL, { ignoreSearch: true });
    if (index) return index;
  } catch (err) {
    // Cache unavailable — fall through to the network.
  }

  try {
    return await fetch(request);
  } catch (err) {
    let offline = null;
    try {
      const cache = await caches.open(CACHE);
      offline = await cache.match(OFFLINE_URL, { ignoreSearch: true });
    } catch (err2) {
      offline = null;
    }
    return offline || offlineResponse();
  }
}

// build-info.json: network-first so the UI shows the fresh version, with a
// cached copy kept for offline use.
async function networkFirstResponse(request) {
  const cache = await caches.open(CACHE);
  let response;
  try {
    response = await fetch(request);
  } catch (err) {
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    throw err;
  }
  if (response && response.ok && response.status !== 206) {
    try {
      await cache.put(request, response.clone());
    } catch (err) {
      // Non-fatal: the response is still returned to the page.
    }
  }
  return response;
}

// Everything else same-origin: cache-first, then network (cache the result).
async function cacheFirstResponse(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request, { ignoreSearch: true });
  if (hit) return hit;

  const response = await fetch(request);
  if (response && response.ok && response.status !== 206 && response.type !== 'opaque') {
    try {
      await cache.put(request, response.clone());
    } catch (err) {
      // Non-fatal: the response is still returned to the caller.
    }
  }
  return response;
}

/* ----------------------------------------------------------- share target */

// Android share sheet: the manifest points share POSTs at ./__share. The
// multipart files are stashed in SHARED_CACHE under synthetic URLs (the real
// name travels in a header) for the app to consume on the next load, and the
// navigation is answered with a 303 redirect — a 200 would leave the browser
// on a blank page whose reload re-POSTs the form. Every failure path still
// redirects: the share must never strand the user.
async function handleSharePost(request) {
  try {
    const form = await request.formData();
    const files = form.getAll('files').filter(function (v) { return v instanceof Blob; });
    const cache = await caches.open(SHARED_CACHE);
    // Clear leftovers from a previous, never-consumed share first.
    const stale = await cache.keys();
    await Promise.all(stale.map(function (key) { return cache.delete(key); }));
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      await cache.put(
        new URL('./__shared/' + i, self.location).href,
        new Response(file, {
          headers: {
 'X-File-Name': encodeURIComponent(file.name || ('file' + i)),
            'Content-Type': file.type || 'application/octet-stream'
          }
        })
      );
    }
    await cache.put(
      new URL('./__shared/count', self.location).href,
      new Response(String(files.length), {
        headers: { 'Content-Type': 'text/plain' }
      })
    );
  } catch (err) {
    console.warn('[sw] share-target handling failed: ' + (err && err.message ? err.message : err));
  }
  return new Response(null, {
    status: 303,
    headers: { Location: new URL('./', self.location).href }
  });
}

self.addEventListener('fetch', function (event) {
  const request = event.request;
  // POST is let through only for the share-target branch below; every other
  // non-GET method is left to the browser.
  if (!request || (request.method !== 'GET' && request.method !== 'POST')) return;

  const url = requestUrl(request);
  if (!url || !isHttp(url)) return; // data:, blob:, ... — untouched

  if (request.method === 'POST') {
    if (url.origin === SHARE_URL.origin && url.pathname === SHARE_URL.pathname) {
      event.respondWith(handleSharePost(request));
    }
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(navigationResponse(request));
    return;
  }

  if (url.origin !== self.location.origin) {
    // Cross-origin: plain fetch, never cached (there should be none).
    event.respondWith(fetch(request));
    return;
  }

  if (url.pathname.endsWith('/build-info.json')) {
    event.respondWith(networkFirstResponse(request));
    return;
  }

  event.respondWith(cacheFirstResponse(request));
});
