# translator — .mo catalog reader. calibre/utils/localization.py uses
# Translator(buf) to read compiled gettext files from locales.zip. This is a
# pure-Python .mo parser implementing the GNU gettext file format
# (little-endian and big-endian magic) plus the header/metadata lookup the
# localization code performs (info(), gettext(), ngettext(), pgettext(),
# install()).

import struct
from gettext import NullTranslations


def _parse_mo(data):
    """Return {msgctxt\x04msgid: msgstr} for a .mo file, or None if invalid."""
    if not isinstance(data, (bytes, bytearray)) or len(data) < 20:
        return None
    magic = struct.unpack('<I', data[:4])[0]
    if magic == 0x950412DE:
        fmt = '<'
    elif magic == 0xDE120495:
        fmt = '>'
    else:
        return None
    version, n, off_tab, tr_tab = struct.unpack(f'{fmt}4I', data[4:20])
    catalog = {}
    for i in range(n):
        src_len, src_off = struct.unpack(f'{fmt}2I', data[off_tab + 8 * i:off_tab + 8 * i + 8])
        dst_len, dst_off = struct.unpack(f'{fmt}2I', data[tr_tab + 8 * i:tr_tab + 8 * i + 8])
        src = data[src_off:src_off + src_len]
        dst = data[dst_off:dst_off + dst_len]
        catalog[src] = dst
    return catalog


class Translator(NullTranslations):
    """API-compatible subset of calibre_extensions.translator.Translator."""

    def __init__(self, buf=None, name=None):
        self._catalog = {}
        self._info = {}
        if buf is not None:
            cat = _parse_mo(buf)
            if cat is None:
                raise ValueError('Failed to parse translations file')
            for src, dst in cat.items():
                src_s = src.decode('utf-8')
                if dst:
                    self._catalog[src_s] = dst.decode('utf-8')
                if src_s == '':
                    # header: parse metadata lines
                    for line in dst.decode('utf-8', 'replace').splitlines():
                        if ':' in line:
                            k, _, v = line.partition(':')
                            self._info[k.strip()] = v.strip()

    def gettext(self, message):
        return self._catalog.get(message, message)

    def ngettext(self, singular, plural, n):
        plural_form = self._catalog.get(singular, None)
        if plural_form is None:
            return singular if n == 1 else plural
        # Simple European plural rule; C module uses the header rule table.
        cands = plural_form.split('\x00')
        if n == 1:
            return cands[0]
        return cands[-1] if len(cands) > 1 else cands[0]

    def pgettext(self, context, message):
        key = f'{context}\x04{message}'
        return self._catalog.get(key, message)

    def info(self):
        return dict(self._info)

    def install(self, names=None):
        import builtins
        builtins.__dict__['_'] = self.gettext
        if names:
            for n in names:
                if n == 'ngettext':
                    builtins.__dict__['ngettext'] = self.ngettext
                elif n == 'pgettext':
                    builtins.__dict__['pgettext'] = self.pgettext
