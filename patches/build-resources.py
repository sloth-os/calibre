#!/usr/bin/env python3
"""Build the generated calibre resources the conversion engine loads.

Usage: build-resources.py <calibre-clone> <output-resources-dir> [iso-codes.zip]

Produces (into <output-resources-dir>/localization/):
  iso639.calibre_msgpack    language code -> name maps (from iso-codes)
  iso3166.calibre_msgpack   country code -> name maps
  stats.calibre_msgpack     translation availability stats (empty: en-only)
  locales.zip               per-locale .mo catalogs (empty: en-only)

Mirrors setup/translations.py ISO639/ISO3166 packing byte-for-byte (same
msgpack encoding via calibre.utils.serialize). Interface language stays
English (the web app has no UI language picker), so the locales.zip and
stats are the degenerate en-only variants localization.py already handles.
"""
import io
import json
import os
import sys
import zipfile


def _load_msgpack():
    """Import msgpack, preferring a system install; else extract the pure-
 Python fallback from the msgpack wheel the bundle build just fetched.
 (msgpack's _cmsgpack is a wasm .so in the vendored wheel — unusable on
    the build host — but its fallback.py is plain Python.)"""
    try:
        import msgpack  # noqa
        return msgpack
    except ImportError:
        pass
    # Search for a vendored msgpack wheel: env override first, then the
    # conventional layout build-bundle.sh uses.
    search = [os.environ.get('CALIBRE_WASM_WHEELS_DIR')]
    here = os.path.dirname(os.path.abspath(__file__))
    search.append(os.path.join(here, '..', 'vendor', 'wheels'))
    search.append(os.path.join(here, '..', '..', 'vendor', 'wheels'))
    for cand in search:
        if not cand or not os.path.isdir(cand):
            continue
        cand = os.path.abspath(cand)
        for name in os.listdir(cand):
            if name.startswith('msgpack-') and name.endswith('.whl'):
                import tempfile
                with tempfile.TemporaryDirectory() as td, zipfile.ZipFile(os.path.join(cand, name)) as zf:
                    zf.extractall(td)
                    sys.path.insert(0, td)
                    sys.modules['msgpack._cmsgpack'] = None  # force fallback
                    import msgpack  # noqa
                    return msgpack
    raise SystemExit('build-resources: msgpack is unavailable (no system install, no vendored wheel)')


msgpack = _load_msgpack()


def msgpack_dumps(obj):
    # calibre.utils.serialize.msgpack_dumps without importing calibre (which
    # requires Python 3.14; this script also runs on the CI host's python
    # before the wasm side exists). Mirrors its create_encoder for the one
    # exotic type these payloads contain: sets -> tuples (calibre reads them
    # back as lists and only ever does membership tests, so list == set).
    def default(o):
        if isinstance(o, (set, frozenset)):
            return tuple(o)
        raise TypeError(f'Cannot serialize objects of type {type(o)}')
    return msgpack.packb(obj, default=default, use_bin_type=True)


def fail(msg):
    raise SystemExit(f'build-resources: {msg}')


def main():
    calibre = os.path.abspath(sys.argv[1])
    out = os.path.abspath(sys.argv[2])
    iso_zip = sys.argv[3] if len(sys.argv) > 3 else '/tmp/iso-codes.zip'

    if not os.path.isfile(iso_zip):
        fail(f'iso-codes zip not found: {iso_zip} (download from '
 'https://download.calibre-ebook.com/iso-codes.zip)')

    loc = os.path.join(out, 'localization')
    os.makedirs(loc, exist_ok=True)

    with zipfile.ZipFile(iso_zip) as zf:
        top = {n.split('/')[0] for n in zf.namelist()}
        if len(top) != 1:
            fail(f'unexpected iso-codes zip layout: {sorted(top)[:4]}')
        top = top.pop()

        # ---- iso639 (same packing as setup/translations.py ISO639.run) ----
        root = json.loads(zf.read(f'{top}/data/iso_639-3.json'))
        by_2, by_3, m2to3, m3to2, nm = {}, {}, {}, {}, {}
        codes2, codes3 = set(), set()
        for x in root['639-3']:
            two = str(x.get('alpha_2')) if x.get('alpha_2') else None
            threeb = str(x.get('alpha_3')) if x.get('alpha_3') else None
            if threeb is None:
                continue
            name = x.get('inverted_name') or x.get('name')
            if name:
                name = str(name)
            if not name or name[0] in "!~=/\'\"":
                continue
            if two is not None:
                by_2[two] = name
                codes2.add(two)
                m2to3[two] = threeb
                m3to2[threeb] = two
            codes3.add(threeb)
            by_3[threeb] = name
            nm[name.lower()] = threeb
        data = {'by_2': by_2, 'by_3': by_3, 'codes2': codes2, 'codes3': codes3,
 '2to3': m2to3, '3to2': m3to2, 'name_map': nm}
        with open(os.path.join(loc, 'iso639.calibre_msgpack'), 'wb') as f:
            f.write(msgpack_dumps(data))
        print(f'iso639: {len(by_3)} languages')

        # ---- iso3166 ----
        root = json.loads(zf.read(f'{top}/data/iso_3166-1.json'))
        names, codes, c2n = {}, set(), {}
        for x in root['3166-1']:
            code = str(x.get('alpha_2')) if x.get('alpha_2') else None
            name = x.get('name')
            if not code or not name:
                continue
            names[code.lower()] = str(name)
            codes.add(code.lower())
            c2n[str(name).lower()] = code.lower()
        data = {'names': names, 'codes': codes, '2to3': c2n}
        with open(os.path.join(loc, 'iso3166.calibre_msgpack'), 'wb') as f:
            f.write(msgpack_dumps(data))
        print(f'iso3166: {len(codes)} countries')

    # ---- locales.zip/stats: NOT shipped ----
    # With no locales.zip, zf_exists() is False, get_lc_messages_path()
    # returns None for every language, and translator_for_lang /
    # dynamic.translate fall back to the _() passthrough — calibre's own
    # documented behavior for an untranslated (English) install. Shipping a
    # locales.zip that lists 'en' in stats but contains no .mo would instead
    # raise KeyError inside ZipFile.read.
    # (An empty stats.calibre_msgpack is still written: available_translations()
    # reads it defensively and empty means "no translations", same as absent.)
    with open(os.path.join(loc, 'stats.calibre_msgpack'), 'wb') as f:
        f.write(msgpack_dumps({}))
    print('stats: empty (English-only), no locales.zip')

    print('resources built OK')


if __name__ == '__main__':
    main()
