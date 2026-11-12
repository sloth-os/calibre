# QPainterPath / gradients / QTextCharFormat — the remaining Qt classes
# calibre.ebooks.covers imports.
#
# QPainterPath: the default cover template builds decorative vector shapes
# (stylized mountains, fold lines) and paints them with drawPath/fillPath.
# This shim RECORDS the path commands but paints nothing — the generated
# cover keeps its solid background and text (title/author/series) and loses
# only the decorative vector art. A faithful vector rasterizer over Pillow
# is not practical; text-correct covers are what matter for conversion.
#
# Gradients: recorded, applied as their base color.

class QPainterPath:
    class FillRule:
        OddEvenFill = 0
        WindingFill = 1

    def __init__(self, *args):
        self._ops = []
        self._fill_rule = QPainterPath.FillRule.OddEvenFill
        # Current pen position — Qt tracks it through EVERY command, and
        # calibre's cover styles chain relative ops off it
        # (p.lineTo(p.currentPosition() + QPointF(dx, dy))).
        self._cx = self._cy = 0.0
        self._sx = self._sy = 0.0   # start of the current subpath

    @staticmethod
    def _points(a):
        """Normalize (QPointF, ...) or (x1, y1, ...) args to point tuples."""
        pts = []
        i = 0
        while i < len(a):
            v = a[i]
            if hasattr(v, 'x'):
                pts.append((float(v.x()), float(v.y())))
                i += 1
            elif i + 1 < len(a):
                pts.append((float(a[i]), float(a[i + 1])))
                i += 2
            else:
                break
        return pts

    def moveTo(self, *a):
        self._ops.append(('moveTo', a))
        pts = self._points(a)
        if pts:
            self._cx, self._cy = pts[0]
            self._sx, self._sy = pts[0]

    def lineTo(self, *a):
        self._ops.append(('lineTo', a))
        pts = self._points(a)
        if pts:
            self._cx, self._cy = pts[-1]

    def quadTo(self, *a):
        self._ops.append(('quadTo', a))
        pts = self._points(a)
        if len(pts) >= 2:
            self._cx, self._cy = pts[-1]   # endpoint is the last control pair

    def cubicTo(self, *a):
        self._ops.append(('cubicTo', a))
        pts = self._points(a)
        if len(pts) >= 3:
            self._cx, self._cy = pts[-1]   # c3 endpoint

    def arcTo(self, *a):
        self._ops.append(('arcTo', a))
        # Qt puts the pen at the arc's end angle on the ellipse; paths are
        # never painted here, so approximating with the bounding rect keeps
        # chained relative commands continuous.
        pts = self._points(a[:1]) if a and hasattr(a[0], 'x') else []
        if pts and len(a) >= 3:
            rect = a[0]
            self._cx = float(rect.x()) + float(rect.width())
            self._cy = float(rect.y()) + float(rect.height())

    def closeSubpath(self):
        self._ops.append(('close', ()))
        self._cx, self._cy = self._sx, self._sy

    def addEllipse(self, *a):
        self._ops.append(('ellipse', a))

    def addRect(self, *a):
        self._ops.append(('rect', a))

    def addRoundedRect(self, *a, **kw):
        self._ops.append(('rounded_rect', a))

    def addPolygon(self, *a):
        self._ops.append(('polygon', a))
        pts = self._points(a[:1]) if a and hasattr(a[0], 'x') else []
        # QPolygon is a list of points — track its last vertex
        if a and isinstance(a[0], (list, tuple)) and a[0]:
            try:
                last = a[0][-1]
                if hasattr(last, 'x'):
                    self._cx, self._cy = float(last.x()), float(last.y())
            except Exception:
                pass

    def addText(self, *a):
        self._ops.append(('text', a))

    def setFillRule(self, r):
        self._fill_rule = r

    def fillRule(self):
        return self._fill_rule

    def isEmpty(self):
        return not self._ops

    def currentPosition(self):
        from .core import QPointF
        # A COPY — caller arithmetic (currentPosition() + QPointF(...)) must
        # not be able to mutate path state.
        return QPointF(self._cx, self._cy)

    def boundingRect(self):
        from .core import QRectF
        xs, ys = [], []
        for op, a in self._ops:
            for x, y in self._points(a):
                xs.append(x)
                ys.append(y)
        if not xs:
            return QRectF(0, 0, 0, 0)
        return QRectF(min(xs), min(ys), max(xs) - min(xs), max(ys) - min(ys))

    def translated(self, *a):
        return QPainterPath()

    def simplified(self):
        return self

    def toFillPolygon(self, *a):
        return []

    def toSubpathPolygons(self, *a):
        return []


class QGradient:
    class Spread:
        PadSpread = 0
        ReflectSpread = 1
        RepeatSpread = 2

    class CoordinateMode:
        LogicalMode = 0

    def __init__(self):
        self._stops = []

    def setColorAt(self, pos, color):
        self._stops.append((pos, color))

    def setStops(self, stops):
        self._stops = list(stops)

    def setSpread(self, s):
        pass

    def setCoordinateMode(self, m):
        pass


class QLinearGradient(QGradient):
    def __init__(self, *args):
        super().__init__()
        self._start = args[0:2] if len(args) >= 2 else (0, 0)
        self._final = args[2:4] if len(args) >= 4 else (0, 0)

    def setStart(self, *a):
        pass

    def setFinalStop(self, *a):
        pass

    def start(self):
        from .core import QPointF
        return QPointF(*self._start)


class QRadialGradient(QGradient):
    def __init__(self, *args):
        super().__init__()
        self._center = args[0] if args else (0, 0)
        self._radius = args[1] if len(args) > 1 else 0

    def setCenter(self, *a):
        pass

    def setRadius(self, r):
        pass


class QTextCharFormat:
    class FontPropertiesSpecified:
        NothingSpecified = 0

    def __init__(self):
        self._props = {}

    def setFontWeight(self, w):
        self._props['weight'] = w

    def setFontItalic(self, b):
        self._props['italic'] = b

    def setFontWordSpacing(self, v):
        self._props['word_spacing'] = v

    def setFontLetterSpacing(self, t, v=None):
        if v is None:
            self._props['letter_spacing'] = t
        else:
            self._props['letter_spacing'] = v

    def setFontUnderline(self, b):
        self._props['underline'] = b

    def setForeground(self, brush):
        self._props['foreground'] = brush
