# fast_html_entities — pure-Python port of replace_all_entities.
#
# The C function replaces numeric and named HTML5 entities in a str/bytes
# blob. Calibre calls it from ebooks/html_entities.py (with keep_xml=False)
# and oeb/polish/parsing.py (keep_xml=True). Semantics mirrored from the C
# code and its unit tests:
#   - &#NNN; and &#xHHH; decode per HTML5: codepoint 0, surrogates and
#     anything > 0x10FFFF become U+FFFD; C1 range (0x80-0x9F) maps through
#     windows-1252, undefined slots pass the raw codepoint.
#   - named entities come from the html5_entities table in
#     calibre.ebooks.html_entities (import lazily to avoid a cycle).
#   - keep_xml=True preserves &amp; &lt; &gt; &apos; &quot;.
#   - unterminated '&name' without ';' stays literal.

from html.entities import name2codepoint

try:
    # The table lives in calibre itself — import lazily at first use.
    _html5_entities = None

    def _entities():
        global _html5_entities
        if _html5_entities is None:
            from calibre.ebooks.html_entities import html5_entities
            _html5_entities = html5_entities
        return _html5_entities
except Exception:
    _html5_entities = {}
    _entities = lambda: _html5_entities


# windows-1252 mappings for the C1 range, per HTML5 (None = leave as-is)
_CP1252 = {
    0x80: 0x20AC, 0x82: 0x201A, 0x83: 0x0192, 0x84: 0x201E, 0x85: 0x2026,
    0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02C6, 0x89: 0x2030, 0x8A: 0x0160,
    0x8B: 0x2039, 0x8C: 0x0152, 0x8E: 0x017D, 0x91: 0x2018, 0x92: 0x2019,
    0x93: 0x201C, 0x94: 0x201D, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014,
    0x98: 0x02DC, 0x99: 0x2122, 0x9A: 0x0161, 0x9B: 0x203A, 0x9C: 0x0153,
    0x9E: 0x017E, 0x9F: 0x0178,
}

_XML_ENTITIES = {'amp', 'lt', 'gt', 'apos', 'quot'}

_ENTITY_RE = None


def _compile():
    global _ENTITY_RE
    import re
    _ENTITY_RE = re.compile(r'&(#[0-9]+|#[xX][0-9a-fA-F]+|[^\s;&]+);?')
    return _ENTITY_RE


def _decode_cp(num: int) -> str:
    if num == 0 or 0xD800 <= num <= 0xDFFF or num > 0x10FFFF:
        return '�'
    if 0x80 <= num <= 0x9F:
        cp = _CP1252.get(num)
        if cp is not None:
            return chr(cp)
    return chr(num)


def replace_all_entities(data, keep_xml=False, rmcrlf=None):
    if isinstance(data, (bytes, bytearray, memoryview)):
        data = bytes(data).decode('utf-8', 'replace')
    rx = _ENTITY_RE if _ENTITY_RE is not None else _compile()
    entities = _entities()

    out = []
    pos = 0
    for m in rx.finditer(data):
        out.append(data[pos:m.start()])
        pos = m.end()
        body = m.group(1)
        ent = None
        if body.startswith('#'):
            if body[1] in 'xX':
                try:
                    num = int(body[2:], 16)
                except ValueError:
                    num = None
            else:
                try:
                    num = int(body[1:], 10)
                except ValueError:
                    num = None
            if num is None:
                out.append(m.group(0))
                continue
            # A numeric entity always ends with ';' in the C impl; without
            # it the match is literal.
            if not m.group(0).endswith(';'):
                out.append(m.group(0))
                continue
            ent = _decode_cp(num)
        else:
            name = body
            if name in _XML_ENTITIES and keep_xml:
                out.append(m.group(0))
                continue
            val = entities.get(name)
            if val is None:
                val = None
                if name in name2codepoint:
                    val = chr(name2codepoint[name])
            if val is None or not m.group(0).endswith(';'):
                out.append(m.group(0))
                continue
            ent = val
        out.append(ent)
    out.append(data[pos:])
    return ''.join(out)
