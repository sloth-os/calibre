#!/usr/bin/env node
/*
 * Runs every test suite in this directory and prints one table + totals.
 *
 * Usage (from the repo root, or anywhere — the repo root is derived from this
 * file's own location):
 *
 *   node tests/run-all.mjs                # everything
 *   node tests/run-all.mjs sw             # only suites whose name matches
 *   VERBOSE=1 node tests/run-all.mjs      # echo each suite's full output
 *
 * Exit code: 0 if every suite passed or was legitimately SKIPPED (e.g. the
 * wasm bundle is absent), 1 as soon as one suite fails, times out or crashes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(TESTS_DIR, '..');

// Fast static checks first, then the wasm-driven Node integration (boots the
// whole engine, ~1 minute), then the real-browser smoke (skipped unless
// playwright + a built engine are present).
const ORDERED = [
  'index-html.test.mjs',
  'app-file-handling.test.mjs',
  'manifest-file-handling.test.mjs',
  'sw.test.mjs',
  'shims.test.mjs',
  'worker-integration.test.mjs',
  'browser-smoke.test.mjs',
];

// Helpers, not suites.
const NOT_SUITES = new Set(['run-all.mjs', 'make-mini10.mjs', 'serve.mjs']);

// Per-suite wall-clock budget; the worker integration boots the whole wasm
// engine, so it gets a generous default. Override with TEST_TIMEOUT_MS.
const TIMEOUT_MS = Number(process.env.TEST_TIMEOUT_MS || 600000);
const VERBOSE = process.env.VERBOSE === '1';

const argv = process.argv.slice(2);

async function runSuite(name) {
  return new Promise((resolve) => {
    const proc = spawn('node', [path.join(TESTS_DIR, name)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
 let timer = setTimeout(() => {
      proc.kill('SIGKILL');
      resolve({ name, status: 'TIMEOUT', out });
 }, TIMEOUT_MS);
    proc.stdout.on('data', (d) => { out += d; });
 proc.stderr.on('data', (d) => { out += d; });
    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({ name, status: 'CRASH', out: out + String(err) });
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (/^SKIPPED/m.test(out)) resolve({ name, status: 'SKIPPED', out });
 else resolve({ name, status: code === 0 ? 'PASS' : 'FAIL', out });
    });
  });
}

const discovered = fs.readdirSync(TESTS_DIR)
  .filter(f => f.endsWith('.mjs') && !NOT_SUITES.has(f) && f !== path.basename(fileURLToPath(import.meta.url)))
  .filter(f => !ORDERED.includes(f));
const suites = [...ORDERED.filter(f => fs.existsSync(path.join(TESTS_DIR, f))), ...discovered]
  .filter(f => !argv.length || argv.some(a => f.includes(a)));

if (!suites.length) {
  console.log('no test suites matched');
 process.exit(0);
}

console.log(`running ${suites.length} suites from ${TESTS_DIR}\n`);
const results = [];
for (const name of suites) {
  process.stdout.write(`-- ${name} ... `);
  const r = await runSuite(name);
  results.push(r);
  console.log(r.status);
 if (VERBOSE || r.status === 'FAIL' || r.status === 'CRASH' || r.status === 'TIMEOUT') {
    console.log(r.out.split('\n').map(l => '   | ' + l).join('\n'));
  }
}

const counts = results.reduce((acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc; }, {});
console.log('\n==== totals ====');
for (const status of ['PASS', 'FAIL', 'TIMEOUT', 'CRASH', 'SKIPPED']) {
  if (counts[status]) console.log(`${status.padEnd(7)} ${counts[status]}`);
}
const bad = (counts.FAIL || 0) + (counts.TIMEOUT || 0) + (counts.CRASH || 0);
process.exit(bad ? 1 : 0);
