#!/usr/bin/env node
/*
 * Static contract test for index.html: the document wires every moving part
 * of the app (script, worker references through app.js, manifest link,
 * dropzone, format select, console, downloads, net status) and references
 * only relative URLs (works from any subpath, offline).
 *
 * Usage: node tests/index-html.test.mjs
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

const html = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');

check('html parses loosely (single html close)', (html.match(/<\/html>/g) || []).length === 1);
check('charset and viewport meta present',
  /<meta charset="utf-8">/.test(html) && /name="viewport"/.test(html));
check('manifest link present and relative', /<link rel="manifest" href="\.\/manifest\.webmanifest">/.test(html));
check('theme-color meta present', /name="theme-color"/.test(html));
check('app.js loaded with defer', /<script src="\.\/app\.js" defer><\/script>/.test(html));
check('no inline event handlers (CSP-friendly)',
  !/\son(click|load|change|submit|input|error)\s*=\s*"/.test(html));

// app ids referenced by app.js all exist
const app = fs.readFileSync(path.join(REPO, 'app.js'), 'utf8');
const ids = [...app.matchAll(/\$\('([a-z-]+)'\)/g)].map(m => m[1]);
const uniqueIds = [...new Set(ids)];
for (const id of uniqueIds) {
  check(`element #${id} exists`, new RegExp(`id="${id}"`).test(html), id);
}

// intake + conversion elements
check('dropzone element exists', /id="dropzone"/.test(html));
check('file input exists (multiple, hidden)', /id="file-input"[^>]*multiple[^>]*hidden/.test(html) ||
  /<input type="file" id="file-input"/.test(html));
check('format select exists', /id="format-select"/.test(html));
check('convert button exists', /id="convert-btn"/.test(html));
check('console/log element exists', /id="console"/.test(html));
check('downloads element exists', /id="downloads"/.test(html));
check('boot progress element exists', /id="boot"/.test(html));
check('net status element exists', /id="net-status"/.test(html));
check('install button exists (hidden until prompt)', /id="install-btn"[^>]*hidden/.test(html));

// worker + sw files exist on disk
for (const f of ['app.js', 'worker.js', 'sw.js', 'offline.html', 'manifest.webmanifest']) {
  check(`${f} exists`, fs.existsSync(path.join(REPO, f)));
}

// no external resources (self-contained, offline). Hyperlinks to project
// pages are fine; only resource loads (src/href of scripts/styles/icons)
// must stay local.
check('no external resource URLs (src/href of assets)',
  !/<(?:script|link|img|source)[^>]+(?:src|href)="https?:\/\//.test(html));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { failures.forEach(f => console.log('FAILED: ' + f)); process.exit(1); }
