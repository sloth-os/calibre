# qt.core — Pillow-backed stand-in for the PyQt6 QtCore/QtGui surface the
# ebook conversion path uses. calibre.utils.img drives QImage/QBuffer/
# QImageReader/QImageWriter; calibre.ebooks.covers draws cover art with
# QPainter/QPainterPath/QFont. This module provides both classes faithfully
# enough for the operations those code paths perform, with QImage wrapping a
# PIL.Image.

import io
import math
import os

from PIL import Image as _PILImage
from PIL import ImageDraw as _PILDraw
from PIL import ImageFont as _PILFont

# Re-export the path/gradient/format classes living in qpath.py (kept in a
# sibling module for size; importable from qt.core like every other name).
from .qpath import (  # noqa: F401
    QGradient,
    QLinearGradient,
    QPainterPath,
    QRadialGradient,
    QTextCharFormat,
)


class Qt:  # namespace for enums used by the conversion path
    class AspectRatioMode:
        IgnoreAspectRatio = 0
        KeepAspectRatio = 1
        KeepAspectRatioByExpanding = 2

    class TransformationMode:
        FastTransformation = 0
        SmoothTransformation = 1

    class GlobalColor:
        # Values pinned to Qt's real enum (code that passes raw ints, e.g.
        # image.fill(QColor('white').rgb()), relies on QRgb layout, but the
        # symbolic constants must stay consistent with fill()'s lookup).
        color0 = 0
        color1 = 1
        black = 2
        white = 3
        darkGray = 4
        gray = 5
        lightGray = 6
        red = 7
        green = 8
        blue = 9
        cyan = 10
        magenta = 11
        yellow = 12
        darkRed = 13
        darkGreen = 14
        darkBlue = 15
        darkCyan = 16
        darkMagenta = 17
        darkYellow = 18
        transparent = 19

    class AlignmentFlag:
        # Real Qt values (qnamespace.h). Producers (calibre) and consumers
        # (this shim) both read these constants, so they must match Qt's —
        # covers.py ORs AlignHCenter|AlignTop into QTextOption and the text
        # layout reads the bits back at draw time.
        AlignLeft = 0x0001
        AlignRight = 0x0002
        AlignHCenter = 0x0004
        AlignJustify = 0x0008
        AlignAbsolute = 0x0010
        AlignTop = 0x0020
        AlignBottom = 0x0040
        AlignVCenter = 0x0080
        AlignBaseline = 0x0100
        AlignCenter = AlignVCenter | AlignHCenter

    class TextFlag:
        # Real Qt values (qnamespace.h). TextWordWrap MUST be 0x1000: the
        # shim's earlier 0x100 collided with AlignBaseline (0x0100) — Qt
        # keeps the two enums disjoint precisely so drawText(rect, flags)
        # can OR alignment and text flags (covers.py:848 does). Qt only
        # tolerates AlignBaseline == TextSingleLine (0x0100) because
        # AlignBaseline is meaningless to drawText (qnamespace.h comment).
        TextSingleLine = 0x0100
        TextDontClip = 0x0200
        TextExpandTabs = 0x0400
        TextShowMnemonic = 0x0800
        TextWordWrap = 0x1000
        TextWrapAnywhere = 0x2000
        TextDontPrint = 0x4000
        TextIncludeTrailingSpaces = 0x08000000
        TextHideMnemonic = 0x8000
        TextJustificationForced = 0x10000
        TextForceLeftToRight = 0x20000
        TextForceRightToLeft = 0x40000
        TextLongestVariant = 0x80000

    class PenStyle:
        NoPen = 0
        SolidLine = 1

    class PenCapStyle:
        FlatCap = 0x00
        SquareCap = 0x10
        RoundCap = 0x20

    class PenJoinStyle:
        MiterJoin = 0x01
        BevelJoin = 0x02
        RoundJoin = 0x04
        SvgMiterJoin = 0x80

    class BrushStyle:
        NoBrush = 0
        SolidPattern = 1

    class FillRule:
        OddEvenFill = 0
        WindingFill = 1

    class ImageConversionFlag:
        AutoColor = 0

    class ColorSpace:
        SRgb = 0

    class KeyboardModifier:
        NoModifier = 0

    class Modifier:
        NoModifier = 0

    class SizeMode:
        AbsoluteSize = 0
        RelativeSize = 1


def qRgba(r, g, b, a=255):
    # Qt QRgb layout is 0xAARRGGBB: (a << 24) | (r << 16) | (g << 8) | b.
    return ((a << 24) | (r << 16) | (g << 8) | b) & 0xFFFFFFFF


def qRed(qrgb): return (qrgb >> 16) & 0xFF
def qGreen(qrgb): return (qrgb >> 8) & 0xFF
def qBlue(qrgb): return qrgb & 0xFF
def qAlpha(qrgb): return (qrgb >> 24) & 0xFF


def _qrgb_to_rgba(v):
    """QRgb int (0xAARRGGBB, the layout qRgba() produces) -> (r, g, b, a)."""
    return ((v >> 16) & 0xFF, (v >> 8) & 0xFF, v & 0xFF, (v >> 24) & 0xFF)


# QColor name table (Qt's colorNames subset: the SVG/CSS names the cover
# themes and rasterize.py use — QColor('white') etc.). Values follow Qt's
# own table (its 'green' is #00ff00, gray ramp is #808080/#a0a0a0/#c0c0c0).
_NAMED_COLORS = {
    'transparent': (0, 0, 0, 0),
    'black': (0, 0, 0), 'white': (255, 255, 255),
    'darkgray': (169, 169, 169), 'darkgrey': (169, 169, 169),
    'gray': (128, 128, 128), 'grey': (128, 128, 128),
    'lightgray': (211, 211, 211), 'lightgrey': (211, 211, 211),
    'red': (255, 0, 0), 'green': (0, 255, 0), 'blue': (0, 0, 255),
    'cyan': (0, 255, 255), 'magenta': (255, 0, 255), 'yellow': (255, 255, 0),
    'darkred': (139, 0, 0), 'darkgreen': (0, 100, 0), 'darkblue': (0, 0, 139),
    'darkcyan': (0, 139, 139), 'darkmagenta': (139, 0, 139),
    'darkyellow': (128, 128, 0),
    'orange': (255, 165, 0), 'purple': (128, 0, 128), 'pink': (255, 192, 203),
    'brown': (165, 42, 42), 'navy': (0, 0, 128), 'teal': (0, 128, 128),
    'silver': (192, 192, 192), 'gold': (255, 215, 0), 'olive': (128, 128, 0),
    'maroon': (128, 0, 0), 'lime': (0, 255, 0), 'aqua': (0, 255, 255),
    'fuchsia': (255, 0, 255), 'ivory': (255, 255, 240),
    'beige': (245, 245, 220), 'linen': (250, 240, 230),
    'aliceblue': (240, 248, 255), 'ghostwhite': (248, 248, 255),
    'cornsilk': (255, 248, 220), 'wheat': (245, 222, 179),
    'khaki': (240, 230, 140), 'salmon': (250, 128, 114),
    'coral': (255, 127, 80), 'tomato': (255, 99, 71),
    'steelblue': (70, 130, 180), 'slategray': (112, 128, 144),
    'dimgray': (105, 105, 105), 'whitesmoke': (245, 245, 245),
}

# GlobalColor enum value -> (r, g, b, a), for QImage.fill(Qt.GlobalColor.*).
# Values are the global_colors[] table from Qt's qcolor.cpp (QColor's
# GlobalColor constructor) — NOT the CSS/X11 palette: Qt gray is (160,160,164)
# from the Windows 3.0 VGA static palette, darkGray is (128,128,128), etc.
_GLOBAL_COLORS = {
    Qt.GlobalColor.color0: (255, 255, 255, 255),
    Qt.GlobalColor.color1: (0, 0, 0, 255),
    Qt.GlobalColor.black: (0, 0, 0, 255),
    Qt.GlobalColor.white: (255, 255, 255, 255),
    Qt.GlobalColor.darkGray: (128, 128, 128, 255),
    Qt.GlobalColor.gray: (160, 160, 164, 255),
    Qt.GlobalColor.lightGray: (192, 192, 192, 255),
    Qt.GlobalColor.red: (255, 0, 0, 255),
    Qt.GlobalColor.green: (0, 255, 0, 255),
    Qt.GlobalColor.blue: (0, 0, 255, 255),
    Qt.GlobalColor.cyan: (0, 255, 255, 255),
    Qt.GlobalColor.magenta: (255, 0, 255, 255),
    Qt.GlobalColor.yellow: (255, 255, 0, 255),
    Qt.GlobalColor.darkRed: (128, 0, 0, 255),
    Qt.GlobalColor.darkGreen: (0, 128, 0, 255),
    Qt.GlobalColor.darkBlue: (0, 0, 128, 255),
    Qt.GlobalColor.darkCyan: (0, 128, 128, 255),
    Qt.GlobalColor.darkMagenta: (128, 0, 128, 255),
    Qt.GlobalColor.darkYellow: (128, 128, 0, 255),
    Qt.GlobalColor.transparent: (0, 0, 0, 0),
}


def _resolve_color(color):
    """QColor | QRgb int | Qt.GlobalColor -> (r, g, b, a).

    Int disambiguation follows the value ranges: anything above 0xFF is a
    QRgb (0xAARRGGBB — even a dim color exceeds 0xFF once alpha bits are
    set); 0 is fully transparent black (QRgb 0x00000000 == color0); the
    small values are GlobalColor enum members.
    """
    if isinstance(color, QColor):
        return (color.red(), color.green(), color.blue(), color.alpha())
    if isinstance(color, int):
        if color > 0xFF:
            return _qrgb_to_rgba(color)
        if color == 0:
            return (0, 0, 0, 0)
        return _GLOBAL_COLORS.get(color, (0, 0, 0, 0))
    if hasattr(color, 'red'):  # duck-typed QColor
        return (color.red(), color.green(), color.blue(), getattr(color, 'alpha', lambda: 255)())
    return (0, 0, 0, 0)


class QByteArray:
    def __init__(self, data=b''):
        self._data = bytes(data)

    def data(self):
        return self._data

    def size(self):
        return len(self._data)

    def length(self):
        return len(self._data)

    def isEmpty(self):
        return not self._data

    def __len__(self):
        return len(self._data)

    def __bytes__(self):
        return self._data


class QBuffer:
    """In-memory QIODevice over a QByteArray.

    Qt's QBuffer reads/writes DIRECTLY into its wrapped byte array, so
    callers (calibre's image_to_data) may read ba.data() right after
    writer.write() without ever calling close(). This shim mirrors that:
    open() seeds an internal BytesIO per the mode (ReadOnly keeps the
    array's bytes, WriteOnly truncates) and every write() syncs back to
    the byte array immediately.
    """

    def __init__(self, byte_array=None):
        self._ba = byte_array if byte_array is not None else QByteArray()
        self._buf = None
        self._mode = None

    def open(self, mode):
        self._mode = mode
        seed = b'' if mode == QIODevice.OpenModeFlag.WriteOnly else bytes(self._ba)
        self._buf = io.BytesIO(seed)
        return True

    def isOpen(self):
        return self._buf is not None

    def close(self):
        if self._buf is not None:
            self._sync()
            self._buf.close()
            self._buf = None

    def _sync(self):
        """Push the buffer contents into the wrapped QByteArray (write-through)."""
        if self._buf is not None and isinstance(self._ba, QByteArray):
            self._ba._data = self._buf.getvalue()

    def read(self, *a):
        return self._buf.read(*a) if self._buf else b''

    def write(self, data):
        if not self._buf:
            return 0
        n = self._buf.write(data)
        self._sync()
        return n

    def seek(self, pos, whence=0):
        return self._buf.seek(pos, whence)

    def tell(self):
        return self._buf.tell() if self._buf else 0

    def data(self):
        self._sync()
        return bytes(self._ba)

    def buffer(self):
        return self.data()


class QIODevice:
    class OpenModeFlag:
        ReadOnly = 1
        WriteOnly = 2
        ReadWrite = 3


class QColor:
    def __init__(self, *args):
        if len(args) == 1 and isinstance(args[0], QColor):
            self._rgb, self._alpha = args[0]._rgb, args[0]._alpha
        elif len(args) == 1 and isinstance(args[0], int):
            # QColor(QRgb) — 0xAARRGGBB, the layout qRgba() produces.
            self._rgb, self._alpha = _qrgb_to_rgba(args[0])[:3], _qrgb_to_rgba(args[0])[3]
        elif len(args) == 1 and isinstance(args[0], str):
            name = args[0].strip()
            named = _NAMED_COLORS.get(name.lower())
            if named is not None:
                self._rgb = tuple(named[:3])
                self._alpha = named[3] if len(named) == 4 else 255
                return
            c = name.lstrip('#')
            if len(c) == 3:
                c = ''.join(x * 2 for x in c)
            if len(c) in (6, 8):
                try:
                    self._rgb = tuple(int(c[i:i + 2], 16) for i in (0, 2, 4))
                    self._alpha = int(c[6:8], 16) if len(c) == 8 else 255
                except ValueError:
                    self._rgb, self._alpha = (0, 0, 0), 255
            else:
                # Qt: an unparseable name yields an INVALID color (isValid()
                # False, components 0). Callers like covers.py feed theme
                # colors that are always well-formed; mirroring invalidity
                # keeps bad input diagnosable instead of silently black.
                self._rgb, self._alpha = (0, 0, 0), 255
                self._valid = False
                return
        elif len(args) == 3:
            self._rgb, self._alpha = tuple(int(a) for a in args), 255
        elif len(args) == 4:
            self._rgb, self._alpha = tuple(int(a) for a in args[:3]), int(args[3])
        else:
            self._rgb, self._alpha = (0, 0, 0), 255
        self._valid = True

    def red(self): return self._rgb[0]
    def green(self): return self._rgb[1]
    def blue(self): return self._rgb[2]
    def alpha(self): return self._alpha

    def rgb(self):
        # Qt: the RGB value with an OPAQUE alpha (0xffRRGGBB).
        r, g, b = self._rgb
        return 0xFF000000 | (r << 16) | (g << 8) | b

    def rgba(self):
        # Qt: 0xAARRGGBB (NOT a component tuple — PIL-facing code inside
        # this shim uses _as_rgba()/_resolve_color() instead).
        r, g, b = self._rgb
        return ((self._alpha << 24) | (r << 16) | (g << 8) | b) & 0xFFFFFFFF

    def getRgb(self):
        return (self._rgb[0], self._rgb[1], self._rgb[2], self._alpha)

    def isValid(self):
        # Qt: invalid when constructed from an unparseable name/empty.
        return getattr(self, '_valid', True)

    def darker(self, factor=200):
        f = factor / 100 if factor >= 100 else factor
        if f > 1:  # Qt: factor>100 darkens (multiply by factor/100)
            return QColor(*(max(0, int(c * 100 / factor)) for c in self._rgb))
        return QColor(*(max(0, int(c * factor / 100)) for c in self._rgb))

    def lighter(self, factor=150):
        return QColor(*(min(255, int(c * factor / 100)) for c in self._rgb))

    def name(self):
        return '#{:02x}{:02x}{:02x}'.format(*self._rgb)

    def __eq__(self, other):
        if isinstance(other, QColor):
            return self._rgb == other._rgb and self._alpha == other._alpha
        return NotImplemented

    def __hash__(self):
        return hash((self._rgb, self._alpha))

    def __repr__(self):
        return f'QColor({self._rgb[0]}, {self._rgb[1]}, {self._rgb[2]}, {self._alpha})'


class QImage:
    """PIL-backed QImage. Only the operations the conversion path uses:
    constructors from data/size/path, scaled(), width/height,
    hasAlphaChannel(), convertToFormat-ish color handling via Pillow modes,
    and save/load through calibre.utils.img's image_to_data (which hands us
    bytes via QImageWriter below)."""

    class Format:
        # Nested enum (PyQt6 style: QImage.Format.Format_ARGB32). Values
        # pinned to Qt's real QImage::Format.
        Format_Invalid = 0
        Format_Mono = 1
        Format_MonoLSB = 2
        Format_Indexed8 = 3
        Format_RGB32 = 4
        Format_ARGB32 = 5
        Format_ARGB32_Premultiplied = 6
        Format_RGB16 = 13
        Format_RGBA8888 = 17
        Format_RGBA8888_Premultiplied = 18
        Format_RGBX8888 = 22
        Format_Grayscale8 = 24
        Format_Grayscale16 = 28

    # Flat aliases (PyQt5 style also used across calibre).
    Format_Invalid = 0
    Format_Mono = 1
    Format_MonoLSB = 2
    Format_Indexed8 = 3
    Format_RGB32 = 4
    Format_ARGB32 = 5
    Format_ARGB32_Premultiplied = 6
    Format_RGB16 = 13
    Format_RGBA8888 = 17
    Format_RGBA8888_Premultiplied = 18
    Format_RGBX8888 = 22
    Format_Grayscale8 = 24
    Format_Grayscale16 = 28

    # Format -> PIL mode for freshly allocated images. Grayscale16 maps to
    # 8-bit 'L' (documented downgrade: PIL's 16-bit modes don't survive the
    # encoder roundtrips calibre performs; the only caller is the GUI-only
    # PIL bridge, and comic input — which uses it — is thread-blocked).
    _FMT_MODE = {
        Format_RGB32: 'RGB',
        Format_RGBX8888: 'RGB',
        Format_RGB16: 'RGB',
        Format_ARGB32: 'RGBA',
        Format_ARGB32_Premultiplied: 'RGBA',
        Format_RGBA8888: 'RGBA',
        Format_RGBA8888_Premultiplied: 'RGBA',
        Format_Grayscale8: 'L',
        Format_Grayscale16: 'L',
        Format_Indexed8: 'P',
        Format_Mono: '1',
        Format_MonoLSB: '1',
    }

    def __init__(self, *args):
        self._pil = None
        self._fmt = self.Format_Invalid
        self._dpr = 1.0
        self._color_table = None
        if len(args) == 0:
            return
        a0 = args[0]
        # QImage(other) — copy constructor
        if len(args) == 1 and isinstance(a0, QImage):
            self._pil = a0._pil.copy() if a0._pil is not None else None
            self._fmt, self._dpr = a0._fmt, a0._dpr
            return
        # QImage(path)
        if len(args) == 1 and isinstance(a0, str):
            self.load(a0)
            return
        # QImage(QSize[, fmt]) / QImage((w, h)[, fmt])
        if isinstance(a0, (QSize, tuple)) and len(args) <= 2:
            w, h = (a0.width(), a0.height()) if isinstance(a0, QSize) else a0
            self._alloc(int(w), int(h), args[1] if len(args) == 2 else self.Format_ARGB32)
            return
        # QImage(data, w, h, fmt) — raw pixel bytes (PIL bridge; best-effort
        # for the layouts PIL models without color tables/scanline padding)
        if len(args) >= 4 and isinstance(a0, (bytes, bytearray, memoryview)):
            self._from_raw(bytes(a0), int(args[1]), int(args[2]), args[3])
            return
        # QImage(w, h[, fmt])
        if len(args) == 2 and isinstance(a0, int):
            self._alloc(args[0], args[1], self.Format_ARGB32)
            return
        if len(args) == 3 and isinstance(a0, int):
            self._alloc(args[0], args[1], args[2])
            return
        if len(args) == 1 and isinstance(a0, _PILImage.Image):
            self._pil = a0
            self._fmt = self.Format_ARGB32 if a0.mode in ('RGBA', 'LA', 'PA') else self.Format_RGB32

    def _alloc(self, w, h, fmt):
        self._fmt = fmt
        mode = self._FMT_MODE.get(fmt, 'RGBA')
        fill = (255, 255, 255) if mode == 'RGB' else 0 if mode in ('L', '1', 'P') else (0, 0, 0, 0)
        self._pil = _PILImage.new(mode, (max(0, int(w)), max(0, int(h))), fill)

    def _from_raw(self, data, w, h, fmt):
        self._fmt = fmt
        try:
            if fmt in (self.Format_RGBA8888, self.Format_RGBA8888_Premultiplied):
                self._pil = _PILImage.frombytes('RGBA', (w, h), data, 'raw', 'RGBA')
            elif fmt in (self.Format_ARGB32, self.Format_ARGB32_Premultiplied):
                # little-endian ARGB32 in memory is BGRA byte order
                self._pil = _PILImage.frombytes('RGBA', (w, h), data, 'raw', 'BGRA')
            elif fmt == self.Format_RGBX8888:
                self._pil = _PILImage.frombytes('RGB', (w, h), data, 'raw', 'RGBX')
            elif fmt == self.Format_RGB32:
                self._pil = _PILImage.frombytes('RGB', (w, h), data, 'raw', 'BGRX')
            elif fmt == self.Format_Grayscale8:
                self._pil = _PILImage.frombytes('L', (w, h), data, 'raw', 'L')
            # Indexed8/Mono/Grayscale16 need color-table and scanline-
            # alignment handling the PIL bridge does not model; those stay
            # null (only the GUI-only convert_PIL_image_to_pixmap path hits
            # them, and it is never called headless).
        except Exception:
            self._pil = None

    def setColorTable(self, table):
        self._color_table = list(table) if table else None

    def colorTable(self):
        return self._color_table or []

    @classmethod
    def from_pil(cls, pil, fmt=None):
        q = cls.__new__(cls)
        q._pil = pil
        q._fmt = fmt if fmt is not None else (cls.Format_ARGB32 if pil is not None and pil.mode in ('RGBA', 'LA', 'PA') else cls.Format_RGB32)
        q._dpr = 1.0
        q._color_table = None
        return q

    def to_pil(self):
        return self._pil

    def _require(self):
        if self._pil is None:
            raise ValueError('null QImage')
        return self._pil

    def isNull(self):
        return self._pil is None

    def width(self):
        return self._pil.width

    def height(self):
        return self._pil.height

    def size(self):
        # Plain (w, h) tuple: every consumer on the conversion path either
        # feeds it back into a constructor (which accepts tuples/QSize) or
        # compares sizes to each other.
        return (self._pil.width, self._pil.height)

    def rect(self):
        return QRect(0, 0, self._pil.width, self._pil.height)

    def format(self):
        return self._fmt

    def depth(self):
        return {self.Format_Mono: 1, self.Format_MonoLSB: 1,
                self.Format_Indexed8: 8, self.Format_Grayscale8: 8,
                self.Format_RGB16: 16, self.Format_Grayscale16: 16}.get(self._fmt, 32)

    def setDevicePixelRatio(self, ratio):
        self._dpr = float(ratio)

    def devicePixelRatio(self):
        return self._dpr

    def devicePixelRatioF(self):
        return self._dpr

    def fill(self, color=0):
        """Fill the whole image with a QColor / QRgb int / Qt.GlobalColor.
        Full replacement (Qt blends translucent fills over the existing
        content; every conversion-path caller fills with opaque colors or
        clears with transparent, where replacement is equivalent)."""
        p = self._require()
        rgba = _resolve_color(color)
        bands = len(p.getbands())
        if bands == 1:
            fill = int(0.299 * rgba[0] + 0.587 * rgba[1] + 0.114 * rgba[2])
            if p.mode == '1':
                fill = 255 if fill >= 128 else 0
        elif bands == 3:
            fill = rgba[:3]
        else:
            fill = rgba
        _PILDraw.Draw(p).rectangle([0, 0, p.width - 1, p.height - 1], fill=fill)

    def copy(self, *args):
        p = self._require()
        if not args:
            return QImage.from_pil(p.copy(), self._fmt)
        if len(args) == 1 and isinstance(args[0], (QRect, QRectF)):
            r = args[0]
            args = (r.x(), r.y(), r.width(), r.height())
        x, y, w, h = (int(v) for v in args[:4])
        return QImage.from_pil(p.crop((x, y, x + w, y + h)), self._fmt)

    def mirrored(self, horizontal=False, vertical=True):
        # Qt defaults: mirrored(horizontal=False, vertical=True)
        p = self._require()
        if horizontal:
            p = p.transpose(_PILImage.Transpose.FLIP_LEFT_RIGHT)
        if vertical:
            p = p.transpose(_PILImage.Transpose.FLIP_TOP_BOTTOM)
        return QImage.from_pil(p, self._fmt)

    def transformed(self, transform, mode=Qt.TransformationMode.SmoothTransformation):
        """Apply a QTransform via PIL's affine resampling: map the corners
        to size the output, then sample through the inverse matrix."""
        p = self._require()
        w, h = p.size
        pts = [transform.map(*c) for c in ((0, 0), (w, 0), (0, h), (w, h))]
        minx = min(pt.x() for pt in pts)
        maxx = max(pt.x() for pt in pts)
        miny = min(pt.y() for pt in pts)
        maxy = max(pt.y() for pt in pts)
        # round() before ceil: cos(90°) is ~6e-17, so a rotated 50x40
        # image yields bbox widths like 40.000000000000003 and ceil would
        # add a spurious pixel row/column.
        ow, oh = int(math.ceil(round(maxx - minx, 9))), int(math.ceil(round(maxy - miny, 9)))
        if ow <= 0 or oh <= 0:
            return QImage()
        inv = transform._inverted()
        # Output pixel O corresponds to mapped coord O + (minx, miny), and
        # input = inv.map(mapped) — so the PIL AFFINE coefficients
        # (input = a*X + b*Y + c, d*X + e*Y + f) fold the bbox offset
        # through the inverse's linear part:
        a, b = inv.m11(), inv.m21()
        d, e = inv.m12(), inv.m22()
        c = inv.m31() + a * minx + b * miny
        f = inv.m32() + d * minx + e * miny
        resample = _PILImage.Resampling.BICUBIC if mode == Qt.TransformationMode.SmoothTransformation else _PILImage.Resampling.NEAREST
        out = p.transform((ow, oh), _PILImage.Transform.AFFINE, (a, b, c, d, e, f), resample=resample)
        return QImage.from_pil(out, self._fmt)

    def load(self, path, fmt=None):
        try:
            with _PILImage.open(str(path)) as im:
                self._pil = im.copy()
            self._fmt = self.Format_ARGB32 if self._pil.mode in ('RGBA', 'LA', 'PA') else self.Format_RGB32
            return True
        except Exception:
            return False

    def loadFromData(self, data, fmt=None):
        try:
            with _PILImage.open(io.BytesIO(bytes(data))) as im:
                self._pil = im.copy()
            self._fmt = self.Format_ARGB32 if self._pil.mode in ('RGBA', 'LA', 'PA') else self.Format_RGB32
            return True
        except Exception:
            return False

    def save(self, dest, fmt=None, quality=-1):
        """Serialize to a path, file object or QBuffer. Mirrors Qt's return
        contract: True on success, False on any encoding failure."""
        p = self._require()
        if isinstance(fmt, bytes):
            fmt = fmt.decode('ascii')
        if not fmt:
            fmt = os.path.splitext(str(dest))[1].lstrip('.') if isinstance(dest, str) else 'PNG'
        try:
            if isinstance(dest, QBuffer):
                out = io.BytesIO()
                _pil_save_format(p, out, fmt, quality)
                dest.write(out.getvalue())   # write-through lands in the QByteArray
            elif hasattr(dest, 'write'):
                _pil_save_format(p, dest, fmt, quality)
            else:
                _pil_save_format(p, str(dest), fmt, quality)
        except Exception:
            return False
        return True

    def hasAlphaChannel(self):
        return self._pil is not None and self._pil.mode in ('RGBA', 'LA', 'PA')

    def allGray(self):
        # covers.py uses this to decide whether to emit grayscale; compare
        # each pixel's R/G/B to detect an actual grayscale image.
        p = self._require().convert('RGB')
        w, h = p.size
        px = p.load()
        for y in range(0, h, max(1, h // 64)):
            for x in range(0, w, max(1, w // 64)):
                r, g, b = px[x, y]
                if r != g or g != b:
                    return False
        return True

    def scaled(self, w, h, aspect=Qt.AspectRatioMode.IgnoreAspectRatio, mode=Qt.TransformationMode.SmoothTransformation):
        if isinstance(w, QSize):
            w, h = w.width(), w.height()
        p = self._require()
        resample = _PILImage.Resampling.LANCZOS if mode == Qt.TransformationMode.SmoothTransformation else _PILImage.Resampling.NEAREST
        if aspect in (Qt.AspectRatioMode.KeepAspectRatio, Qt.AspectRatioMode.KeepAspectRatioByExpanding):
            return QImage.from_pil(_scale_aspect(p, (w, h), aspect, resample), self._fmt)
        return QImage.from_pil(p.resize((int(w), int(h)), resample), self._fmt)

    def scaledToWidth(self, w, mode=Qt.TransformationMode.SmoothTransformation):
        p = self._require()
        resample = _PILImage.Resampling.LANCZOS if mode == Qt.TransformationMode.SmoothTransformation else _PILImage.Resampling.NEAREST
        h = max(1, round(p.height * w / p.width))
        return QImage.from_pil(p.resize((int(w), h), resample), self._fmt)

    def scaledToHeight(self, h, mode=Qt.TransformationMode.SmoothTransformation):
        p = self._require()
        resample = _PILImage.Resampling.LANCZOS if mode == Qt.TransformationMode.SmoothTransformation else _PILImage.Resampling.NEAREST
        w = max(1, round(p.width * h / p.height))
        return QImage.from_pil(p.resize((w, int(h)), resample), self._fmt)

    def convertToFormat(self, fmt, flags=0):
        p = self._require()
        mode = self._FMT_MODE.get(fmt)
        if mode is None:
            mode = 'L' if fmt == self.Format_Grayscale8 else 'RGB' if fmt == self.Format_RGB32 else 'RGBA'
        if p.mode != mode:
            p = p.convert(mode)
        return QImage.from_pil(p, fmt)

    def bits(self):
        return self._require().tobytes()

    def constBits(self):
        return self._require().tobytes()

    def sizeInBytes(self):
        p = self._require()
        return len(p.tobytes())

    def setText(self, key, value):
        # Qt stores image metadata strings; the shim keeps them on the
        # object only (they never reach the serialized output).
        self._text = getattr(self, '_text', None) or {}
        self._text[key] = value

    def text(self, key):
        return (getattr(self, '_text', None) or {}).get(key, '')


def _pil_save_format(pil, dest, fmt, quality=-1):
    """Encode `pil` to dest (path or file object) in format `fmt`."""
    fmt = (fmt or 'PNG').upper()
    if fmt in ('JPG', 'JPEG'):
        fmt = 'JPEG'
    if fmt in ('JPEG', 'PPM', 'BMP') and pil.mode not in ('RGB', 'L'):
        pil = pil.convert('RGB')
    if fmt == 'JPEG':
        q = 90 if quality is None or quality < 0 else int(quality)
        pil.save(dest, 'JPEG', quality=q, optimize=True)
    elif fmt == 'PNG':
        pil.save(dest, 'PNG')
    elif fmt == 'WEBP':
        q = 90 if quality is None or quality < 0 else int(quality)
        pil.save(dest, 'WEBP', quality=q)
    elif fmt == 'GIF':
        _save_gif(pil, dest)
    else:
        pil.save(dest, fmt)


def _save_gif(pil, dest):
    if pil.mode == 'P':
        pil.save(dest, 'GIF')
    elif pil.mode in ('RGBA', 'LA'):
        alpha = pil.split()[-1]
        mask = _PILImage.eval(alpha, lambda a: 255 if a <= 128 else 0)
        p = pil.convert('RGB').convert('P', palette=_PILImage.Palette.ADAPTIVE, colors=255)
        p.paste(255, mask)
        p.save(dest, 'GIF', transparency=255)
    else:
        pil.convert('P', palette=_PILImage.Palette.ADAPTIVE).save(dest, 'GIF')


def _scale_aspect(pil, target, aspect, resample):
    tw, th = target
    sw, sh = pil.size
    if aspect == Qt.AspectRatioMode.KeepAspectRatio:
        scale = min(tw / sw, th / sh)
    else:
        scale = max(tw / sw, th / sh)
    nw, nh = max(1, round(sw * scale)), max(1, round(sh * scale))
    return pil.resize((nw, nh), resample)


class QImageReader:
    # PIL format -> Qt lowercase format bytes (QImageReader.format()).
    # MPO (multi-picture JPEG, common from cameras) reports as jpeg — same
    # as Qt. JXL/AVIF have no Qt mapping here (they arrive via dedicated
    # calibre paths) and sniff to b'' like any unknown container.
    _FMT_MAP = {
        'JPEG': b'jpeg', 'MPO': b'jpeg', 'PNG': b'png', 'GIF': b'gif',
        'BMP': b'bmp', 'WEBP': b'webp', 'TIFF': b'tiff',
    }

    def __init__(self, device_or_path, fmt=None):
        self._buf = None
        self._path = None
        if isinstance(device_or_path, QBuffer):
            self._buf = device_or_path
        else:
            self._path = device_or_path
        self._auto_transform = False

    def _device_data(self):
        """Bytes backing the wrapped QBuffer WITHOUT consuming its read
        position (the QByteArray stays in sync through open()/write())."""
        dev = self._buf
        if dev is None:
            return b''
        if isinstance(dev._ba, QByteArray):
            return dev._ba.data()
        return bytes(dev._ba or b'')

    def read(self):
        try:
            if self._buf is not None:
                data = self._buf.read() if self._buf._buf else self._device_data()
                pil = _PILImage.open(io.BytesIO(data)).copy()
            else:
                pil = _PILImage.open(self._path).copy()
        except Exception:
            return QImage()
        return QImage.from_pil(pil)

    def format(self):
        try:
            if self._buf is not None:
                data = self._device_data()
                if not data:
                    return b''
                with _PILImage.open(io.BytesIO(data)) as im:
                    fmt = im.format
            else:
                with _PILImage.open(self._path) as im:
                    fmt = im.format
        except Exception:
            return b''
        return self._FMT_MAP.get(fmt or '', b'')

    def canRead(self):
        return True

    def imageCount(self):
        return 1

    def supportsAnimation(self):
        return False

    def setAutoTransform(self, enabled):
        self._auto_transform = bool(enabled)

    def autoTransform(self):
        return self._auto_transform

    def errorString(self):
        return 'Unable to read image'


class QImageWriter:
    def __init__(self, device_or_path, fmt=None):
        self._buf = device_or_path if isinstance(device_or_path, QBuffer) else None
        self._path = None if self._buf is not None else device_or_path
        self._fmt = fmt.decode('ascii').upper() if isinstance(fmt, bytes) else (fmt or 'PNG').upper()
        self._quality = 90

    def setQuality(self, q):
        self._quality = q

    def setOptimizedWrite(self, on):
        pass

    def setProgressiveScanWrite(self, on):
        pass

    def write(self, image):
        p = image.to_pil() if isinstance(image, QImage) else image
        try:
            if self._fmt in ('JPG', 'JPEG'):
                p = p.convert('RGB')
            if self._buf is not None:
                out = io.BytesIO()
                self._save(p, out)
                self._buf.write(out.getvalue())
            else:
                self._save(p, self._path)
        except Exception:
            return False
        return True

    def _save(self, pil, dest):
        if self._fmt in ('JPG', 'JPEG'):
            pil.save(dest, 'JPEG', quality=self._quality, optimize=True)
        elif self._fmt == 'PNG':
            pil.save(dest, 'PNG', optimize=(self._quality > 90))
        elif self._fmt == 'WEBP':
            pil.save(dest, 'WEBP', quality=self._quality)
        else:
            pil.save(dest, self._fmt)

    def errorString(self):
        return 'Unable to write image'


class QPainter:
    """Minimal painter for covers.py: drawImage/drawText/fillRect on a
    QImage target with a font, pen and brush."""

    class RenderHint:
        Antialiasing = 1
        TextAntialiasing = 2
        SmoothPixmapTransform = 4

    class CompositionMode:
        SourceOver = 0

    def __init__(self, target=None):
        self._target = target
        self._draw = None
        self._font = QFont()
        self._pen = QPen()
        if target is not None:
            self.begin(target)

    def begin(self, target):
        self._target = target
        self._draw = _PILDraw.Draw(target.to_pil(), 'RGBA')
        return True

    def end(self):
        self._draw = None

    def setFont(self, font):
        self._font = font

    def font(self):
        return self._font

    def setPen(self, pen):
        # Qt accepts a QPen or a QColor (auto-wrapped); covers.py passes both.
        self._pen = pen if isinstance(pen, QPen) else QPen(pen if pen is not None else QColor(0, 0, 0))

    def pen(self):
        return self._pen

    def setRenderHint(self, *a):
        pass

    def setCompositionMode(self, m):
        pass

    def drawImage(self, *args):
        """Overloads used on the conversion path: (x, y, image[, ...]),
        (QPoint, image), (QRect, image) — the rect form SCALES the image
        to the target rect (Qt semantics)."""
        a0 = args[0]
        if isinstance(a0, (QRect, QRectF)):
            rect, image = a0, args[1]
            pil = image.to_pil()
            tw, th = max(1, int(rect.width())), max(1, int(rect.height()))
            if (pil.width, pil.height) != (tw, th):
                pil = pil.resize((tw, th), _PILImage.Resampling.LANCZOS)
            self._paste_at(pil, int(rect.x()), int(rect.y()))
            return
        if isinstance(a0, (QPoint, QPointF)):
            image = args[1]
            x, y = a0.x(), a0.y()
        else:
            x, y, image = args[0], args[1], args[2]
        self._paste_at(image.to_pil(), int(x), int(y))

    def _paste_at(self, pil, x, y):
        base = self._target.to_pil()
        if base.mode not in ('RGBA', 'RGB'):
            base = base.convert('RGBA')
        if pil.mode not in ('RGBA', 'RGB'):
            pil = pil.convert('RGBA')
        base.paste(pil, (x, y), pil if pil.mode == 'RGBA' else None)
        self._target._pil = base
        self._draw = _PILDraw.Draw(base, 'RGBA')

    def setClipPath(self, path, operation=None):
        # Decorative vector art is recorded but never painted (see qpath.py),
        # so clipping it is a no-op by construction. Known fidelity gap: the
        # Cross cover style (1 of the 5 styles covers.py picks at random)
        # uses a QPainterPath clip for its rounded corner band; here that
        # band renders with square corners instead of clipped. Cosmetic —
        # every pixel still lands inside the canvas and inside the band's
        # bounding box.
        pass

    def setClipRect(self, *args, **kwargs):
        pass

    def setClipping(self, on):
        pass

    def fillRect(self, *args):
        rect, color = args if len(args) == 2 else (args[:4], args[4])
        if isinstance(rect, QRect):
            x, y, w, h = rect.x(), rect.y(), rect.width(), rect.height()
        else:
            x, y, w, h = rect
        x, y, w, h = float(x), float(y), float(w), float(h)
        if w < 0:  # Qt normalizes negative sizes before painting (QRectF
            x += w  # rule); an empty rect is a silent no-op there, while
            w = -w  # PIL would raise ValueError on x1 < x0.
        if h < 0:
            y += h
            h = -h
        if w == 0 or h == 0:
            return
        # Qt QRect(x, y, w, h) is exclusive-end; PIL rectangle paints
        # both endpoints inclusive, so subtract 1 or every fill grows
        # by a pixel row/column.
        box = [int(x), int(y), int(x + w) - 1, int(y + h) - 1]
        # A QBrush wrapping a gradient: interpolate its stops down the
        # gradient axis (vertical for QLinearGradient from the cover style).
        inner = getattr(color, '_color', None)
        if inner is not None and not isinstance(color, QColor):
            grad = getattr(inner, '_stops', None)
            if grad:
                self._fill_gradient(box, grad)
                return
            color = inner  # QBrush wrapping a plain color
        self._draw.rectangle(box, fill=_resolve_color(color))

    def _fill_gradient(self, box, stops):
        """Vertical linear gradient fill (the only gradient the cover
        generator paints with): per-scanline lerp between the stops."""
        x0, y0, x1, y1 = box
        # box ends are inclusive (fillRect subtracted 1 for PIL); paint
        # every scanline through y1.
        height = max(1, y1 - y0 + 1)
        stops = sorted(stops, key=lambda s: s[0])

        def sample(frac):
            for i in range(len(stops) - 1):
                p0, c0 = stops[i]
                p1, c1 = stops[i + 1]
                if p0 <= frac <= p1 or i == len(stops) - 2:
                    t = 0 if p1 == p0 else (frac - p0) / (p1 - p0)
                    t = max(0.0, min(1.0, t))
                    c0, c1 = _as_rgba(c0), _as_rgba(c1)
                    return tuple(int(a + (b - a) * t) for a, b in zip(c0, c1))
            return _as_rgba(stops[-1][1])

        for y in range(y0, y1 + 1):
            # Qt samples the gradient at each pixel CENTER, so the first
            # scanline already sits half a pixel into the ramp and the end
            # stop is approached symmetrically.
            frac = (y - y0 + 0.5) / height
            self._draw.line([(x0, y), (x1, y)], fill=sample(frac))

    def drawText(self, *args):
        # (rect, flags, text) or (x, y, text)
        if len(args) == 3 and isinstance(args[0], (QRect, QRectF)):
            rect, flags, text = args
            flags = int(flags)
            f = self._font._load()
            s = str(text)
            box = f.getbbox(s)
            ascent, descent = f.getmetrics()
            # Ink width/height and the ink's offset from the pen origin:
            # PIL 'la' anchor puts the ascender line at y and the ink's left
            # edge at x + box[0], so subtract that to land the ink where Qt
            # would. TextWordWrap is ignored (documented in _TextLine).
            xoff = box[0] if box else 0
            tw = (box[2] - box[0]) if box else 0
            th = ascent + descent
            if flags & Qt.AlignmentFlag.AlignRight:
                x = rect.x() + rect.width() - tw
            elif flags & Qt.AlignmentFlag.AlignHCenter:
                x = rect.x() + (rect.width() - tw) / 2.0
            else:
                x = rect.x()
            if flags & Qt.AlignmentFlag.AlignBottom:
                y = rect.y() + rect.height() - th
            elif flags & Qt.AlignmentFlag.AlignVCenter:
                y = rect.y() + (rect.height() - th) / 2.0
            else:
                y = rect.y()  # AlignTop / default: ascender at rect top
            x -= xoff
            self._draw.text((int(x), int(y)), s,
                            fill=_as_rgba(self._pen._color), font=f)
            return
        x, y, text = args
        self._draw.text((int(x), int(y)), str(text),
                        fill=_as_rgba(self._pen._color), font=self._font._load())

    def setOpacity(self, o):
        pass

    def viewport(self):
        return QRect(0, 0, self._target.width(), self._target.height())

    def drawLine(self, *a):
        pass

    def save(self):
        self._stack = getattr(self, '_stack', None) or []
        self._stack.append((self._font, self._pen))
        return None

    def restore(self):
        if getattr(self, '_stack', None):
            self._font, self._pen = self._stack.pop()
        return None

    def setRenderHint(self, hint, on=True):
        pass

    def setRenderHints(self, hints, on=True):
        pass

    def setBrush(self, brush):
        self._brush = brush

    def setViewport(self, r):
        pass

    def setWindow(self, *a):
        # Logical coordinate mapping (painter.setWindow); the shim draws in
        # device coordinates and the cover style's fixed VIEWPORT equals the
        # image size, so the identity mapping is exact.
        pass

    # Transform stack — used only by the corner-vector art (drawn via
    # QPainterPath, which this shim records but does not paint), so they are
    # all identity no-ops.
    def rotate(self, *a):
        pass

    def translate(self, *a):
        pass

    def scale(self, *a):
        pass

    def setWorldTransform(self, *a):
        pass

    def worldTransform(self):
        return QTransform()

    def drawRect(self, *a):
        rect = a[0] if len(a) == 1 else QRect(*a[:4])
        w, h = rect.width(), rect.height()
        if w <= 0 or h <= 0:
            return  # empty rect: Qt no-ops; PIL raises on x1 < x0
        # Same exclusive-end → inclusive-end correction as fillRect.
        self._draw.rectangle(
            [rect.x(), rect.y(),
             rect.x() + w - 1, rect.y() + h - 1],
            outline=_as_rgba(self._pen._color),
        )

    def drawPath(self, path):
        # Decorative vector art on generated covers: recorded but not
        # painted (see qpath.py).
        pass

    def fillPath(self, path, brush):
        pass

    def drawEllipse(self, *a):
        pass

    def drawPolygon(self, *a):
        pass

    def drawPicture(self, *a):
        pass


class QPen:
    def __init__(self, color=None, width=1, style=Qt.PenStyle.SolidLine,
                 cap=Qt.PenCapStyle.SquareCap, join=Qt.PenJoinStyle.BevelJoin):
        self._color = color if color is not None else QColor(0, 0, 0)
        self._width = width
        self._style = style
        self._cap = cap
        self._join = join

    def color(self):
        return self._color

    def setColor(self, c):
        self._color = c

    def setWidth(self, w):
        self._width = w

    def setWidthF(self, w):
        self._width = w

    def width(self):
        return self._width

    def style(self):
        return self._style

    def setStyle(self, s):
        self._style = s

    def capStyle(self):
        return self._cap

    def setCapStyle(self, c):
        self._cap = c

    def joinStyle(self):
        return self._join

    def setJoinStyle(self, j):
        self._join = j

    def setDashPattern(self, pattern):
        pass


class QBrush:
    def __init__(self, *a):
        self._color = a[0] if a and isinstance(a[0], (QColor, QLinearGradient, QRadialGradient)) else QColor(0, 0, 0)
        self._style = a[1] if len(a) > 1 else Qt.BrushStyle.SolidPattern

    def color(self):
        return self._color if isinstance(self._color, QColor) else QColor(0, 0, 0)

    def setColor(self, c):
        self._color = c

    def style(self):
        return self._style

    def setStyle(self, s):
        self._style = s


def _as_rgba(c):
    """Color-ish object -> (r, g, b, a) tuple for PIL fill/outline args."""
    return _resolve_color(c)


class QFont:
    SansSerif = 0
    Serif = 1
    Normal = 0
    Bold = 1

    class StyleStrategy:
        PreferAntialias = 1
        NoAntialias = 2

    class Weight:
        Normal = 400
        Bold = 700

    def __init__(self, *args):
        self._family = args[0] if args and isinstance(args[0], str) else None
        self._size = 12
        self._bold = False
        if len(args) >= 2 and isinstance(args[1], int):
            self._size = args[1]

    def setBold(self, b):
        self._bold = b

    def setPixelSize(self, s):
        self._size = s

    def pointSize(self):
        return self._size

    def setPointSize(self, s):
        self._size = s

    def setStyleStrategy(self, s):
        pass

    def setLetterSpacing(self, t, v):
        pass

    def setWeight(self, w):
        self._bold = w >= QFont.Weight.Bold

    def _load(self):
        try:
            if self._family:
                # load_builtin_fonts() (calibre.gui2 shim) registers family
                # names -> font file paths here.
                fmap = getattr(QFont, '_family_file_map', None) or {}
                path = fmap.get(self._family)
                if path:
                    return _PILFont.truetype(path, self._size)
                return _PILFont.truetype(self._family, self._size)
        except Exception:
            pass
        try:
            return _PILFont.load_default(size=self._size)
        except TypeError:
            return _PILFont.load_default()

    def family(self):
        return self._family


class QTextOption:
    class WrapMode:
        NoWrap = 0
        WordWrap = 1
        WrapAnywhere = 2
        WrapAtWordBoundaryOrAnywhere = 3

    def __init__(self, alignment=None):
        self._alignment = alignment
        # Qt's QTextOption default IS WrapAtWordBoundaryOrAnywhere.
        self._wrap = QTextOption.WrapMode.WrapAtWordBoundaryOrAnywhere

    def setWrapMode(self, m):
        self._wrap = m

    def wrapMode(self):
        return self._wrap

    def setAlignment(self, a):
        self._alignment = a

    def alignment(self):
        return self._alignment


def _fit_prefix_len(word, fits):
    """Longest n such that fits(word[:n]) holds. `fits` is monotone (if a
    prefix doesn't fit, no longer prefix does), so binary search is exact."""
    lo, hi = 0, len(word)
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if fits(word[:mid]):
            lo = mid
        else:
            hi = mid - 1
    return lo


class _TextLine:
    """One laid-out line of a QTextLayout: x/y position, width, height.
    Wrapping happens in setLineWidth (the Qt flow: createLine returns an
    empty line, the caller gives it a width, the NEXT createLine continues
    with what did not fit)."""

    def __init__(self, text, font, layout=None):
        self._text = text
        self._font = font
        self._layout = layout
        self._x = 0.0
        self._y = 0.0
        self._width = 0.0
        self._valid = bool(text)
        f = font._load()
        ascent, descent = f.getmetrics()
        # QTextLine::height() is the FONT height (ascent + descent), not the
        # ink height of this particular text: covers.py accumulates
        # `height += line.height()` for its leading math, and ink height
        # would under-space lines and collapse on punctuation-only text.
        self._ascent = float(ascent)
        self._height = float(ascent + descent)

    def isValid(self):
        return self._valid

    def _fits(self, f, s):
        if not s:
            return True
        box = f.getbbox(s)
        return box is None or (box[2] - box[0]) <= self._width

    def setLineWidth(self, w):
        # The real wrap: fill this line up to w, hand the overflow back to
        # the layout's pending pool. Honors the QTextOption wrap mode — the
        # *OrAnywhere modes break space-less tokens (CJK runs, which have no
        # spaces at all, and long compounds) at character boundaries like
        # Qt does; plain WordWrap only breaks at spaces.
        self._width = float(w)
        if not self._text or self._layout is None:
            return
        opt = self._layout._option
        wrap = (opt.wrapMode() if opt is not None
                else QTextOption.WrapMode.WrapAtWordBoundaryOrAnywhere)
        if wrap == QTextOption.WrapMode.NoWrap:
            return
        hard_anywhere = wrap == QTextOption.WrapMode.WrapAnywhere
        anywhere = hard_anywhere or wrap == QTextOption.WrapMode.WrapAtWordBoundaryOrAnywhere
        f = self._font._load()
        if self._fits(f, self._text):
            return
        words = self._text.split(' ')
        keep = []
        rest = ''
        idx = 0
        while idx < len(words):
            word = words[idx]
            if self._fits(f, ' '.join(keep + [word])):
                keep.append(word)
                idx += 1
                continue
            if not anywhere:
                # Qt WordWrap: an over-wide FIRST word is placed whole on
                # its own line (it simply overflows); otherwise break here.
                if not keep:
                    keep.append(word)
                    idx += 1
                break
            if keep and not hard_anywhere:
                # WrapAtWordBoundaryOrAnywhere with words already kept:
                # break AT the word boundary — mid-word splitting is only
                # for a word that does not fit on a line of its own.
                break
            prefix = ' '.join(keep)
            n = _fit_prefix_len(
                word, lambda s: self._fits(f, (prefix + ' ' + s).strip()))
            take = max(n, 1)  # always progress, even if one char overflows
            keep.append(word[:take])
            if word[take:]:
                rest = word[take:]
            idx += 1
            break
        self._text = ' '.join(keep)
        overflow = ' '.join(([rest] if rest else []) + words[idx:]).strip()
        if overflow:
            self._layout._pending = (overflow + ' ' + self._layout._pending).strip()

    def lineWidth(self):
        return self._width

    def setPosition(self, p):
        self._x, self._y = float(p.x()), float(p.y())

    def position(self):
        return QPointF(self._x, self._y)

    def height(self):
        return self._height

    def width(self):
        f = self._font._load()
        box = f.getbbox(self._text or ' ') or (0, 0, 0, 0)
        return float(box[2] - box[0])

    def naturalTextWidth(self):
        return self.width()

    def draw(self, painter, p):
        # Qt draws each line with the pen origin on the BASELINE at
        # pos.y + line.y + ascent, and honors the QTextOption alignment
        # within the line's set width. PIL's default 'la' anchor places the
        # y argument on the ascender line and internally adds the ascent to
        # reach the baseline — so passing pos.y + line.y here yields exactly
        # Qt's baseline. (Adding _ascent as well would double-count it and
        # sink every line one ascent too low.) Qt's alignLine applies
        # (line.width - textAdvance) verbatim, even negative for over-wide
        # lines, so do not clamp.
        opt = self._layout._option if self._layout is not None else None
        align = int((opt.alignment() if opt is not None else None) or 0)
        x = self._x + p.x()
        if align & Qt.AlignmentFlag.AlignRight:
            x += self._width - self.width()
        elif align & Qt.AlignmentFlag.AlignHCenter:
            x += (self._width - self.width()) / 2.0
        painter._draw.text(
            (int(x), int(self._y + p.y())),
            str(self._text),
            fill=_as_rgba(painter._pen._color),
            font=self._font._load(),
        )


class QTextLayout:
    """Line-broken text layout over Pillow measurement: enough of the Qt
    text engine for calibre.ebooks.covers (createLine/setLineWidth/draw)."""

    class FormatRange:
        """A styled span: {start, length, format}."""

        def __init__(self):
            self.start = 0
            self.length = 0
            self.format = None

    def __init__(self, text='', font=None, paintengine=None):
        self._text = text or ''
        self._font = font or QFont()
        self._option = QTextOption()
        self._lines = []
        self._pending = self._text
        self._pos = QPointF(0, 0)
        self._formats = []
        self._rect = QRectF(0, 0, 0, 0)

    def setText(self, t):
        self._text = t or ''
        self._pending = self._text
        self._lines = []

    def setFont(self, f):
        self._font = f

    def setTextOption(self, o):
        self._option = o

    def textOption(self):
        return self._option

    def setFormats(self, formats):
        # QTextLayout formats (font/weight spans); the shim renders whole
        # lines with the layout font — bold spans are a cosmetic difference.
        self._formats = formats or []

    def beginLayout(self):
        self._lines = []
        self._pending = self._text

    def createLine(self):
        # Take the pending text verbatim; the wrap happens in the line's
        # setLineWidth (Qt's flow), which returns overflow to _pending.
        line = _TextLine(self._pending, self._font, layout=self)
        self._pending = ''
        self._lines.append(line)
        return line

    def endLayout(self):
        # boundingRect over all lines: union of the line boxes (Qt's
        # boundingRect is in layout coordinates, starting at the layout's
        # own position).
        w = 0.0
        top = None
        bottom = 0.0
        for ln in self._lines:
            w = max(w, ln.width())
            y0 = ln.position().y()
            y1 = y0 + ln.height()
            top = y0 if top is None else min(top, y0)
            bottom = max(bottom, y1)
        h = (bottom - (top or 0.0)) if top is not None else 0.0
        self._rect = QRectF(self._pos.x(), self._pos.y() + (top or 0.0), w, h)

    def setPosition(self, p):
        self._pos = QPointF(p.x(), p.y())

    def position(self):
        return self._pos

    def boundingRect(self):
        return self._rect

    def lineAt(self, i):
        return self._lines[i] if 0 <= i < len(self._lines) else _TextLine('', self._font)

    def lineCount(self):
        return len(self._lines)

    def draw(self, painter, p):
        for ln in self._lines:
            ln.draw(painter, QPointF(self._pos.x() + p.x(), self._pos.y() + p.y()))


class QFontMetrics:
    def __init__(self, font, paintengine_or_img=None):
        self._font = font

    def width(self, text):
        f = self._font._load()
        box = f.getbbox(text)
        return box[2] - box[0] if box else 0

    def horizontalAdvance(self, text):
        return self.width(text)

    def height(self):
        f = self._font._load()
        ascent, descent = f.getmetrics()
        return ascent + descent

    def ascent(self):
        f = self._font._load()
        return f.getmetrics()[0]

    def descent(self):
        f = self._font._load()
        return f.getmetrics()[1]

    def leading(self):
        return max(1, self.height() // 8)

    def lineSpacing(self):
        # Qt: ascent + descent + leading.
        return self.height() + self.leading()


class QRect:
    def __init__(self, *a):
        if len(a) == 4:
            self._x, self._y, self._w, self._h = a
        elif len(a) == 1 and isinstance(a[0], QRect):
            self._x, self._y, self._w, self._h = a[0]._x, a[0]._y, a[0]._w, a[0]._h
        else:
            self._x = self._y = self._w = self._h = 0

    def x(self): return self._x
    def y(self): return self._y
    def width(self): return self._w
    def height(self): return self._h
    def left(self): return self._x
    def top(self): return self._y
    def right(self): return self._x + self._w - 1   # Qt: right() is inclusive
    def bottom(self): return self._y + self._h - 1  # Qt: bottom() is inclusive
    def setWidth(self, w): self._w = w
    def setHeight(self, h): self._h = h
    def setLeft(self, v): self._x = v
    def setTop(self, v): self._y = v
    def setRight(self, v): self._w = v - self._x + 1     # Qt: right is inclusive
    def setBottom(self, v): self._h = v - self._y + 1    # Qt: bottom is inclusive
    def setSize(self, s): self._w, self._h = s.width(), s.height()
    def adjusted(self, dx1, dy1, dx2, dy2):
        return QRect(self._x + dx1, self._y + dy1, self._w + dx1 + dx2, self._h + dy1 + dy2)

    def adjust(self, dx1, dy1, dx2, dy2):
        self._x += dx1; self._y += dy1
        self._w += dx1 + dx2; self._h += dy1 + dy2

    def translated(self, dx, dy):
        return QRect(self._x + dx, self._y + dy, self._w, self._h)

    def size(self):
        return QSize(self._w, self._h)

    def contains(self, *a):
        if isinstance(a[0], QPoint):
            p = a[0]
            return self._x <= p.x() < self._x + self._w and self._y <= p.y() < self._y + self._h
        r = a[0] if len(a) == 1 else QRect(*a)
        return (self._x <= r.x() and r.x() + r.width() <= self._x + self._w and
                self._y <= r.y() and r.y() + r.height() <= self._y + self._h)

    def center(self):
        return QPoint(self._x + self._w // 2, self._y + self._h // 2)


class QRectF(QRect):
    pass


class QPoint:
    def __init__(self, x=0, y=0):
        self._x, self._y = x, y

    def x(self): return self._x
    def y(self): return self._y

    def setX(self, x): self._x = x
    def setY(self, y): self._y = y

    def manhattanLength(self):
        return abs(self._x) + abs(self._y)

    def __add__(self, other):
        if isinstance(other, QPoint):
            cls = QPointF if isinstance(self, QPointF) or isinstance(other, QPointF) else QPoint
            return cls(self._x + other._x, self._y + other._y)
        return NotImplemented

    def __sub__(self, other):
        if isinstance(other, QPoint):
            cls = QPointF if isinstance(self, QPointF) or isinstance(other, QPointF) else QPoint
            return cls(self._x - other._x, self._y - other._y)
        return NotImplemented

    def __eq__(self, other):
        if isinstance(other, QPoint):
            return self._x == other._x and self._y == other._y
        return NotImplemented

    def __hash__(self):
        return hash((self._x, self._y))

    def __repr__(self):
        return f'{type(self).__name__}({self._x}, {self._y})'


class QPointF(QPoint):
    pass


class QSize:
    def __init__(self, w=0, h=0):
        self._w, self._h = w, h

    def width(self): return self._w
    def height(self): return self._h

    def setWidth(self, w): self._w = int(w)
    def setHeight(self, h): self._h = int(h)

    def isEmpty(self):
        return self._w <= 0 or self._h <= 0

    def isValid(self):
        return self._w >= 0 and self._h >= 0

    def scale(self, *args):
        """In-place scale (Qt mutates and returns None). Accepts
        (w, h, mode) or (QSize, mode); invalid/non-positive targets or
        source sizes make it a no-op."""
        if len(args) >= 3:
            w, h, mode = args[0], args[1], args[2]
        else:
            s = args[0]
            mode = args[1] if len(args) > 1 else Qt.AspectRatioMode.KeepAspectRatio
            w, h = (s.width(), s.height()) if isinstance(s, QSize) else s
        if self._w <= 0 or self._h <= 0 or w is None or h is None or w <= 0 or h <= 0:
            return
        if mode == Qt.AspectRatioMode.IgnoreAspectRatio:
            self._w, self._h = int(w), int(h)
            return
        ratio = float(w) / self._w
        if mode == Qt.AspectRatioMode.KeepAspectRatio:
            ratio = min(ratio, float(h) / self._h)
        else:  # KeepAspectRatioByExpanding
            ratio = max(ratio, float(h) / self._h)
        self._w = max(1, int(self._w * ratio))
        self._h = max(1, int(self._h * ratio))

    def scaled(self, *args):
        copy = QSize(self._w, self._h)
        copy.scale(*args)
        return copy

    def expandedTo(self, other):
        return QSize(max(self._w, other.width()), max(self._h, other.height()))

    def boundedTo(self, other):
        return QSize(min(self._w, other.width()), min(self._h, other.height()))

    def __eq__(self, other):
        if isinstance(other, QSize):
            return self._w == other.width() and self._h == other.height()
        if isinstance(other, tuple) and len(other) == 2:
            return (self._w, self._h) == other
        return NotImplemented

    def __hash__(self):
        return hash((self._w, self._h))

    def __repr__(self):
        return f'QSize({self._w}, {self._h})'


class QSizeF(QSize):
    pass


class QMarginsF:
    def __init__(self, l=0, t=0, r=0, b=0):
        self.left_, self.top_, self.right_, self.bottom_ = l, t, r, b

    def left(self): return self.left_
    def right(self): return self.right_
    def top(self): return self.top_
    def bottom(self): return self.bottom_


class QPageLayout:
    class Orientation:
        Portrait = 0
        Landscape = 1

    class Unit:
        Millimeter = 0
        Point = 1
        Inch = 2

    def __init__(self, *a):
        pass


class QPageSize:
    def __init__(self, *a):
        pass


class QTimer:
    def __init__(self, *a):
        pass


class QObject:
    pass


class QUrl:
    def __init__(self, *a):
        pass


class QByteArrayMatcher:
    pass


class QPixmap(QImage):
    """Pillow-backed QPixmap; shares QImage's implementation (in Qt terms a
    QPixmap is a platform-depictable image — for our purposes identical)."""

    def toImage(self):
        img = QImage.from_pil(self._pil.copy() if self._pil is not None else None)
        img._fmt, img._dpr = self._fmt, self._dpr
        return img

    @staticmethod
    def fromImage(image):
        return QPixmap(image)

    @staticmethod
    def grabWidget(*a, **k):
        raise NotImplementedError('QPixmap.grabWidget needs a GUI widget')


class QTransform:
    """Real 3x3 affine transform (Qt row-vector convention: mapping point
    p gives (m11*x + m21*y + m31, m12*x + m22*y + m32)). calibre's
    img.rotate_image builds QTransform().rotate(deg) and applies it with
    QImage.transformed(); covers.py uses the identity transform."""

    def __init__(self, *a):
        if len(a) >= 9:
            self._m = [list(a[0:3]), list(a[3:6]), list(a[6:9])]
        elif len(a) >= 6:
            m11, m12, m21, m22, dx, dy = a[:6]
            self._m = [[m11, m12, 0.0], [m21, m22, 0.0], [dx, dy, 1.0]]
        else:
            self._m = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]]

    # element accessors (Qt names)
    def m11(self): return self._m[0][0]
    def m12(self): return self._m[0][1]
    def m13(self): return self._m[0][2]
    def m21(self): return self._m[1][0]
    def m22(self): return self._m[1][1]
    def m23(self): return self._m[1][2]
    def m31(self): return self._m[2][0]
    def m32(self): return self._m[2][1]
    def m33(self): return self._m[2][2]
    def dx(self): return self._m[2][0]
    def dy(self): return self._m[2][1]

    def isIdentity(self):
        return self._m == [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]]

    def _compose(self, other):
        """self * other — applying (self*other) to p equals applying self
        then other (Qt row-vector convention)."""
        a, b = self._m, other._m
        return QTransform(*[sum(a[i][k] * b[k][j] for k in range(3))
                            for i in range(3) for j in range(3)])

    def __mul__(self, other):
        if isinstance(other, QTransform):
            return self._compose(other)
        return NotImplemented

    def rotate(self, angle, axis=None):
        # Qt: positive angle rotates CLOCKWISE in screen coords (y down).
        # In-place (returns self), like every QTransform mutator in Qt.
        # Only Z-axis rotation is meaningful for 2D image work; X/Y are
        # perspective transforms nothing on the conversion path uses.
        if axis is not None and axis != 2:
            return self
        a = math.radians(float(angle))
        c, s = math.cos(a), math.sin(a)
        self._m = self._compose(QTransform(c, s, -s, c, 0.0, 0.0))._m
        return self

    def scale(self, sx, sy=None):
        sy = sx if sy is None else sy
        self._m = self._compose(QTransform(float(sx), 0.0, 0.0, float(sy), 0.0, 0.0))._m
        return self

    def translate(self, dx, dy):
        self._m = self._compose(QTransform(1.0, 0.0, 0.0, 1.0, float(dx), float(dy)))._m
        return self

    def shear(self, sh, sv):
        self._m = self._compose(QTransform(1.0, float(sv), float(sh), 1.0, 0.0, 0.0))._m
        return self

    def map(self, *args):
        if len(args) == 2:
            x, y = args
            point = None
        elif len(args) == 1 and isinstance(args[0], (QPoint, QPointF)):
            point = args[0]
            x, y = point.x(), point.y()
        else:
            raise TypeError('QTransform.map expects (x, y) or a QPoint/QPointF')
        nx = self._m[0][0] * x + self._m[1][0] * y + self._m[2][0]
        ny = self._m[0][1] * x + self._m[1][1] * y + self._m[2][1]
        if point is not None:
            return type(point)(nx, ny)
        return QPointF(nx, ny)

    def mapRect(self, rect):
        pts = [self.map(*c) for c in
               ((rect.x(), rect.y()), (rect.x() + rect.width(), rect.y()),
                (rect.x(), rect.y() + rect.height()),
                (rect.x() + rect.width(), rect.y() + rect.height()))]
        minx = min(p.x() for p in pts)
        miny = min(p.y() for p in pts)
        return QRectF(minx, miny,
                      max(p.x() for p in pts) - minx,
                      max(p.y() for p in pts) - miny)

    def _inverted(self):
        m = self._m
        det = (m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
               - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
               + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]))
        if det == 0:
            return QTransform()
        inv = [[0.0] * 3 for _ in range(3)]
        inv[0][0] = (m[1][1] * m[2][2] - m[1][2] * m[2][1]) / det
        inv[0][1] = (m[0][2] * m[2][1] - m[0][1] * m[2][2]) / det
        inv[0][2] = (m[0][1] * m[1][2] - m[0][2] * m[1][1]) / det
        inv[1][0] = (m[1][2] * m[2][0] - m[1][0] * m[2][2]) / det
        inv[1][1] = (m[0][0] * m[2][2] - m[0][2] * m[2][0]) / det
        inv[1][2] = (m[0][2] * m[1][0] - m[0][0] * m[1][2]) / det
        inv[2][0] = (m[1][0] * m[2][1] - m[1][1] * m[2][0]) / det
        inv[2][1] = (m[0][1] * m[2][0] - m[0][0] * m[2][1]) / det
        inv[2][2] = (m[0][0] * m[1][1] - m[0][1] * m[1][0]) / det
        return QTransform(*[inv[i][j] for i in range(3) for j in range(3)])

    def inverted(self):
        # PyQt contract: returns (transform, invertible)
        m = self._m
        det = (m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
               - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
               + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]))
        if det == 0:
            return QTransform(), False
        return self._inverted(), True

    def __repr__(self):
        return f'QTransform({self._m!r})'


class QSvgRenderer:
    """SVG renderer over Pillow (which has no SVG support). Parses the
    document's intrinsic size (width/height attrs, else viewBox) so callers
    get correctly sized output — Qt returns 100x100 when an SVG carries no
    intrinsic size, and calibre's rasterize_svg explicitly detects that
    fallback. render() paints NOTHING: rasterized SVGs come out blank at
    the right dimensions (documented degradation — Pillow cannot rasterize
    vector content, and calibre guards every rasterize call with
    try/except, treating SVGs as replaceable images)."""

    def __init__(self, source=None):
        self._data = None
        if isinstance(source, (QByteArray, bytes, bytearray)):
            self._data = bytes(source)
        elif isinstance(source, str) and os.path.exists(source):
            try:
                with open(source, 'rb') as f:
                    self._data = f.read()
            except OSError:
                self._data = None
        self._root = None
        if self._data:
            try:
                import xml.etree.ElementTree as ET
                root = ET.fromstring(self._data)
                if root.tag.split('}')[-1] == 'svg':
                    self._root = root
            except Exception:
                self._root = None

    def isValid(self):
        return self._root is not None

    def defaultSize(self):
        if self._root is not None:
            w = self._svg_len(self._root.get('width'))
            h = self._svg_len(self._root.get('height'))
            if w is None or h is None:
                vb = (self._root.get('viewBox') or '').replace(',', ' ').split()
                if len(vb) == 4:
                    try:
                        w = float(vb[2]) if w is None else w
                        h = float(vb[3]) if h is None else h
                    except ValueError:
                        pass
            if w and h and w > 0 and h > 0:
                return QSize(int(w), int(h))
        return QSize(100, 100)

    @staticmethod
    def _svg_len(v):
        if not v:
            return None
        v = v.strip()
        try:
            if v.endswith('px'):
                return float(v[:-2])
            if v.endswith('pt'):
                return float(v[:-2]) * 96.0 / 72.0
            if v.endswith('%'):
                return None   # percentage sizes need the viewport; use viewBox
            return float(v)
        except ValueError:
            return None

    def viewBoxSize(self):
        if self._root is not None:
            vb = (self._root.get('viewBox') or '').replace(',', ' ').split()
            if len(vb) == 4:
                try:
                    return QSize(int(float(vb[2])), int(float(vb[3])))
                except ValueError:
                    pass
        return QSize(0, 0)

    def render(self, *a, **k):
        # No-op: see the class docstring (blank raster at defaultSize()).
        return None


pyqtSignal = object  # never used at runtime in the conversion path


def sip_cast(*a, **k):
    raise NotImplementedError('sip is not available in the wasm build')


class sip:
    cast = staticmethod(sip_cast)
    isdeleted = staticmethod(lambda *a: False)
    castinstance = staticmethod(sip_cast)


def dynamic_load(name, name_map, already_imported, qt_modules, module_names=()):
    # Mirror of calibre/src/qt/loader.py contract: resolve `name` against the
    # name map. Everything this module defines answers directly; anything
    # else raises AttributeError, same as the real loader for a missing name.
    if name in module_names or hasattr(__import__(__name__), name):
        return getattr(__import__(__name__), name)
    raise AttributeError(f'The object {name} is not a known Qt object')


# The upstream qt/core.py imports these two from core_name_map.py and the
# module-level __getattr__ below uses them. The shim defines every attribute
# as a real module global, so the maps can stay empty.
module_names = frozenset()
name_map = {}

already_imported = {}
qt_modules = {}


def __getattr__(name):
    return dynamic_load(name, name_map, already_imported, qt_modules, module_names)
