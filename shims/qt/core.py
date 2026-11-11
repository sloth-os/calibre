# qt.core — Pillow-backed stand-in for the PyQt6 QtCore/QtGui surface the
# ebook conversion path uses. calibre.utils.img drives QImage/QBuffer/
# QImageReader/QImageWriter; calibre.ebooks.covers draws cover art with
# QPainter/QPainterPath/QFont. This module provides both classes faithfully
# enough for the operations those code paths perform, with QImage wrapping a
# PIL.Image.

import io
from PIL import Image as _PILImage
from PIL import ImageDraw as _PILDraw
from PIL import ImageFont as _PILFont

# Re-export the path/gradient/format classes living in qpath.py (kept in a
# sibling module for size; importable from qt.core like every other name).
from .qpath import (  # noqa: F401
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
        white = 1
        black = 2
        transparent = 3

    class AlignmentFlag:
        AlignLeft = 1
        AlignRight = 2
        AlignHCenter = 4
        AlignTop = 8
        AlignBottom = 16
        AlignVCenter = 32
        AlignCenter = 4 | 32

    class TextFlag:
        TextWordWrap = 0x100

    class PenStyle:
        NoPen = 0
        SolidLine = 1

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
    return (r << 24) | (g << 16) | (b << 8) | a


class QByteArray:
    def __init__(self, data=b''):
        self._data = bytes(data)

    def data(self):
        return self._data

    def __bytes__(self):
        return self._data


class QBuffer:
    def __init__(self, byte_array=None):
        self._ba = byte_array if byte_array is not None else QByteArray()
        self._buf = None
        self._mode = None

    def open(self, mode):
        self._buf = io.BytesIO()
        return True

    def close(self):
        if self._buf is not None:
            self._data = self._buf.getvalue()
            if isinstance(self._ba, QByteArray):
                self._ba.__init__(self._data)
            self._buf.close()
            self._buf = None

    def read(self, *a):
        return self._buf.read(*a) if self._buf else b''

    def write(self, data):
        return self._buf.write(data) if self._buf else 0

    def seek(self, pos, whence=0):
        return self._buf.seek(pos, whence)

    def tell(self):
        return self._buf.tell() if self._buf else 0


class QIODevice:
    class OpenModeFlag:
        ReadOnly = 1
        WriteOnly = 2
        ReadWrite = 3


class QColor:
    def __init__(self, *args):
        if len(args) == 1 and isinstance(args[0], str):
            c = args[0].lstrip('#')
            if len(c) == 3:
                c = ''.join(x * 2 for x in c)
            if len(c) in (6, 8):
                self._rgb = tuple(int(c[i:i + 2], 16) for i in (0, 2, 4))
                self._alpha = int(c[6:8], 16) if len(c) == 8 else 255
            else:
                self._rgb, self._alpha = (0, 0, 0), 255
        elif len(args) == 3:
            self._rgb, self._alpha = tuple(args), 255
        elif len(args) == 4:
            self._rgb, self._alpha = tuple(args[:3]), args[3]
        else:
            self._rgb, self._alpha = (0, 0, 0), 255

    def red(self): return self._rgb[0]
    def green(self): return self._rgb[1]
    def blue(self): return self._rgb[2]
    def alpha(self): return self._alpha

    def rgba(self):
        return (self._rgb[0], self._rgb[1], self._rgb[2], self._alpha)

    def isValid(self):
        # Qt: invalid when constructed from an unparseable name/empty.
 # This shim always holds concrete rgb values, so it is valid.
        return True

    def darker(self, factor=200):
        f = factor / 100 if factor >= 100 else factor
        if f > 1:  # Qt: factor>100 darkens (multiply by factor/100)
            return QColor(*(max(0, int(c * 100 / factor)) for c in self._rgb))
        return QColor(*(max(0, int(c * factor / 100)) for c in self._rgb))

    def lighter(self, factor=150):
        return QColor(*(min(255, int(c * factor / 100)) for c in self._rgb))

    def name(self):
        return '#{:02x}{:02x}{:02x}'.format(*self._rgb)


class QImage:
    """PIL-backed QImage. Only the operations the conversion path uses:
    constructors from data/size, scaled(), width/height, hasAlphaChannel(),
    convertToFormat-ish color handling via Pillow modes, and save/load
    through calibre.utils.img's image_to_data (which hands us bytes via
    QImageWriter below)."""

    class Format:
        # Nested enum (PyQt6 style: QImage.Format.Format_ARGB32).
        Format_Invalid = 0
        Format_RGB32 = 4
        Format_ARGB32 = 5
        Format_RGBA8888 = 17
        Format_Grayscale8 = 24

    # Flat aliases (PyQt5 style also used across calibre).
    Format_RGB32 = 4
    Format_ARGB32 = 5
    Format_RGBA8888 = 17
    Format_Grayscale8 = 24

    def __init__(self, *args):
        self._pil = None
        if len(args) == 0:
            return
        if len(args) == 2 and isinstance(args[0], int):
            w, h = args
            self._pil = _PILImage.new('RGBA', (w, h), (0, 0, 0, 0))
        elif len(args) == 3 and isinstance(args[0], int):
            w, h, fmt = args
            mode = 'RGB' if fmt == self.Format_RGB32 else 'RGBA'
            self._pil = _PILImage.new(mode, (w, h), (255, 255, 255, 0) if mode == 'RGB' else (0, 0, 0, 0))
        elif len(args) == 1 and isinstance(args[0], (_PILImage.Image,)):
            self._pil = args[0]

    @classmethod
    def from_pil(cls, pil):
        q = cls.__new__(cls)
        q._pil = pil
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
        return (self._pil.width, self._pil.height)

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
        p = self._require()
        resample = _PILImage.Resampling.LANCZOS if mode == Qt.TransformationMode.SmoothTransformation else _PILImage.Resampling.NEAREST
        if aspect in (Qt.AspectRatioMode.KeepAspectRatio, Qt.AspectRatioMode.KeepAspectRatioByExpanding):
            return QImage.from_pil(_scale_aspect(p, (w, h), aspect, resample))
        return QImage.from_pil(p.resize((int(w), int(h)), resample))

    def scaledToWidth(self, w, mode=Qt.TransformationMode.SmoothTransformation):
        p = self._require()
        resample = _PILImage.Resampling.LANCZOS if mode == Qt.TransformationMode.SmoothTransformation else _PILImage.Resampling.NEAREST
        h = max(1, round(p.height * w / p.width))
        return QImage.from_pil(p.resize((int(w), h), resample))

    def convertToFormat(self, fmt, flags=0):
        p = self._require()
        if fmt in (self.Format_Grayscale8,):
            return QImage.from_pil(p.convert('L'))
        if fmt == self.Format_RGB32:
            return QImage.from_pil(p.convert('RGB'))
        return QImage.from_pil(p.convert('RGBA'))

    def bits(self):
        import PIL.Image as I
        return self._require().tobytes()

    def setText(self, key, value):
        # Qt stores image metadata strings; the shim keeps them on the
        # object only (they never reach the serialized output).
        self._text = getattr(self, '_text', None) or {}
        self._text[key] = value

    def text(self, key):
        return (getattr(self, '_text', None) or {}).get(key, '')


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
    def __init__(self, device_or_path, fmt=None):
        self._buf = None
        self._path = None
        if isinstance(device_or_path, QBuffer):
            self._buf = device_or_path
        else:
            self._path = device_or_path

    def read(self):
        try:
            if self._buf is not None:
                data = self._buf.read() if self._buf._buf else getattr(self._buf._ba, '_data', b'')
                pil = _PILImage.open(io.BytesIO(data)).copy()
            else:
                pil = _PILImage.open(self._path).copy()
        except Exception:
            return QImage()
        return QImage.from_pil(pil)

    def format(self):
        if self._buf is not None:
            return b''
        try:
            return _PILImage.open(self._path).format.lower().encode('ascii')
        except Exception:
            return b''

    def canRead(self):
        return True

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

    def drawImage(self, x, y, image, *a):
        pil = image.to_pil()
        base = self._target.to_pil()
        if base.mode not in ('RGBA', 'RGB'):
            base = base.convert('RGBA')
        if pil.mode not in ('RGBA', 'RGB'):
            pil = pil.convert('RGBA')
        base.paste(pil, (int(x), int(y)), pil if pil.mode == 'RGBA' else None)
        self._target._pil = base
        self._draw = _PILDraw.Draw(base, 'RGBA')

    def fillRect(self, *args):
        rect, color = args if len(args) == 2 else (args[:4], args[4])
        if isinstance(rect, QRect):
            box = [rect.x(), rect.y(), rect.x() + rect.width(), rect.y() + rect.height()]
        else:
            x, y, w, h = rect
            box = [int(x), int(y), int(x + w), int(y + h)]
        # A QBrush wrapping a gradient: interpolate its stops down the
        # gradient axis (vertical for QLinearGradient from the cover style).
        inner = getattr(color, '_color', None)
        grad = getattr(inner, '_stops', None) if inner is not None else None
        if grad:
            self._fill_gradient(box, grad)
            return
        rgba = (color.red(), color.green(), color.blue(), getattr(color, '_alpha', 255))
        self._draw.rectangle(box, fill=rgba)

    def _fill_gradient(self, box, stops):
        """Vertical linear gradient fill (the only gradient the cover
        generator paints with): per-scanline lerp between the stops."""
        x0, y0, x1, y1 = box
        height = max(1, y1 - y0)
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

        for y in range(y0, y1):
            frac = (y - y0) / height
            self._draw.line([(x0, y), (x1, y)], fill=sample(frac))

    def drawText(self, *args):
        # (rect, flags, text) or (x, y, text)
        if len(args) == 3 and isinstance(args[0], (QRect, QRectF)):
            rect, flags, text = args
            x, y = rect.x(), rect.y() + self._font._size
            if flags & Qt.AlignmentFlag.AlignHCenter:
                x = rect.center().x()
            if flags & Qt.AlignmentFlag.AlignBottom:
                y = rect.y() + rect.height()
        else:
            x, y, text = args
        self._draw.text((int(x), int(y)), str(text), fill=self._pen._color.rgba(), font=self._font._load())

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
        self._draw.rectangle(
            [rect.x(), rect.y(), rect.x() + rect.width(), rect.y() + rect.height()],
            outline=self._pen._color.rgba(),
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
    def __init__(self, color=None, width=1, style=Qt.PenStyle.SolidLine):
        self._color = color if color is not None else QColor(0, 0, 0)
        self._width = width

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


class QBrush:
    def __init__(self, *a):
        self._color = a[0] if a and isinstance(a[0], (QColor, QLinearGradient, QRadialGradient)) else QColor(0, 0, 0)


def _as_rgba(c):
    if isinstance(c, QColor):
        return (c.red(), c.green(), c.blue(), getattr(c, '_alpha', 255))
    return (0, 0, 0, 255)


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
        self._wrap = QTextOption.WrapMode.WordWrap

    def setWrapMode(self, m):
        self._wrap = m

    def wrapMode(self):
        return self._wrap

    def setAlignment(self, a):
        self._alignment = a

    def alignment(self):
        return self._alignment


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
        box = f.getbbox(text or ' ') or (0, 0, 0, 0)
        ascent, descent = f.getmetrics()
        self._height = (box[3] - box[1]) or (ascent + descent)

    def isValid(self):
        return self._valid

    def setLineWidth(self, w):
        # The real wrap: split this line's text at the last word that fits
        # w, give the overflow back to the layout's pending pool.
        self._width = float(w)
        if not self._text or self._layout is None:
            return
        f = self._font._load()
        words = self._text.split(' ')
        keep, overflow = [], []
        for i, word in enumerate(words):
            candidate = ' '.join(keep + [word])
            box = f.getbbox(candidate or ' ') or (0, 0, 0, 0)
            if (box[2] - box[0]) > self._width and keep:
                overflow = words[i:]
                break
            keep.append(word)
        self._text = ' '.join(keep)
        if overflow and self._layout is not None:
            self._layout._pending = (' '.join(overflow) + ' ' + self._layout._pending).strip()

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
        painter._draw.text(
        (int(self._x + p.x()), int(self._y + p.y() + self._height * 0.8)),
            str(self._text),
            fill=painter._pen._color.rgba(),
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


class QPointF(QPoint):
    pass


class QSize:
    def __init__(self, w=0, h=0):
        self._w, self._h = w, h

    def width(self): return self._w
    def height(self): return self._h


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


class QTransform:
    def __init__(self, *a):
        pass


class QSvgRenderer:
    """Minimal SVG renderer over Pillow (which has no SVG support): renders
    to a blank image. calibre.ebooks.covers uses QSvgRenderer only for the
    default cover's decorative svg; a blank region there is acceptable, and
    rasterize.py (SVG->PNG in the pipeline) is guarded by try/except."""

    def __init__(self, *a):
        self._ok = False

    def isValid(self):
        return False

    def defaultSize(self):
        return QSize(0, 0)

    def render(self, *a, **k):
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
