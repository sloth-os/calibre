#!/usr/bin/env python3
"""Generate cover-book.epub — a minimal EPUB (3.0 package, ncx + nav) with a
real JPEG cover, used by worker-integration.test.mjs to drive the cover path
(input cover -> rescale/thumbnail -> QBuffer) through a real conversion.

That path is the one the src/qt shadowing bug killed ("ImportError: cannot
import name 'QBuffer' from 'qt.core'"), so the fixture must carry an actual
embedded image — a cover-less book would exercise none of it.

Regenerate:  python3 tests/fixtures/make-cover-book.py   (needs host Pillow)
Deterministic: fixed RNG seed, fixed zip timestamps -> byte-identical output.
"""
import io
import os
import random
import zipfile

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'cover-book.epub')
DATE_TIME = (2026, 1, 12, 0, 0, 0)  # fixed: reproducible zip bytes

CONTAINER = '''<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
'''

OPF = '''<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid" xml:lang="en">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">urn:uuid:6f1a2b3c-4d5e-6f70-8192-a3b4c5d6e7f8</dc:identifier>
    <dc:title>Cover Test Book</dc:title>
    <dc:creator id="creator">Sloth QA</dc:creator>
    <dc:language>en</dc:language>
    <meta name="cover" content="cover-image"/>
    <meta property="dcterms:modified">2026-01-12T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="cover-image" href="cover.jpg" media-type="image/jpeg" properties="cover-image"/>
    <item id="cover-page" href="cover.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="cover-page"/>
    <itemref idref="ch1"/>
  </spine>
</package>
'''

COVER_XHTML = '''<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Cover</title></head>
<body>
<div><img src="cover.jpg" alt="Cover"/></div>
</body>
</html>
'''

NAV = '''<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Contents</title></head>
<body>
<nav epub:type="toc" id="toc">
<ol>
<li><a href="cover.xhtml">Cover</a></li>
<li><a href="ch1.xhtml">Chapter One</a></li>
</ol>
</nav>
</body>
</html>
'''

NCX = '''<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
<head><meta name="dtb:uid" content="urn:uuid:6f1a2b3c-4d5e-6f70-8192-a3b4c5d6e7f8"/></head>
<docTitle><text>Cover Test Book</text></docTitle>
<navMap>
<navPoint id="np1" playOrder="1"><navLabel><text>Cover</text></navLabel><content src="cover.xhtml"/></navPoint>
<navPoint id="np2" playOrder="2"><navLabel><text>Chapter One</text></navLabel><content src="ch1.xhtml"/></navPoint>
</navMap>
</ncx>
'''


def ch1_xhtml():
    rng = random.Random(20260112)
    words = ('the quick brown fox jumps over a lazy dog while sloths watch '
             'patiently from the canopy above the conversion engine').split()
    paras = []
    for _ in range(12):
        para = ' '.join(rng.choice(words) for _ in range(60))
        paras.append(f'<p>{para.capitalize()}.</p>')
    body = '\n'.join(paras)
    return f'''<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Chapter One</title></head>
<body>
<h1>Chapter One</h1>
{body}
</body>
</html>
'''


def cover_jpeg():
    """~35 KB 600x800 JPEG: a smooth diagonal gradient with blended low-
    frequency grain (noise generated small, then upscaled) so the encoder
    cannot compress it to a trivial size without bloating the fixture — the
    conversion path must still do real rescaling work on it."""
    img = Image.new('RGB', (600, 800))
    px = img.load()
    for y in range(800):
        for x in range(600):
            px[x, y] = ((x * 255) // 600,
                        (y * 255) // 800,
                        ((x * 3 + y) * 255) // 2600)
    noise = (Image.effect_noise((150, 200), 48)
             .resize((600, 800), Image.Resampling.BILINEAR)
             .convert('L').convert('RGB'))
    img = Image.blend(img, noise, 0.15)
    buf = io.BytesIO()
    img.save(buf, 'JPEG', quality=75)
    return buf.getvalue()


def main():
    files = [
        # mimetype MUST be first and STORED (EPUB container spec)
        ('mimetype', b'application/epub+zip', zipfile.ZIP_STORED),
        ('META-INF/container.xml', CONTAINER.encode('utf-8'), zipfile.ZIP_DEFLATED),
        ('OEBPS/content.opf', OPF.encode('utf-8'), zipfile.ZIP_DEFLATED),
        ('OEBPS/cover.jpg', cover_jpeg(), zipfile.ZIP_DEFLATED),
        ('OEBPS/cover.xhtml', COVER_XHTML.encode('utf-8'), zipfile.ZIP_DEFLATED),
        ('OEBPS/nav.xhtml', NAV.encode('utf-8'), zipfile.ZIP_DEFLATED),
        ('OEBPS/toc.ncx', NCX.encode('utf-8'), zipfile.ZIP_DEFLATED),
        ('OEBPS/ch1.xhtml', ch1_xhtml().encode('utf-8'), zipfile.ZIP_DEFLATED),
    ]
    with zipfile.ZipFile(OUT, 'w') as zf:
        for name, data, method in files:
            info = zipfile.ZipInfo(name, date_time=DATE_TIME)
            info.compress_type = method
            info.external_attr = 0o644 << 16
            zf.writestr(info, data)
    size = os.path.getsize(OUT)
    print(f'wrote {OUT} ({size / 1024:.1f} KB, cover {len(files[3][1]) / 1024:.1f} KB)')


if __name__ == '__main__':
    main()
