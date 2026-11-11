#!/usr/bin/env node
/*
 * Contract test: PWA file handling in manifest.webmanifest.
 *
 * Parses the real manifest (strict JSON) and asserts the file_handlers +
 * share_target contract:
 *   - file_handlers[0]: action "./" (relative — a root-absolute action
 *     resolves outside the Pages subpath scope and Chromium drops it
 *     silently), spec-valid launch_type, accept map with extension lists
 *   - every accept extension has a leading dot
 *   - share_target: POST ./__share, multipart/form-data, params.files[0].name
 *   - no absolute / external / scheme-ful URLs anywhere in the manifest
 *
 * Usage: node tests/manifest-file-handling.test.mjs   (from the repo root)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST_PATH = path.join(REPO, 'manifest.webmanifest');

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else {
    fail++;
    const detail = extra === undefined ? '' : ' -- ' + extra;
    failures.push(name);
    console.log('FAIL  ' + name + detail);
  }
}

let manifest = null;
try {
  manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  check('manifest parses as strict JSON', true);
} catch (err) {
  check('manifest parses as strict JSON', false, err.message);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(1);
}

// ---- file_handlers ----
const handlers = manifest.file_handlers || [];
check('file_handlers present and non-empty', handlers.length > 0);

if (handlers.length > 0) {
  const h = handlers[0];
  check('file_handlers[0].action is "./" (relative, in-scope)', h.action === './', h.action);
  check('file_handlers[0].launch_type is a spec enum',
 ['single-client', 'multiple-clients', 'focus-existing', 'new-client'].includes(h.launch_type || 'single-client'),
    h.launch_type);
  check('file_handlers[0].accept is a non-empty object',
    h.accept && typeof h.accept === 'object' && Object.keys(h.accept).length > 0);

  let allDotted = true, allLists = true, extCount = 0;
  for (const [mime, exts] of Object.entries(h.accept || {})) {
    if (!Array.isArray(exts)) allLists = false;
    if (!/^[a-z0-9][a-z0-9!#$&^_.+-]+\/[a-z0-9][a-z0-9!#$&^_.+-]+$/.test(mime)) {
      check(`accept key "${mime}" is MIME-shaped`, false);
    }
    for (const e of exts || []) {
      extCount++;
      if (typeof e !== 'string' || !e.startsWith('.') || e.length < 2) allDotted = false;
    }
  }
  check(`all ${extCount} accept extensions are dotted strings`, allDotted);
  check('all accept values are lists', allLists);
  check('ebook extensions covered (epub/mobi/azw3/docx/html/txt/fb2/odt/rtf)',
    ['.epub', '.mobi', '.azw3', '.docx', '.html', '.txt', '.fb2', '.odt', '.rtf']
      .every(ext => Object.values(h.accept).some(list => list.includes(ext))));
}

// ---- share_target ----
const st = manifest.share_target;
check('share_target present', !!st);
if (st) {
  check('share_target.action is "./__share" (relative)', st.action === './__share', st.action);
  check('share_target.method is POST', st.method === 'POST');
  check('share_target.enctype is multipart/form-data', st.enctype === 'multipart/form-data');
  check('share_target.params.files[0].name is "files"',
    st.params && Array.isArray(st.params.files) && st.params.files[0] &&
    st.params.files[0].name === 'files');
}

// ---- scope / start_url relative ----
check('start_url is relative', !String(manifest.start_url).startsWith('/'));
check('scope is relative', !String(manifest.scope).startsWith('/'));

// ---- no absolute URLs anywhere in the JSON ----
const raw = JSON.stringify(manifest);
check('no root-absolute URLs (would escape the subpath scope)', !/"[^"]*":\s*"\/[^/][^"]*"/.test(raw));
check('no external URLs (site must be self-contained)', !/https?:\/\//.test(raw));

// ---- icons ----
const icons = manifest.icons || [];
check('icons present (4 sizes)', icons.length >= 4);
for (const ic of icons) {
  check(`icon ${ic.sizes} exists on disk`, fs.existsSync(path.join(REPO, ic.src)), ic.src);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { failures.forEach(f => console.log('FAILED: ' + f)); process.exit(1); }
