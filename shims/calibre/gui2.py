# calibre.gui2 — minimal stand-in for the GUI package, shadowing the real
# one in the wasm build (shims dir precedes calibre-src on sys.path).
#
# Only calibre.ebooks.covers imports calibre.gui2 on the conversion path,
# for four helpers. Everything else in the real gui2 needs Qt widgets.
#
# config: a JSONConfig-like object; covers reads cprefs through its own
#   JSONConfig — the 'config' import is used for... nothing at runtime.
# ensure_app: creates a QApplication — a no-op object here.
# load_builtin_fonts: registers Liberation/Calibre fonts with Qt — the shim
#   maps family names to font files so QFont._load can find them.
# pixmap_to_data: serializes a QPixmap — implemented via the qt shim.

from qt.core import QImage, QPixmap  # noqa: F401  (also proves the shim is live)


class _NullConfig:
    """JSONConfig-alike serving only the defaults the conversion path reads
    (calibre.gui2.config; the GUI preferences store does not exist in wasm).
    Unknown keys fall back to None, matching JSONConfig's missing-key None
    rather than raising — a cover template reading a GUI pref must not
    crash the conversion."""

    # Defaults mirrored from calibre/gui2/__init__.py _config().
    _defaults = {
        'use_roman_numerals_for_series_number': True,
    }

    def get(self, key, default=None):
        return self._defaults.get(key, default)

    def __getitem__(self, key):
        return self._defaults.get(key, None)

    def __contains__(self, key):
        return key in self._defaults

    def __setitem__(self, key, value):
        self._defaults[key] = value


config = _NullConfig()

_app = None
_fonts_loaded = False

# family name -> resource path for the fonts the cover generator names.
_FONT_FILES = {
    'Liberation Serif': 'fonts/liberation/LiberationSerif-Regular.ttf',
    'Liberation Sans': 'fonts/liberation/LiberationSans-Regular.ttf',
    'Liberation Mono': 'fonts/liberation/LiberationMono-Regular.ttf',
}


def ensure_app(headless=True):
    """No QApplication exists in wasm; return a inert marker."""
    global _app
    if _app is None:
        _app = object()
    return _app


def must_use_qt(headless=True):
    """Mirror of calibre.gui2.must_use_qt: on desktop it asserts a
    QApplication exists and that the caller is on the GUI thread before
    non-GUI Qt rendering (SVG rasterization in oeb/transforms/rasterize.py,
    HTML rendering). The wasm build has no Qt event loop and no threads —
    the qt shim renders through Pillow on the worker's only thread — so
    this degenerates to the ensure_app() marker. Code needing a REAL
    QApplication (none on the conversion path) is unsupported."""
    ensure_app(headless=headless)
    return None


def load_builtin_fonts():
    """Point the qt shim's QFont at the shipped Liberation faces."""
    global _fonts_loaded
    if _fonts_loaded:
        return
    _fonts_loaded = True
    import os
    from qt.core import QFont as _QFont

    lookup = getattr(_QFont, '_family_file_map', None)
    if lookup is None:
        lookup = {}
        _QFont._family_file_map = lookup
    for family, rel in _FONT_FILES.items():
        try:
            from calibre.utils.resources import get_path
            path = get_path(rel, allow_user_override=False)
            if os.path.exists(path):
                lookup[family] = path
        except Exception:
            pass


def pixmap_to_data(pixmap, fmt='JPEG', quality=None):
    """Serialize a QPixmap/QImage to bytes via the qt shim."""
    pil = pixmap.to_pil()
    import io
    buf = io.BytesIO()
    if fmt.upper() in ('JPG', 'JPEG'):
        pil.convert('RGB').save(buf, 'JPEG', quality=quality or 90)
    else:
        pil.save(buf, fmt)
    return buf.getvalue()
