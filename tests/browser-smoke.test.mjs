#!/usr/bin/env node
/*
 * Browser smoke test — the gate the Node harness structurally cannot be.
 *
 * The Node integration test proves the bundle and the worker protocol work,
 * but pyodide's runtime-environment guards (like the rejection of classic
 * web workers) only fire in a BROWSER: under Node, pyodide's env detection
 * short-circuits to IN_NODE and those branches never run. This test serves
 * the deployed tree and drives real headless Chromium (Playwright) through
 * the actual runtime path: app.js spawning worker.js as a module worker,
 * the pyodide boot with its browser-only checks, ESM/wasm MIME handling,
 * and a real TXT->EPUB conversion.
 *
 * Usage: node tests/browser-smoke.test.mjs [site-dir]
 *   site-dir defaults to the repo root (local dev layout with ./wasm).
 *   CI points it at the staged site-publish tree.
 *
 * SKIPPED (exit 0) when the site has no engine, or playwright / its Chromium
 * binary are not installed — CI installs both; local runs do not require
 * them.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const SITE = process.argv[2] ? path.resolve(process.argv[2]) : REPO;

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (extra ? ' -- ' + extra : '')); }
}

if (!fs.existsSync(path.join(SITE, 'wasm', 'pyodide', 'pyodide.mjs')) ||
    !fs.existsSync(path.join(SITE, 'wasm', 'calibre-bundle.zip'))) {
  console.log(`SKIPPED (no engine under ${SITE}/wasm; run patches/build-bundle.sh first)`);
  process.exit(0);
}

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.log('SKIPPED (playwright not installed — npm i --no-save playwright && npx playwright install chromium)');
  process.exit(0);
}

// Explicit MIME map: WebAssembly.instantiateStreaming requires
// application/wasm and module imports require a JavaScript MIME type —
// exactly the kind of thing only a real HTTP server + browser can validate.
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.zip': 'application/zip',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  let rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
  if (rel === '' || rel.endsWith('/')) rel += 'index.html';
  const file = path.resolve(SITE, '.' + path.sep + rel);
  if (!file.startsWith(SITE + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
    return;
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
  });
  fs.createReadStream(file).pipe(res);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const BASE = `http://127.0.0.1:${server.address().port}/`;
console.log('serving', SITE, 'at', BASE);

let browser;
try {
  browser = await chromium.launch({ args: ['--no-sandbox'] });
} catch (err) {
  console.log('SKIPPED (chromium unavailable: ' + String(err.message).split('\n')[0] +
    ' — npx playwright install chromium)');
  server.close();
  process.exit(0);
}

try {
  const page = await browser.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

  await page.goto(BASE, { waitUntil: 'load' });

  // 1. The app's own boot: app.js must spawn the module worker and reach
  //    "Engine ready" (it unhides #converter on the ready boot-progress
  //    message; a worker crash writes "failed" into #boot-text).
  let booted = false;
  try {
    await page.waitForFunction(() => {
      const b = document.getElementById('boot-text');
      if (b && /failed/i.test(b.textContent || '')) throw new Error(b.textContent);
      const c = document.getElementById('converter');
      return Boolean(c && !c.hidden);
    }, null, { timeout: 240000, polling: 500 });
    booted = true;
    check('app boots engine in real Chromium (converter visible)', true);
  } catch (err) {
    const bootText = await page.evaluate(
      () => (document.getElementById('boot-text') || {}).textContent || ''
    ).catch(() => '');
    check('app boots engine in real Chromium (converter visible)', false,
      (String(err.message).split('\n')[0] + ' | boot-text: ' + bootText).slice(0, 300));
  }

  // 2. Drive the worker message protocol directly in the page: init, then a
  //    real conversion with output validation.
  if (booted) {
    const conv = await page.evaluate(async () => {
      const worker = new Worker('./worker.js', { type: 'module' });
      const wait = (id, wantType, ms) => new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('timeout waiting for id=' + id)), ms);
        worker.onmessage = (ev) => {
          const m = ev.data || {};
          if (m.type === 'error') { clearTimeout(t); reject(new Error(m.message)); return; }
          if (m.id === id && (!wantType || m.type === wantType)) { clearTimeout(t); resolve(m); }
        };
        worker.onerror = (e) => { clearTimeout(t); reject(new Error('worker error: ' + (e.message || 'unknown'))); };
      });
      const ready = wait(1, null, 240000);
      worker.postMessage({ id: 1, type: 'init' });
      await ready;
      const txt = 'Browser Smoke\n\n' + 'The quick brown fox jumps over the lazy dog. '.repeat(40);
      const done = wait(2, 'convert-result', 240000);
      worker.postMessage({
        id: 2, type: 'convert', name: 'smoke.txt',
        input: new TextEncoder().encode(txt).buffer, outputFormat: 'epub',
      });
      const r = await done;
      const head = new Uint8Array(r.data.slice(0, 2));
      worker.terminate();
      return { name: r.name, size: r.size, magic: [head[0], head[1]] };
    }).catch((err) => ({ error: String(err.message || err) }));

    if (conv.error) {
      check('in-page conversion TXT->EPUB returns a result', false, conv.error.slice(0, 200));
      check('in-page EPUB has zip magic', false, 'no result');
    } else {
      check('in-page conversion TXT->EPUB returns a result', conv.size > 1000,
        JSON.stringify(conv).slice(0, 150));
      check('in-page EPUB has zip magic', conv.magic[0] === 0x50 && conv.magic[1] === 0x4b,
        String(conv.magic));
    }
  }

  // 3. No uncaught page errors, and the classic-worker rejection — the bug
  //    this suite exists for — must never surface anywhere.
  check('no uncaught page errors', pageErrors.length === 0,
    pageErrors.slice(0, 3).join(' | ').slice(0, 300));
  const allErrors = pageErrors.concat(consoleErrors).join('\n');
  check('no "Classic web workers" rejection anywhere', !/Classic web workers/i.test(allErrors));
  if (consoleErrors.length) {
    console.log('console errors seen (non-fatal):');
    consoleErrors.slice(0, 5).forEach((e) => console.log('  ' + e.slice(0, 200)));
  }
} finally {
  await browser.close();
  server.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
