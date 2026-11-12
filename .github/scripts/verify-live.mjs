#!/usr/bin/env node
// Post-deploy verification against the LIVE origin.
//
// Usage: node verify-live.mjs <base-url> <staged-dir>
//   base-url   e.g. https://sloth-os.github.io/calibre/  (trailing slash)
//   staged-dir the exact tree that was uploaded (the Pages artifact)
//
// Every pre-deploy gate runs on the runner; the live origin adds the two
// things no local server reproduces: the /calibre/ subpath and Fastly's real
// MIME + caching behaviour. Both production incidents (flattened pyodide
// geometry, classic-worker rejection) were found by a human loading the site
// — this script is that human, in CI.
//
// Checks:
//   1. propagation: plain-URL polls (what a client sees, no cache buster)
//      until live sw-manifest.js and build-info.json are byte-identical to
//      the staged tree
//   2. key text assets byte-identical (worker.js, app.js, sw.js, index.html,
//      manifest.webmanifest, offline.html)
//   3. every URL in the LIVE sw-manifest precache list returns 200 with the
//      MIME type the runtime requires (.mjs/.js JavaScript, .wasm
//      application/wasm, .webmanifest manifest+json, ...)
//
// Node >= 18 (global fetch), zero npm dependencies. Exit 0 = live site good.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const USAGE = 'usage: node verify-live.mjs <base-url> <staged-dir>';
const BASE = (process.argv[2] || '').replace(/\/?$/, '/');
const STAGED = process.argv[3] ? path.resolve(process.argv[3]) : '';
if (!/^https?:\/\//.test(BASE) || !STAGED) {
  console.error(`verify-live: bad arguments\n${USAGE}`);
  process.exit(2);
}

let failures = 0;
let checks = 0;
function check(name, ok, detail) {
  checks++;
  if (ok) console.log(`  ok    ${name}`);
  else { failures++; console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`); }
}
const md5 = (buf) => crypto.createHash('md5').update(buf).digest('hex');
const staged = (rel) => fs.readFileSync(path.join(STAGED, rel));

async function get(url) {
  const res = await fetch(url, { redirect: 'follow' });
  return res;
}

// ------------------------------------------------------- 1. propagation ----
// GitHub purges the Pages CDN on deploy, but edges can lag for minutes. Poll
// with PLAIN urls (exactly what a returning client requests — no cache
// buster) until the deployment markers match the staged bytes.
const MARKERS = ['sw-manifest.js', 'build-info.json'];
const MAX_TRIES = 24;        // 24 * 20 s = 8 minutes
const POLL_MS = 20_000;
console.log(`verify-live: waiting for ${BASE} to serve the deployed bytes`);
let propagated = false;
for (let i = 1; i <= MAX_TRIES && !propagated; i++) {
  let allMatch = true;
  for (const rel of MARKERS) {
    const res = await get(BASE + rel).catch((e) => ({ ok: false, error: e }));
    if (!res.ok) { allMatch = false; break; }
    const body = Buffer.from(await res.arrayBuffer());
    if (md5(body) !== md5(staged(rel))) { allMatch = false; break; }
  }
  if (allMatch) { propagated = true; break; }
  if (i < MAX_TRIES) await new Promise((r) => setTimeout(r, POLL_MS));
}
check('live origin serves the deployed sw-manifest.js + build-info.json', propagated,
  `still stale/mismatched after ${MAX_TRIES * POLL_MS / 1000}s`);
if (!propagated) {
  // Diagnose: is the ORIGIN updated but the edge stale (cache-buster fetch)?
  for (const rel of MARKERS) {
    const busted = await get(`${BASE + rel}?cb=${Date.now()}`).catch(() => null);
    if (busted && busted.ok) {
      const body = Buffer.from(await busted.arrayBuffer());
      console.log(`  note  ${rel}?cb= md5 ${md5(body) === md5(staged(rel)) ? 'MATCHES staged (edge cache lag only)' : 'DIFFERS from staged even with cache buster'}`);
    }
  }
}

// ---------------------------------------------------- 2. key text assets ----
console.log('key assets byte-identical to staged tree');
for (const rel of ['worker.js', 'app.js', 'sw.js', 'index.html', 'manifest.webmanifest', 'offline.html']) {
  const res = await get(`${BASE + rel}?cb=${Date.now()}`).catch((e) => ({ ok: false, error: e }));
  if (!res.ok) { check(`${rel} fetchable`, false, `HTTP ${res.status || res.error}`); continue; }
  const body = Buffer.from(await res.arrayBuffer());
  check(`${rel} md5 matches staged`, md5(body) === md5(staged(rel)),
    `live ${md5(body)} vs staged ${md5(staged(rel))}`);
}

// ------------------------------------------- 3. precache URLs + live MIME ----
console.log('live precache manifest: every URL 200 with correct MIME');
const manifestSrc = (await (await get(`${BASE}sw-manifest.js?cb=${Date.now()}`)).text());
const start = manifestSrc.indexOf('self.__SW_ASSETS__ = [');
const end = manifestSrc.indexOf('];', start);
let assets = [];
try {
  assets = JSON.parse(manifestSrc.slice(start + 'self.__SW_ASSETS__ = '.length, end + 1));
} catch (err) {
  check('live sw-manifest.js parses', false, err.message);
}
check(`live asset list non-empty (${assets.length} entries)`, assets.length > 0);

const MIME_REQUIRED = {
  '.mjs': /javascript/i,
  '.js': /javascript/i,
  '.wasm': /^application\/wasm/i,
  '.webmanifest': /manifest\+json/i,
  '.html': /text\/html/i,
  '.json': /json/i,
  '.png': /image\/png/i,
  '.svg': /image\/svg/i,
  '.zip': /(zip|x-zip)/i,
};
for (const asset of assets) {
  const url = new URL(asset, BASE).href;
  const res = await fetch(url, { method: 'HEAD' }).catch((e) => ({ ok: false, status: 0, headers: new Map(), error: e }));
  const ext = path.posix.extname(new URL(asset, BASE).pathname).toLowerCase();
  const ctype = res.headers ? String(res.headers.get('content-type') || '') : '';
  const want = MIME_REQUIRED[ext];
  check(`${asset} 200`, res.ok || res.status === 206, `HTTP ${res.status}${res.error ? ' ' + res.error.message : ''}`);
  if (want) {
    check(`${asset} content-type ${want.source}`, want.test(ctype), `got '${ctype}'`);
  }
}

console.log(`\nverify-live: ${checks - failures}/${checks} checks passed`);
if (failures) {
  console.error(`::error::live verification failed: ${failures} problem(s) at ${BASE}`);
  process.exit(1);
}
