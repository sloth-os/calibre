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
 * Usage: node tests/browser-smoke.test.mjs [site-dir] [--require-ran]
 *   site-dir defaults to the repo root (local dev layout with ./wasm).
 *   CI points it at the staged site-publish tree and passes --require-ran.
 *
 * The site is served UNDER THE /calibre/ SUBPATH — production geometry
 * (https://sloth-os.github.io/calibre/). Root-absolute URLs ('/worker.js')
 * 404 here exactly like they do on Pages, so a subpath-breaking regression
 * fails this suite instead of shipping.
 *
 * SKIPPED (exit 0) when the site has no engine, or playwright / its Chromium
 * binary are not installed — local runs do not require them. With
 * --require-ran (CI) every skip is a hard failure: the deploy must never
 * proceed on zero browser verification.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const ARGS = process.argv.slice(2);
const REQUIRE_RAN = ARGS.includes('--require-ran');
const SITE_ARG = ARGS.find((a) => !a.startsWith('--'));
const SITE = SITE_ARG ? path.resolve(SITE_ARG) : REPO;

function skip(reason) {
  if (REQUIRE_RAN) {
    console.error('FAIL (--require-ran): ' + reason);
    process.exit(1);
  }
  console.log('SKIPPED (' + reason + ')');
  process.exit(0);
}

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (extra ? ' -- ' + extra : '')); }
}

if (!fs.existsSync(path.join(SITE, 'wasm', 'pyodide', 'pyodide.mjs')) ||
    !fs.existsSync(path.join(SITE, 'wasm', 'calibre-bundle.zip'))) {
  skip(`no engine under ${SITE}/wasm; run patches/build-bundle.sh first`);
}

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  skip('playwright not installed — npm i --no-save playwright && npx playwright install chromium');
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

// Production mounts the site under a subpath; serve it the same way so
// root-absolute URL regressions fail here instead of on the live site.
const PREFIX = 'calibre/';
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = decodeURIComponent(u.pathname).replace(/^\/+/, '');
  if (!p.startsWith(PREFIX)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found (the site is served under /' + PREFIX + ' only, like production)');
    return;
  }
  let rel = p.slice(PREFIX.length);
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
const BASE = `http://127.0.0.1:${server.address().port}/${PREFIX}`;
console.log('serving', SITE, 'at', BASE);

let browser;
try {
  browser = await chromium.launch({ args: ['--no-sandbox'] });
} catch (err) {
  skip('chromium unavailable: ' + String(err.message).split('\n')[0] +
    ' — npx playwright install chromium');
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

  // 3. UI-level profile chooser: drive the REAL controls (file input ->
  //    profile select -> Convert button) — the only gate that executes
  //    app.js's renderProfileOptions/doConvert payload logic in a browser.
  //    The dropdown must be engine-populated (default + kindle + …), and a
  //    kindle MOBI conversion must echo the RESOLVED profile into the log.
  if (booted) {
    // loadFormats() runs right after boot; wait for the dropdown to be
    // populated and unhidden before asserting on it.
    try {
      await page.waitForFunction(() => {
        const s = document.getElementById('profile-select');
        return Boolean(s && !s.hidden && s.options.length > 0);
      }, null, { timeout: 60000, polling: 250 });
    } catch { /* surfaced by the checks below */ }
    const profile = await page.evaluate(async () => {
      const sel = document.getElementById('profile-select');
      if (!sel || sel.hidden) return { error: 'profile select missing or hidden' };
      const values = Array.prototype.map.call(sel.options, (o) => o.value);
      const labels = Array.prototype.map.call(sel.options, (o) => o.textContent);
      const titleOf = (v) => {
        const o = sel.querySelector('option[value="' + v + '"]');
        return o ? o.title : '';
      };
      return {
        count: values.length,
        first: values[0],
        firstLabel: labels[0],
        hasKindle: values.indexOf('kindle') >= 0,
        hasTablet: values.indexOf('tablet') >= 0,
        hasDefaultTitle: Boolean(sel.querySelector('option[value="default"]').title),
        // Content assertions on the formatting rules, not just non-emptiness:
        // kindle's screen is (525, 640) in profiles.py -> '525 × 640 px', and
        // tablet carries the (10000, 10000) sentinel -> 'unlimited' (the GUI's
        // width>=10000 rule, page_setup.py). A broken sentinel test, a dropped
        // ' × ', or string-typed screen entries must fail here.
        kindleTitle: titleOf('kindle'),
        tabletTitle: titleOf('tablet'),
      };
    }).catch((err) => ({ error: String(err.message || err) }));

    if (profile.error) {
      check('UI: profile dropdown populated from the engine', false, profile.error);
    } else {
      check('UI: profile dropdown populated from the engine',
        profile.count > 30 && profile.first === 'default' && profile.hasKindle && profile.hasTablet,
        JSON.stringify(profile));
      check('UI: default option labeled GUI-style with a tooltip',
        profile.firstLabel === 'Default profile' && profile.hasDefaultTitle,
        JSON.stringify({ firstLabel: profile.firstLabel, hasDefaultTitle: profile.hasDefaultTitle }));
      // The formatting rules must be correct in content, not merely present:
      // kindle -> '525 × 640 px', tablet -> 'unlimited' (width>=10000 sentinel).
      check('UI: tooltip formats screen size GUI-style (525 × 640 px / unlimited)',
        /525 × 640 px/.test(profile.kindleTitle || '') &&
        /unlimited/.test(profile.tabletTitle || '') &&
        !/10000/.test(profile.tabletTitle || ''),
        JSON.stringify({ kindleTitle: profile.kindleTitle, tabletTitle: profile.tabletTitle }));
    }

    if (!profile.error) {
      const txt = 'Profile UI Smoke\n\n' + 'The quick brown fox jumps over the lazy dog. '.repeat(60);
      await page.setInputFiles('#file-input', {
        name: 'ui-smoke.txt', mimeType: 'text/plain', buffer: Buffer.from(txt, 'utf8'),
      });
      // Wait for the INTAKE-COMPLETE signal, not just #book-panel visibility:
      // renderBook() unhides the panel synchronously, but book.data is only
      // assigned after file.arrayBuffer() resolves, and doConvert()
      // early-returns (silently — no status change, no error) while
      // book.data is still undefined. The status line flips to 'Loaded …'
      // inside the same .then that assigns book.data and enables Convert,
      // so keying on it guarantees the click below cannot no-op into the
      // 300s download-row timeout on a CPU-starved CI runner.
      await page.waitForFunction(() => {
        const b = document.getElementById('book-panel');
        const s = document.getElementById('status');
        return Boolean(b && !b.hidden && s && /Loaded/.test(s.textContent || ''));
      }, null, { timeout: 30000, polling: 200 });

      // Persistent description of the SELECTED profile (#profile-note, wired
      // via aria-describedby): option titles are hover-only and never reach
      // touch pickers or screen readers. With 'default' still selected the
      // note must be visible and equal the selected option's title, then
      // follow the selection on change. (These run AFTER the book panel is
      // shown — the select lives inside #book-panel and Playwright's
      // selectOption requires a visible element.)
      const note0 = await page.evaluate(() => {
        const sel = document.getElementById('profile-select');
        const note = document.getElementById('profile-note');
        return {
          exists: Boolean(note),
          visible: Boolean(note && !note.hidden),
          text: note ? note.textContent : '',
          selectedTitle: sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].title : '',
        };
      });
      check('UI: selected profile description shown persistently (#profile-note)',
        note0.exists && note0.visible && note0.text.length > 0 && note0.text === note0.selectedTitle,
        JSON.stringify(note0).slice(0, 300));

      await page.selectOption('#format-select', 'mobi');
      await page.selectOption('#profile-select', 'kindle');
      const note1 = await page.evaluate(() => {
        const sel = document.getElementById('profile-select');
        return {
          text: document.getElementById('profile-note').textContent,
          selectedTitle: sel.options[sel.selectedIndex].title,
        };
      });
      check('UI: profile note follows the selection on change',
        note1.text === note1.selectedTitle && /kindle/i.test(note1.text),
        JSON.stringify(note1).slice(0, 300));

      // Narrow viewport: the 40-profile select's intrinsic width (~337px
      // from 'PocketBook PocketBook HD Touch (1-3)') must be clamped by the
      // global select rule (max-width:100%; min-width:0) so it cannot spill
      // out of the converter card at 320px — the smallest common Android
      // width. Scoped to the select-vs-card containment that THIS feature's
      // CSS fixes; the page also has a pre-existing #net-status header pill
      // that overflows 320px independently of the profile chooser, so a
      // whole-document scroll assertion would flag an unrelated issue.
      await page.setViewportSize({ width: 320, height: 800 });
      const geo = await page.evaluate(() => {
        const sel = document.getElementById('profile-select').getBoundingClientRect();
        const card = document.getElementById('converter').getBoundingClientRect();
        return {
          selRight: Math.round(sel.right), selWidth: Math.round(sel.width),
          cardRight: Math.round(card.right), cardLeft: Math.round(card.left),
          selLeft: Math.round(sel.left),
        };
      });
      check('UI: profile select stays inside the card at 320px viewport (no overflow)',
        geo.selRight <= geo.cardRight + 1 && geo.selLeft >= geo.cardLeft - 1,
        JSON.stringify(geo));
      await page.setViewportSize({ width: 1280, height: 800 });

      await page.click('#convert-btn');
      // Dynamic coverage of the busy contract (a review verifier proved no
      // suite asserted it: deleting setBusy(false) from the success path
      // passed everything). Right after the click all four controls must be
      // DISABLED (a mid-flight select change would silently diverge from the
      // captured payload), and re-enabled once the download row lands — a
      // missing setBusy(false) strands them disabled and fails here.
      let busyState = null;
      try {
        await page.waitForFunction(() => document.getElementById('convert-btn').disabled,
          null, { timeout: 5000, polling: 50 });
        busyState = await page.evaluate(() => ({
          convert: document.getElementById('convert-btn').disabled,
          clear: document.getElementById('clear-btn').disabled,
          format: document.getElementById('format-select').disabled,
          profile: document.getElementById('profile-select').disabled,
        }));
      } catch { busyState = { error: 'convert button never entered busy state' }; }
      check('UI: all controls disabled while converting (setBusy(true))',
        Boolean(busyState) && !busyState.error &&
        busyState.convert && busyState.clear && busyState.format && busyState.profile,
        JSON.stringify(busyState));

      // One-job-at-a-time guard, dynamically: an intake (picker/drop/paste/
      // share) can land WHILE job A converts — the dropzone is never disabled.
      // handleIncomingFiles must NOT re-enable Convert in that window (the
      // old unconditional `convertBtn.disabled = false` left a clickable
      // button next to the frozen selects and let a second doConvert() stack
      // onto the worker queue; job A's settle then cleared `converting` and
      // un-deferred the SW reload mid-flight). Load a second book now and
      // require Convert to stay disabled until job A produces its download
      // row. The `dlRow ||` disjunct keeps this honest on both sides of the
      // race: if the engine somehow finished before the intake resolved,
      // Convert SHOULD be enabled again (book B is idle-ready) — the only
      // failing state is job-A-still-running with Convert clickable.
      if (!busyState || !busyState.error) {
        await page.setInputFiles('#file-input', {
          name: 'intake-midflight.txt', mimeType: 'text/plain',
          buffer: Buffer.from('Second book during conversion\n', 'utf8'),
        });
        let midState;
        try {
          // Race-safe wait: whichever settles first — book B's 'Loaded'
          // status, or job A's download row (which overwrites the status
          // with 'Converted to …', so /Loaded/ alone could never match in
          // that order and would hang into a false failure).
          await page.waitForFunction(() => {
            const s = document.getElementById('status');
            return Boolean((s && /Loaded/.test(s.textContent || '')) ||
              document.querySelector('#downloads .dl-row'));
          }, null, { timeout: 30000, polling: 100 });
          midState = await page.evaluate(() => ({
            dlRow: Boolean(document.querySelector('#downloads .dl-row')),
            convertDisabled: document.getElementById('convert-btn').disabled,
            selectsDisabled: document.getElementById('format-select').disabled &&
              document.getElementById('profile-select').disabled,
          }));
        } catch (err) {
          midState = { error: String(err.message).split('\n')[0] };
        }
        check('UI: mid-conversion intake cannot re-enable Convert (one job at a time)',
          Boolean(midState) && !midState.error &&
          (midState.dlRow || (midState.convertDisabled && midState.selectsDisabled)),
          JSON.stringify(midState).slice(0, 250));
      }
      let uiConv = null;
      try {
        await page.waitForFunction(() => document.querySelector('#downloads .dl-row'),
          null, { timeout: 300000, polling: 500 });
        uiConv = await page.evaluate(() => ({
          console: document.getElementById('console').textContent,
          dlName: (document.querySelector('#downloads .dl-row') || {}).textContent || '',
          reenabled: ['convert-btn', 'clear-btn', 'format-select', 'profile-select']
            .every((id) => !document.getElementById(id).disabled),
        }));
      } catch (err) {
        uiConv = { error: String(err.message).split('\n')[0],
          console: await page.evaluate(() => (document.getElementById('console') || {}).textContent || '').catch(() => '') };
      }
      const echoOk = /output profile: kindle/.test(uiConv.console || '');
      const mobiRow = /ui-smoke\.mobi/.test(uiConv.dlName || '');
      check('UI: kindle-profile conversion downloads a MOBI and echoes the resolved profile',
        !uiConv.error && echoOk && mobiRow && uiConv.reenabled,
        JSON.stringify({ echoOk, mobiRow, reenabled: uiConv.reenabled, err: uiConv.error, tail: (uiConv.console || '').slice(-200) }).slice(0, 400));
    }
  }

  // 4. No uncaught page errors, and the classic-worker rejection — the bug
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
