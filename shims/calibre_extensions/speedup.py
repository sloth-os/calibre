# speedup — pure-Python implementation of the speedup C API the conversion
# pipeline touches. The C module has more functions (websocket_mask,
# create_texture, set_thread_name, pread_all, ...) that the conversion path
# never calls; they are intentionally absent.

import os
import re
from datetime import datetime, timezone

# lock.py uses this on the os.open flags for ExclusiveFile.
O_CLOEXEC = getattr(os, 'O_CLOEXEC', 0)


def barename(tag: str) -> str:
    """Tag name without {namespace}. Mirrors speedup.c barename()."""
    if not isinstance(tag, str):
        raise TypeError(f'{tag!r} is not a unicode string')
    pos = tag.find('}')
    if pos == -1:
        return tag
    return tag[pos + 1:]


def namespace(tag: str) -> str:
    """{namespace} of a tag name, '' when absent. Mirrors speedup.c namespace()."""
    if not isinstance(tag, str):
        raise TypeError(f'{tag!r} is not a unicode string')
    pos = tag.find('}')
    if pos == -1:
        return ''
    return tag[1:pos]


# XML-valid codepoints (mirrors the C table in clean_xml_chars):
# #x9 | #xA | #xD | [#x20-#x7E] | #x85 | [#xA0-#xD7FF] | [#xE000-#xFDCF]
# | [#xFDF0-#xFFFD] | [#x10000-#x10FFFF]
def _valid(ch: int) -> bool:
    return (
        ch in (0x9, 0xA, 0xD)
        or 0x20 <= ch <= 0x7E
        or ch == 0x85
        or 0xA0 <= ch <= 0xD7FF
        or 0xE000 <= ch <= 0xFDCF
        or 0xFDF0 <= ch <= 0xFFFD
        or 0x10000 <= ch <= 0x10FFFF
    )


def clean_xml_chars(x):
    """Remove codepoints not allowed in XML. Mirrors speedup.c."""
    if isinstance(x, bytes):
        x = x.decode('utf-8', 'replace')
    if not isinstance(x, str):
        raise TypeError('A unicode string is required')
    if not any(not _valid(ord(c)) for c in x):  # fast path
        return x
    return ''.join(c for c in x if _valid(ord(c)))


def parse_date(raw, timezone_name='UTC'):
    """Parse an ISO-8601-ish timestamp as dateutil would for the formats
    calibre's metadata actually stores (OPF/MOBI dates). Returns None when
    unparseable, mirroring the C behavior."""
    if not isinstance(raw, str):
        return None
    s = raw.strip()
    if len(s) < 8:
        return None
    m = _ZONED_RE.match(s)
    if m is None:
        # Bare date
        try:
            return datetime.fromisoformat(s[:10])
        except ValueError:
            return None
    year, month, day, hour, minute, sec = (int(m.group(i)) for i in range(1, 7))
    micro = int((m.group(7) or '0')[:6].ljust(6, '0'))
    tz = m.group(8)
    try:
        if tz is None or tz == 'Z':
            return datetime(year, month, day, hour, minute, sec, micro, tzinfo=timezone.utc)
        sign = 1 if tz[0] == '+' else -1
        tzs = tz[1:].replace(':', '')
        tzh, tzm = int(tzs[:2]), int(tzs[2:4])
        from datetime import timedelta
        return datetime(year, month, day, hour, minute, sec, micro,
                        tzinfo=timezone(sign * timedelta(hours=tzh, minutes=tzm)))
    except ValueError:
        return None


def get_num_of_significant_chars(x):
    if isinstance(x, bytes):
        x = x.decode('utf-8', 'replace')
    return len(x)


def pread_all(fd, n, offset=0):
    """Read up to n bytes from fd at offset (thread-safe positional read).
    Mirrors speedup.c: fewer bytes than n means EOF. Uses os.pread."""
    import os as _os
    if n <= 0:
        return b''
    return _os.pread(fd, int(n), int(offset))


def parse_iso8601(date_string: str):
    """Mirror of speedup.c parse_iso8601: returns (datetime, aware, tzseconds)
    where tzseconds is the offset east of UTC in seconds. aware is False when
    no zone was present. Raises ValueError for malformed input."""
    s = date_string.strip()
    m = _ZONED_RE.match(s)
    if m is None:
        raise ValueError(f'{date_string} is not a valid ISO 8601 datestring')
    year, month, day = int(m.group(1)), int(m.group(2)), int(m.group(3))
    hour = int(m.group(4)) if m.group(4) else 0
    minute = int(m.group(5)) if m.group(5) else 0
    sec = int(m.group(6)) if m.group(6) else 0
    micro = int((m.group(7) or '0')[:6].ljust(6, '0'))
    tz = m.group(8)
    aware = tz is not None
    tzseconds = 0
    if aware:
        if tz == 'Z':
            tzseconds = 0
        else:
            sign = 1 if tz[0] == '+' else -1
            tzs = tz[1:].replace(':', '')
            tzseconds = sign * (int(tzs[:2]) * 3600 + int(tzs[2:4]) * 60)
    try:
        dt = datetime(year, month, day, hour, minute, sec, micro)
    except ValueError as e:
        raise ValueError(f'{date_string} is not a valid ISO 8601 datestring: {e}') from e
    return dt, aware, tzseconds


_ZONED_RE = re.compile(
    r'^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?'
    r'(?:[T ](\d{2})(?::(\d{2}))?(?::(\d{2}))?(?:[.,](\d+))?)?'
    r'(Z|[+-]\d{2}:?\d{2})?$'
)
