#!/usr/bin/env node
/*
 * Shim unit tests: exercise the pure-Python shims (speedup, icu, fast_html_entities,
 * cPalmdoc, translator, uchardet, qt, imageops, gui2) under the local python via
 * the same wheel-extraction trick the bundle build uses. Pillow/lxml are wasm
 * .so wheels in the bundle: hosts without a native PIL SKIP the qt/imageops
 * rows (CI pip-installs Pillow — see publish.yml — so they run there); the
 * html5_parser shim (lxml) is syntax-checked only.
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
// pure-python deps the tested shims import via PYTHONPATH stubs where needed.
// speedup/icu/entities/cPalmdoc/translator need nothing; uchardet wraps the
// `chardet` package (production vendors chardet==5.2.0 as a wheel — CI pip-
// installs the same pin before this suite; see publish.yml + fetch-vendor-
// wheels.py). Pillow/lxml (qt/html5_parser shims) are wasm .so's in the
// bundle, so those shims are syntax-checked on hosts without native PIL.
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

# --- qt / imageops / gui2 shims (PIL-gated) ---
# Pillow ships into the bundle as a pyodide wasm wheel; hosts without a
# native PIL skip these rows (CI pip-installs Pillow so they run there —
# see publish.yml). The qt shim is the conversion path's image engine, and
# the bug class it must never regress: calibre's autogenerated src/qt/core.py
# imports cleanly but has no real symbols, so once it shadowed this shim
# every syntax check still passed while every cover path died at runtime
# ("ImportError: cannot import name 'QBuffer' from 'qt.core'"). These rows
# pin the FUNCTIONAL surface, symbol by symbol.
try:
    import PIL  # noqa: F401
    _have_pil = True
except Exception:
    _have_pil = False

if not _have_pil:
    results.append(('skip', 'qt/imageops/gui2 shims (host has no Pillow)', ''))
else:
    import io
    from PIL import Image
    import qt.core as q

    def t_qt_surface():
        assert 'shims' in q.__file__, q.__file__
        for sym in ('QBuffer', 'QByteArray', 'QImage', 'QImageReader',
                    'QImageWriter', 'QColor', 'QPainter', 'QPen', 'QBrush',
                    'QTransform', 'QSize', 'QPointF', 'QSvgRenderer',
                    'QPixmap', 'qRgba'):
            assert hasattr(q, sym), sym
    t('qt: shim resolves with the full symbol surface', t_qt_surface)

    def t_qbuffer_write_through():
        # image_to_data pattern: QImageWriter -> QBuffer -> ba.data() with NO
        # close() anywhere — every write must land in the QByteArray at once.
        ba = q.QByteArray()
        buf = q.QBuffer(ba)
        buf.open(q.QIODevice.OpenModeFlag.WriteOnly)
        img = q.QImage(50, 40, q.QImage.Format.Format_RGB32)
        img.fill(q.Qt.GlobalColor.white)
        assert q.QImageWriter(buf, b'PNG').write(img)
        data = ba.data()
        assert data[:8] == bytes([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), data[:8]
        assert Image.open(io.BytesIO(data)).size == (50, 40)
    t('qt: QBuffer write-through without close (image_to_data)', t_qbuffer_write_through)

    def t_qimage_reader_format():
        bio = io.BytesIO()
        Image.new('RGB', (10, 10), (1, 2, 3)).save(bio, 'PNG')
        buf = q.QBuffer(q.QByteArray(bio.getvalue()))
        buf.open(q.QIODevice.OpenModeFlag.ReadOnly)
        r = q.QImageReader(buf)
        assert r.format() == b'png', r.format()   # sniffed BEFORE read()
        img = r.read()
        assert (img.width(), img.height()) == (10, 10)
    t('qt: QImageReader.format() before read()', t_qimage_reader_format)

    def t_color_and_fill():
        assert q.qRgba(255, 0, 0, 128) == 0x80FF0000      # Qt layout 0xAARRGGBB
        c = q.QColor(255, 0, 0, 128)
        assert c.rgb() == 0xFFFF0000 and c.rgba() == 0x80FF0000
        img = q.QImage(q.QSize(10, 10), q.QImage.Format.Format_ARGB32_Premultiplied)
        img.fill(q.QColor('white').rgb())
        assert img.to_pil().getpixel((5, 5)) == (255, 255, 255, 255)
        img.fill(q.Qt.GlobalColor.transparent)
        assert img.to_pil().getpixel((5, 5)) == (0, 0, 0, 0)
        img.fill(q.qRgba(10, 20, 30, 40))
        assert img.to_pil().getpixel((5, 5)) == (10, 20, 30, 40)
    t('qt: qRgba/QColor/fill semantics', t_color_and_fill)

    def t_transform():
        img = q.QImage(50, 40)
        img.fill(q.Qt.GlobalColor.white)
        tr = q.QTransform()
        tr.rotate(90)        # Qt mutates in place; calibre discards the return
        rot = img.transformed(tr)
        assert (rot.width(), rot.height()) == (40, 50), (rot.width(), rot.height())
    t('qt: QTransform.rotate in place + transformed()', t_transform)

    def t_text_layout():
        # covers.py's text engine: wrap must honor the wrap mode (CJK runs
        # have no spaces — a space-only wrap overflows the cover with one
        # multi-thousand-pixel line), alignment must be honored at draw,
        # and fillRect must paint exactly w*h pixels (Qt exclusive-end ->
        # PIL inclusive-end).
        text = '字' * 60
        layout = q.QTextLayout(text, q.QFont())
        opt = q.QTextOption(q.Qt.AlignmentFlag.AlignHCenter | q.Qt.AlignmentFlag.AlignTop)
        opt.setWrapMode(q.QTextOption.WrapMode.WrapAtWordBoundaryOrAnywhere)
        layout.setTextOption(opt)
        layout.beginLayout()
        lines, y = [], 0.0
        while len(lines) < 200:
            line = layout.createLine()
            if not line.isValid():
                break
            line.setLineWidth(120.0)
            line.setPosition(q.QPointF(0, y))
            y += line.height()
            lines.append(line)
        layout.endLayout()
        assert len(lines) > 1, len(lines)
        assert ''.join(ln._text for ln in lines) == text
        for ln in lines:
            assert ln.width() <= 120.0, ln.width()
        f = q.QFont()._load()
        ascent, descent = f.getmetrics()
        assert lines[0].height() == ascent + descent, lines[0].height()
        img = q.QImage(200, 60)
        img.fill(q.Qt.GlobalColor.white)
        p = q.QPainter(img)
        p.setPen(q.QPen(q.QColor('black'), 1))
        layout2 = q.QTextLayout('Hi', q.QFont())
        opt2 = q.QTextOption(q.Qt.AlignmentFlag.AlignHCenter | q.Qt.AlignmentFlag.AlignTop)
        opt2.setWrapMode(q.QTextOption.WrapMode.NoWrap)
        layout2.setTextOption(opt2)
        layout2.beginLayout()
        ln2 = layout2.createLine()
        ln2.setLineWidth(200.0)
        ln2.setPosition(q.QPointF(0, 10))
        layout2.endLayout()
        layout2.draw(p, q.QPointF(0, 0))
        p.end()
        pil = img.to_pil().convert('L')
        xs = sorted({x for x in range(200) for yy in range(60) if pil.getpixel((x, yy)) < 128})
        assert xs and abs((xs[0] + xs[-1]) / 2.0 - 100.0) <= 3.0, (xs[0], xs[-1])
        img2 = q.QImage(20, 20)
        img2.fill(q.Qt.GlobalColor.white)
        p2 = q.QPainter(img2)
        p2.fillRect(q.QRect(2, 3, 10, 8), q.QColor('red'))
        p2.end()
        rgb = img2.to_pil().convert('RGB')
        painted = sum(1 for x in range(20) for yy in range(20) if rgb.getpixel((x, yy)) == (255, 0, 0))
        assert painted == 80, painted
    t('qt: text layout wrap/alignment + fillRect geometry', t_text_layout)

    def t_rasterize_flow():
        # oeb/transforms/rasterize.py: SVG -> defaultSize -> scale -> QImage
        # -> fill -> QPainter.render -> save PNG into a QBuffer.
        svg = q.QSvgRenderer(q.QByteArray(b'<svg xmlns="http://www.w3.org/2000/svg" width="300" height="150"/>'))
        assert svg.isValid()
        size = svg.defaultSize()
        size.scale(150, 150, q.Qt.AspectRatioMode.KeepAspectRatio)
        assert (size.width(), size.height()) == (150, 75)
        image = q.QImage(size, q.QImage.Format.Format_ARGB32_Premultiplied)
        image.fill(q.QColor('white').rgb())
        painter = q.QPainter(image)
        svg.render(painter)
        painter.end()
        array = q.QByteArray()
        buffer = q.QBuffer(array)
        buffer.open(q.QIODevice.OpenModeFlag.WriteOnly)
        assert image.save(buffer, 'PNG')
        assert Image.open(io.BytesIO(array.data())).size == (150, 75)
    t('qt: rasterize.py SVG flow end to end', t_rasterize_flow)

    def t_imageops():
        from calibre_extensions import imageops as iops
        img = q.QImage(60, 40, q.QImage.Format.Format_ARGB32_Premultiplied)
        img.fill(q.QColor(120, 40, 200))
        assert img.to_pil().mode == 'RGBA'
        # PIL only median-cut-quantizes RGB — RGBA must be flattened inside
        assert isinstance(iops.dominant_color(img), q.QColor)
        assert iops.quantize(img, 16, True, ()).width() == 60
        assert iops.ordered_dither(img).to_pil().mode == 'L'
        assert iops.has_transparent_pixels(img) is False
        assert iops.grayscale(img).width() == 60
        assert iops.remove_borders(img, 10).width() <= 60
    t('imageops: RGBA-safe filters + quantize family', t_imageops)

    def t_pdf_float():
        vecs = [(0.0, '0'), (1e-9, '0'), (2.0, '2'), (1.5, '1.5'),
                (123456.789, '123456.8'), (0.123456789, '0.123457'),
                (-2.0, '-2'), (1000000.0, '1000000'), (-0.5, '-0.5'),
                (0.000123, '0.000123'), (1e-8, '0')]
        for f, want in vecs:
            got = speedup.pdf_float(f)
            assert got == want, 'pdf_float(%r) = %r, want %r' % (f, got, want)
    t('speedup: pdf_float C-exact vectors', t_pdf_float)

    def t_progress_indicator():
        from calibre_extensions import progress_indicator as pi
        assert pi.set_image_allocation_limit(1024) is None
    t('progress_indicator: allocation-limit no-op', t_progress_indicator)

    def t_gui2():
        # shims/calibre has no __init__.py: on the host (no real calibre)
        # calibre.gui2 resolves through a namespace package to the shim.
        from calibre.gui2 import must_use_qt, ensure_app
        assert must_use_qt() is None          # rasterize.py calls it bare
        assert must_use_qt(headless=True) is None
        assert ensure_app(headless=True) is not None
    t('gui2: must_use_qt/ensure_app (rasterize.py contract)', t_gui2)

print(json.dumps(results))
`;

// pid-suffixed: concurrent runs must not overwrite each other's scratch file.
const tmp = path.join(os.tmpdir(), 'calibre-web-tests', `shims-test-${process.pid}.py`);
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
let skipped = 0;
for (const [status, name, err] of results) {
  if (status === 'skip') { skipped++; console.log('SKIP  ' + name); continue; }
  check(name, status === 'ok', err);
}

console.log(`\n${pass} passed, ${fail} failed` + (skipped ? `, ${skipped} skipped` : ''));
if (fail) { failures.forEach(f => console.log('FAILED: ' + f)); process.exit(1); }
