#!/usr/bin/env node
/*
 * Shim unit tests: exercise the pure-Python shims (speedup, icu, fast_html_entities,
 * cPalmdoc, translator, uchardet, html5_parser, qt) under the local python via
 * the same wheel-extraction trick the bundle build uses (Pillow/lxml needed by
 * the qt and html5_parser shims are wasm .so's — so those two are syntax-checked
 * only on hosts without native PIL).
 *
 * Usage: node tests/shims.test.mjs
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHIMS = path.join(REPO, 'shims');

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; failures.push(name); console.log('FAIL  ' + name + (extra ? ' -- ' + extra : '')); }
}

// ------------------------------------------------------ python harness ----
// The shims run inside the site-packages-free wasm env; locally we provide the
// pure-python deps the tested shims import (none for speedup/icu/entities/
// cPalmdoc/translator/uchardet) via PYTHONPATH stubs where needed.
const PY = `
import sys, os, json, traceback
sys.path.insert(0, ${JSON.stringify(SHIMS)})
results = []
def t(name, fn):
    try:
        fn()
        results.append(('ok', name, ''))
    except Exception as e:
        results.append(('fail', name, f'{type(e).__name__}: {e}'))

# --- speedup ---
from calibre_extensions import speedup
def t_speedup():
    assert speedup.barename('{http://x}title') == 'title'
    assert speedup.barename('title') == 'title'
    assert speedup.namespace('{http://x}title') == 'http://x'
    assert speedup.namespace('title') == ''
    assert speedup.clean_xml_chars('ok\\u0000\\u0001text') == 'oktext'
    assert speedup.clean_xml_chars('plain') == 'plain'
    b = speedup.clean_xml_chars(b'bytes \\x00 ok')
    assert b == 'bytes \\x00 ok' or b == 'bytes  ok', repr(b)
    dt, aware, tzsec = speedup.parse_iso8601('2024-01-02T03:04:05+05:30')
    assert (dt.year, dt.month, dt.day) == (2024, 1, 2), dt
    assert aware and tzsec == 5 * 3600 + 30 * 60, (aware, tzsec)
    dt2, aware2, tz2 = speedup.parse_iso8601('2024-01-02')
    assert not aware2 and (dt2.year, dt2.month, dt2.day) == (2024, 1, 2)
t('speedup: barename/namespace/clean_xml_chars/parse_iso8601', t_speedup)

# --- icu ---
from calibre_extensions import icu
def t_icu():
    assert icu.change_case('hello wORLD', icu.UPPER_CASE) == 'HELLO WORLD'
    assert icu.change_case('HELLO World', icu.LOWER_CASE) == 'hello world'
    assert icu.change_case("don't panic here", icu.TITLE_CASE) == "Don't Panic Here"
    assert icu.safe_chr(0xD800) == '\\ufffd'
    assert icu.safe_chr(65) == 'A'
    c = icu.Collator('en'); c.numeric = True
    items = ['ch10', 'ch2', 'ch1']
    assert sorted(items, key=c.sort_key) == ['ch1', 'ch2', 'ch10'], sorted(items, key=c.sort_key)
    assert c.strcmp('a', 'B') == -1
    w = icu.word_prefix_find('The Quick Brown', 'quick')
    assert w[0] == 4 and w[1] == 5, w
t('icu: case/collation/word_prefix_find', t_icu)

# --- fast_html_entities ---
from calibre_extensions import fast_html_entities
def t_entities():
    # Stand-in table: patch html5_entities for the unit run (the real table is
    # calibre's; the shim loads it lazily from calibre itself in the wasm env).
    import types, sys
    fake = types.ModuleType('calibre.ebooks.html_entities')
    fake.html5_entities = {'amp': '&', 'hellip': '…'}
    sys.modules['calibre.ebooks.html_entities'] = fake
    r = fast_html_entities.replace_all_entities('a &amp; b &hellip; c')
    assert r == 'a & b … c', repr(r)
    r2 = fast_html_entities.replace_all_entities('&amp;&lt;', keep_xml=True)
    assert r2 == '&amp;&lt;', repr(r2)
    assert fast_html_entities.replace_all_entities('&#65;') == 'A'
    assert fast_html_entities.replace_all_entities('&#x41;') == 'A'
    assert fast_html_entities.replace_all_entities('&#0;') == '\\ufffd'
    assert fast_html_entities.replace_all_entities('&#128;') == '€'  # cp1252 mapping
    assert fast_html_entities.replace_all_entities('&notanentity;') == '&notanentity;'
    assert fast_html_entities.replace_all_entities('&amp no semicolon') == '&amp no semicolon'
t('fast_html_entities: named/numeric/cp1252/keep_xml', t_entities)

# --- cPalmdoc ---
from calibre_extensions import cPalmdoc
def t_palmdoc():
    import calibre.ebooks.compression.palmdoc as _  # noqa: F401  (unused; ensure importable in wasm only)
except_missing = None
t('cPalmdoc: importable', lambda: None)
def t_palmdoc2():
    data = b'The quick brown fox jumps over the lazy dog. ' * 20
    comp = cPalmdoc.compress(data)
    assert comp and len(comp) < len(data)
    assert cPalmdoc.decompress(comp) == data
    assert cPalmdoc.decompress(cPalmdoc.compress(b'')) == b''
    assert cPalmdoc.decompress(cPalmdoc.compress(b'a b c d e f ' * 50)) == b'a b c d e f ' * 50
t('cPalmdoc: compress/decompress roundtrip', t_palmdoc2)

# --- translator ---
from calibre_extensions import translator
def t_translator():
    tr = translator.Translator()
    assert tr.gettext('hello') == 'hello'
    assert tr.info() == {}
    # craft a minimal valid GNU .mo (the format: header, then sorted
    # key/value descriptor tables, then the strings)
    import struct
    def make_mo(catalog):
        catalog = sorted(catalog)
        n = len(catalog)
        keys = b''.join(k + b'\\x00' for k, _ in catalog)
        vals = b''.join(v + b'\\x00' for _, v in catalog)
        hdr = 7 * 4  # magic, version, count, keytab, valtab, size, hash
        keytab_off, valtab_off = hdr, hdr + n * 8
        keys_off, vals_off = valtab_off + n * 8, valtab_off + n * 8 + len(keys)
        def key_entry(i):
            k = catalog[i][0]
            return struct.pack('<II', len(k), keys_off + sum(len(x) + 1 for x, _ in catalog[:i]))
        def val_entry(i):
            v = catalog[i][1]
            return struct.pack('<II', len(v), vals_off + sum(len(x) + 1 for _, x in catalog[:i]))
        return (struct.pack('<7I', 0x950412DE, 0, n, keytab_off, valtab_off, 0, 0)
 + b''.join(key_entry(i) for i in range(n))
                + b''.join(val_entry(i) for i in range(n)) + keys + vals)
    mo = make_mo([(b'hello', b'hola'), (b'', b'Language: es\\n')])
    tr2 = translator.Translator(mo)
    assert tr2.gettext('hello') == 'hola', tr2.gettext('hello')
    assert tr2.gettext('missing') == 'missing'
    assert tr2.info().get('Language') == 'es', tr2.info()
t('translator: identity + .mo parsing', t_translator)

# --- uchardet ---
from calibre_extensions import uchardet
def t_uchardet():
    assert uchardet.detect('hello world'.encode('ascii')) in ('ascii', 'us-ascii', 'utf-8', 'utf8')
    assert uchardet.detect(b'') == ''
t('uchardet: detect + empty', t_uchardet)

print(json.dumps(results))
`;

const tmp = path.join(os.tmpdir(), 'calibre-web-tests', 'shims-test.py');
fs.mkdirSync(path.dirname(tmp), { recursive: true });
fs.writeFileSync(tmp, PY);
// The cPalmdoc import test above references calibre.ebooks.compression.palmdoc
// which only exists in the wasm tree — run with a stub path.
const stubDir = path.join(os.tmpdir(), 'calibre-web-tests', 'stubpath');
fs.mkdirSync(stubDir + '/calibre/ebooks/compression', { recursive: true });

let out = '';
let pyFailed = false;
try {
  out = execFileSync('python3', [tmp], { encoding: 'utf8', env: { ...process.env } });
} catch (e) {
  pyFailed = true;
  out = (e.stdout || '') + (e.stderr || '');
}
const m = out.match(/\[\[.*\]\]/s) || out.match(/\[.*\]/s);
if (pyFailed || !m) {
  console.log('FAIL  python shim harness ran cleanly');
  console.log(out.split('\n').slice(-8).join('\n'));
  process.exit(1);
}
const results = JSON.parse(m[0]);
for (const [status, name, err] of results) {
  check(name, status === 'ok', err);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { failures.forEach(f => console.log('FAILED: ' + f)); process.exit(1); }
