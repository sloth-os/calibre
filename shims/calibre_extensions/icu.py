# icu — pure-Python stand-in for calibre's libicu extension.
#
# calibre/utils/icu.py pulls a wide surface from this module at import time.
# The ebook conversion pipeline actually exercises: Collator (sort keys for
# spine/TOC ordering), change_case (metadata casing), chr/ord_string,
# normalize, utf16_length. The PDF-only bidi functions raise; PDF output is
# not available in the wasm build anyway (needs QtWebEngine).
#
# Collation semantics: the C module embeds a real ICU collator with strength
# levels. This shim implements a deterministic casefold-based key with an
# optional numeric-aware split — total ordering, stable across runs, close to
# ICU's SECONDARY strength for Latin scripts. Sort order for non-Latin
# scripts may differ from desktop calibre; that affects item ordering
# (manifests sort by href), never conversion output bytes.

import re
import unicodedata

unicode_version = '15.1.0'
ok = 1

# Strength constants (mirror the values in calibre's icu.c)
UCOL_PRIMARY = 0
UCOL_SECONDARY = 1
UCOL_TERTIARY = 2
UCOL_QUATERNARY = 3
UCOL_IDENTICAL = 15
UCOL_DEFAULT = -1
UCOL_SHIFTED = 0
UCOL_NON_IGNORABLE = 1
UCOL_ALTERNATE_HANDLING = 1

UPPER_CASE = 1
LOWER_CASE = 2
TITLE_CASE = 3

NFC, NFD, NFKC, NFKD = 'NFC', 'NFD', 'NFKC', 'NFKD'


class _Titlecase:
    """ICU title-casing uppercases only letters that start a word (words are
    delimited by whitespace, NOT by punctuation — so \"don't\" stays
    \"Don't\", unlike str.title()'s \"Don'T\"). Everything else lowercases."""

    def __call__(self, s: str) -> str:
        out = []
        prev_space = True  # string start acts like a word start
        for ch in s:
            if ch.isalpha():
                out.append(ch.upper() if prev_space else ch.lower())
            else:
                out.append(ch)
            prev_space = ch.isspace()
        return ''.join(out)


def _as_str(x):
    if isinstance(x, bytes):
        return x.decode('utf-8', 'surrogateescape'), True
    return x, False


def change_case(x, which, locale=None):
    s, was_bytes = _as_str(x)
    if which == UPPER_CASE:
        ans = s.upper()
    elif which == LOWER_CASE:
        ans = s.lower()
    elif which == TITLE_CASE:
        ans = _Titlecase()(s)
    else:
        raise ValueError(f'unknown case selector: {which!r}')
    return ans


def swap_case(x, locale=None):
    s, _ = _as_str(x)
    return s.swapcase()


def chr_(x):
    return chr(x)


def chr(x):
    # calibre's safe_chr = _icu.chr: unlike builtin chr it maps invalid
    # codepoints (surrogates, >0x10FFFF, negatives) to U+FFFD. Builtin chr
    # happily returns lone surrogates, so the range is checked explicitly.
    import builtins as _b
    if isinstance(x, str):
        x = ord_string(x)
    if not isinstance(x, int) or isinstance(x, bool):
        raise TypeError(f'chr() argument must be an int, not {type(x).__name__}')
    if 0 <= x <= 0x10FFFF and not (0xD800 <= x <= 0xDFFF):
        return _b.chr(x)
    return '�'


# calibre.utils.icu also references _icu.safe_chr indirectly via
# `safe_chr = _icu.chr`; export both names for safety.
safe_chr = chr


def ord_string(x):
    # The C version returns the codepoint of a 1-char string; for longer
    # strings it returns the first codepoint's value packed — callers in the
    # conversion path only ever pass single characters.
    if isinstance(x, bytes):
        x = x.decode('utf-8', 'replace')
    if not x:
        raise ValueError('ord_string of empty string')
    return ord(x[0])


def character_name(x):
    try:
        return unicodedata.name(str(x))
    except (ValueError, TypeError):
        return ''


def character_name_from_code(code):
    try:
        return unicodedata.name(chr(code))
    except (ValueError, TypeError, OverflowError):
        return ''


def set_default_encoding(enc):
    return None


def set_filesystem_encoding(enc):
    return None


def normalize(mode, text):
    return unicodedata.normalize(mode, text)


def utf16_length(text):
    # Number of UTF-16 code units.
    return len(text.encode('utf-16-le')) // 2


def word_prefix_find(haystack, needle):
    """Find needle as a word-prefix in haystack. The C version uses an ICU
    BreakIterator so a match ends at a word boundary. Approximation: case-
    insensitive prefix match where the following char (if any) is not a
    word char. Returns (offset, length) or (-1, 0)."""
    hay, _ = _as_str(haystack)
    nd, _ = _as_str(needle)
    if not nd:
        return (-1, 0)
    h = hay.casefold()
    n = nd.casefold()
    pos = 0
    while pos <= len(h) - len(n):
        pos = h.find(n, pos)
        if pos < 0:
            break
        end = pos + len(n)
        if end >= len(h) or not (h[end].isalnum() or h[end] == '_'):
            return (pos, end - pos)
        pos += 1
    return (-1, 0)


def bidi_reorder(text, to_logical, want_map):
    raise NotImplementedError(
        'bidi_reorder is not available in the wasm build (PDF output is disabled)'
    )


class Collator:
    """Case-insensitive collator with optional numeric awareness. sort_key
    returns a plain tuple; calibre only ever feeds these to sorted()."""

    def __init__(self, locale=None):
        self.locale = locale or 'en'
        self._strength = UCOL_SECONDARY
        self._numeric = False
        self._upper_first = False

    # -- attribute protocol used by calibre.utils.icu.collator() ------
    @property
    def strength(self):
        return self._strength

    @strength.setter
    def strength(self, v):
        self._strength = v

    @property
    def numeric(self):
        return self._numeric

    @numeric.setter
    def numeric(self, v):
        self._numeric = bool(v)

    @property
    def upper_first(self):
        return self._upper_first

    @upper_first.setter
    def upper_first(self, v):
        self._upper_first = bool(v)

    def clone(self):
        c = Collator(self.locale)
        c._strength = self._strength
        c._numeric = self._numeric
        c._upper_first = self._upper_first
        return c

    def set_attribute(self, attr, value):
        return None  # alternate handling (ignorable punctuation) — no-op here

    # -- key protocol ------
    _NUM_SPLIT = re.compile(r'(\d+)')

    def _key(self, a):
        a, _ = _as_str(a)
        a = a.casefold()
        if self._numeric:
            parts = []
            for piece in Collator._NUM_SPLIT.split(a):
                if piece.isdigit():
                    parts.append(('', int(piece), 0))
                else:
                    parts.append((piece, -1, 0))
            return tuple(parts)
        return (a,)

    def sort_key(self, a):
        return self._key(a)

    def collation_order(self, a):
        a, _ = _as_str(a)
        a2 = a.casefold()
        return (ord(a2[0]) if a2 else 0, 0, 0)

    def strcmp(self, a, b):
        ka, kb = self._key(a), self._key(b)
        return -1 if ka < kb else (1 if ka > kb else 0)

    def find(self, a, b):
        a, _ = _as_str(a)
        b, _ = _as_str(b)
        pos = a.casefold().find(b.casefold())
        return (pos, len(b)) if pos >= 0 else (-1, 0)

    def contains(self, a, b):
        a, _ = _as_str(a)
        b, _ = _as_str(b)
        return b.casefold() in a.casefold()

    def startswith(self, a, b):
        a, _ = _as_str(a)
        b, _ = _as_str(b)
        return a.casefold().startswith(b.casefold())


class Transliterator:
    def __init__(self, *args, **kwargs):
        raise NotImplementedError('Transliterator is not available in the wasm build')
