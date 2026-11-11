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

    def moveTo(self, *a):
        self._ops.append(('moveTo', a))
        if a and hasattr(a[0], 'x'):
            self._cx, self._cy = float(a[0].x()), float(a[0].y())
        elif len(a) >= 2:
            self._cx, self._cy = float(a[0]), float(a[1])

    def lineTo(self, *a):
        self._ops.append(('lineTo', a))

    def quadTo(self, *a):
        self._ops.append(('quadTo', a))

    def cubicTo(self, *a):
        self._ops.append(('cubicTo', a))

    def arcTo(self, *a):
        self._ops.append(('arcTo', a))

    def closeSubpath(self):
        self._ops.append(('close', ()))

    def addEllipse(self, *a):
        self._ops.append(('ellipse', a))

    def addRect(self, *a):
        self._ops.append(('rect', a))

    def addRoundedRect(self, *a, **kw):
        self._ops.append(('rounded_rect', a))

    def addPolygon(self, *a):
        self._ops.append(('polygon', a))

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
        # The corner-art path tracking is decorative; a fixed origin keeps
        # draw_curved_line's relative math consistent (no drawing depends
        # on it — paths are not painted).
        return QPointF(getattr(self, '_cx', 0.0), getattr(self, '_cy', 0.0))

    def boundingRect(self):
        from .core import QRectF
        return QRectF(0, 0, 0, 0)

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
