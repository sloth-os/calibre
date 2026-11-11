#!/usr/bin/env python3
"""Fetch the vendor wheels for the wasm bundle.

Usage: fetch-vendor-wheels.py <wheels-out-dir> [pyodide-version]

Two sources:
  - pure-Python wheels from PyPI (css-parser, chardet, markdown, ... — the
    runtime deps of the conversion engine that need no C code)
  - wasm wheels from the pyodide CDN (lxml, regex, Pillow, msgpack,
    pycryptodome — C-extension packages that MUST be the pyodide builds;
    a linux x86_64 wheel would be dead bytes in the browser)

The pinned set mirrors calibre's pyproject.toml dependency list, restricted
to what the conversion path imports (no Qt, no psutil/netifaces/xxhash —
those are GUI/device/db only and their wheels would bloat the bundle).
"""
import json
import os
import sys
import urllib.request

# Pure-python wheels: (name, version or None for latest)
PURE = {
    'css-parser': '1.1.1',
    'chardet': '5.2.0',
    'python-dateutil': '2.9.0.post0',
    'Markdown': None,
    'html2text': None,
    'beautifulsoup4': None,
    'soupsieve': None,
    'typing-extensions': None,
    'six': '1.17.0',
    'webencodings': '0.5.1',
    'html5lib': '1.1',
    'tzlocal': None,
    'tzdata': None,
    'jaconv': None,
    'mechanize': None,
    'feedparser': None,
    'feedparser-sgmllib': None,
    'pystache': None,
    'ifaddr': None,
    'texttable': None,
    'Deprecated': None,
    'wrapt': None,
    'click': None,
    'lxml_html_clean': None,
    'dnspython': None,
    'jeepney': None,
    'fonttools': None,
    'Pygments': None,
}

# wasm wheels from the pyodide lockfile (resolved by name).
PYODIDE_PKGS = {
    'lxml', 'regex', 'Pillow', 'msgpack', 'pycryptodome',
}


def fetch(url, dest):
    urllib.request.urlretrieve(url, dest)


def main():
    out = os.path.abspath(sys.argv[1])
    pyodide_version = sys.argv[2] if len(sys.argv) > 2 else '314.0.7'
    os.makedirs(out, exist_ok=True)

    # ---- pure-python wheels from PyPI ----
    for name, ver in PURE.items():
        meta = json.load(urllib.request.urlopen(f'https://pypi.org/pypi/{name}/json'))
        if ver is None:
            ver = meta['info']['version']
        wheel = None
        for u in meta['releases'].get(ver, []):
            if u['filename'].endswith(('py3-none-any.whl', 'py2.py3-none-any.whl')):
                wheel = (u['url'], u['filename'])
                break
        if wheel is None:
            print(f'!! no pure wheel for {name}=={ver}, skipping')
            continue
        url, fname = wheel
        dest = os.path.join(out, fname)
        if not os.path.exists(dest):
            fetch(url, dest)
        print(f'ok {fname}')

    # ---- wasm wheels from the pyodide CDN ----
    lock_url = f'https://cdn.jsdelivr.net/pyodide/v{pyodide_version}/full/pyodide-lock.json'
    lock = json.load(urllib.request.urlopen(lock_url))
    wanted = {}
    for info in lock['packages'].values():
        if info['name'] in PYODIDE_PKGS:
            wanted[info['name']] = info['file_name']
    missing = PYODIDE_PKGS - set(wanted)
    if missing:
        raise SystemExit(f'pyodide lock missing: {sorted(missing)}')
    for name, fname in wanted.items():
        dest = os.path.join(out, fname)
        if not os.path.exists(dest):
            fetch(f'https://cdn.jsdelivr.net/pyodide/v{pyodide_version}/full/{fname}', dest)
        print(f'ok {fname}')

    print(f'{len(os.listdir(out))} wheels in {out}')


if __name__ == '__main__':
    main()
