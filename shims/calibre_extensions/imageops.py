# imageops — pure-Python image filters backing calibre.utils.img's
# imageops.* wrappers, over Pillow (the qt shim's QImage wraps PIL images).
#
# load_from_data_without_gil returns False on purpose: that makes
# image_from_data() take its QImageReader-over-QBuffer fallback, which in
# the qt shim lands on Pillow — the same contract the C module's
# "could not load" branch has.
#
# Filter semantics follow stubs/calibre_extensions/imageops.pyi and the C
# module's documented behavior; approximations (oil_paint, ordered dither)
# are noted per function. All functions take/return qt-shim QImage objects.

have_qt = False

from PIL import Image, ImageFilter, ImageOps  # noqa: E402


def _pil(image):
    """Accept a qt-shim QImage (or a bare PIL image) -> PIL image."""
    return image.to_pil() if hasattr(image, 'to_pil') else image


def _rgb(p):
    """Filter-safe mode: PIL filters need L/RGB/RGBA."""
    return p if p.mode in ('L', 'RGB', 'RGBA') else p.convert('RGB')


def _flat_rgb(p):
    """Quantize-safe mode: PIL only quantizes RGBA with FASTOCTREE/
    libimagequant, so palette operations run on flattened RGB (alpha is
    dropped — callers in img.py blend alpha away before quantizing)."""
    return p.convert('RGB') if p.mode != 'RGB' else p


def _wrap(p):
    from qt.core import QImage
    return QImage.from_pil(p)


def load_from_data_without_gil(qimage, data):
    # Returning False makes image_from_data use its QImageReader fallback
    # (which in the qt shim lands on Pillow) — the same contract the C
    # module's "could not load" branch has.
    return False


def overlay(img, canvas, left, top):
    """Overlay `img` onto `canvas` at (left, top). img/canvas are
    Pillow-backed QImage instances from the qt shim."""
    base = canvas.to_pil()
    orig_mode = base.mode
    over = img.to_pil()
    if base.mode not in ('RGBA', 'RGB'):
        base = base.convert('RGBA')
    if over.mode not in ('RGBA', 'RGB'):
        over = over.convert('RGBA')
    base.paste(over, (int(left), int(top)), over if over.mode == 'RGBA' else None)
    from qt.core import QImage
    # Swap in the new pixels while PRESERVING the canvas object's identity:
    # _dpr, _color_table and (when the mode is unchanged) _fmt stay as they
    # were. An earlier version called canvas.__init__(), which reset _fmt to
    # Format_Invalid — a canvas with pixels but a format that downstream
    # convertToFormat/save paths reject.
    canvas._pil = base
    if canvas._fmt == QImage.Format_Invalid or base.mode != orig_mode:
        canvas._fmt = (QImage.Format_ARGB32
                       if base.mode in ('RGBA', 'LA', 'PA')
                       else QImage.Format_RGB32)
    return None


def set_image_allocation_limit(size_in_mb=1024):
    return None


def remove_borders(image, fuzz=10):
    """Crop away near-uniform borders: sample each edge's average color,
    then scan inward while sampled pixels stay within `fuzz` (max per-
    channel delta) of that edge's color. Returns the image unchanged when
    nothing qualifies as a border.

    Known divergence from the C module (imageops.cpp): the C metric sums
    squared per-channel deltas of each row/column against the FIRST row's
    average and compares to fuzz*255, which is much more permissive than
    this per-edge-average max-delta test. The only consumer of
    remove_borders is comic/input.py, and cbz/comic input is excluded from
    the wasm bundle (ParallelJob threads) — so this path is unreachable in
    production; the stricter metric is kept for API compatibility."""
    p = _pil(image)
    rgb = p.convert('RGB')
    w, h = rgb.size
    if w < 3 or h < 3:
        return _wrap(p)
    px = rgb.load()
    fuzz = int(max(0, fuzz))
    step_x = max(1, w // 50)
    step_y = max(1, h // 50)
    xs = list(range(0, w, step_x))
    ys = list(range(0, h, step_y))

    def avg(pts):
        n = len(pts)
        s = [0, 0, 0]
        for x, y in pts:
            c = px[x, y]
            s[0] += c[0]; s[1] += c[1]; s[2] += c[2]
        return (s[0] // n, s[1] // n, s[2] // n)

    refs = (avg([(x, 0) for x in xs]),        # top edge
            avg([(x, h - 1) for x in xs]),    # bottom edge
            avg([(0, y) for y in ys]),        # left edge
            avg([(w - 1, y) for y in ys]))    # right edge

    def near(c, ref):
        return max(abs(c[0] - ref[0]), abs(c[1] - ref[1]), abs(c[2] - ref[2])) <= fuzz

    top = 0
    while top < h - 1 and all(near(px[x, top], refs[0]) for x in xs):
        top += 1
    bottom = h
    while bottom - 1 > top and all(near(px[x, bottom - 1], refs[1]) for x in xs):
        bottom -= 1
    left = 0
    while left < w - 1 and all(near(px[left, y], refs[2]) for y in ys):
        left += 1
    right = w
    while right - 1 > left and all(near(px[right - 1, y], refs[3]) for y in ys):
        right -= 1
    if (left, top, right, bottom) == (0, 0, w, h):
        return _wrap(p)
    return _wrap(p.crop((left, top, right, bottom)))


def _qgray(rgb):
    """Qt's qGray weighting, exact: (r*11 + g*16 + b*5) // 32 — the C
    module grayscale()s via qGray, while PIL's convert('L') uses ITU-R
    luma (pure blue: qGray 39 vs luma 29) and convert() with a
    (11/32, 16/32, 5/32) matrix ROUNDS instead of truncating (blue -> 40).
    ImageMath.eval is not an option (removed in Pillow 12, which the
    engine bundle ships), so compute the C formula directly on the byte
    buffer. The O(pixels) Python loop is fine for the rare eink/device
    path this backs."""
    rgb = rgb if rgb.mode == 'RGB' else rgb.convert('RGB')
    data = rgb.tobytes()
    gray = bytes(((data[i] * 11 + data[i + 1] * 16 + data[i + 2] * 5) // 32)
                 for i in range(0, len(data), 3))
    return Image.frombytes('L', rgb.size, gray)


def grayscale(image):
    """Convert to grayscale with Qt's qGray weighting (matching the C
    module), keeping the alpha channel when present."""
    p = _pil(image)
    if p.mode in ('RGBA', 'LA', 'PA'):
        rgba = p.convert('RGBA')
        gray = _qgray(rgba.convert('RGB'))
        out = Image.merge('RGBA', (gray, gray, gray, rgba.split()[3]))
    elif p.mode == 'L':
        out = p.convert('RGB')
    else:
        gray = _qgray(_rgb(p))
        out = Image.merge('RGB', (gray, gray, gray))
    return _wrap(out)


def gaussian_sharpen(img, radius=0, sigma=0, high_quality=True):
    """Unsharp-mask approximation of the C Gaussian convolution kernel:
    Pillow's UnsharpMask(radius, percent) with percent derived from sigma."""
    p = _rgb(_pil(img))
    r = float(radius) if radius and float(radius) > 0 else 2.0
    percent = int(float(sigma) * 100) if sigma else 150
    percent = max(1, min(percent, 1000))
    return _wrap(p.filter(ImageFilter.UnsharpMask(radius=r, percent=percent, threshold=3)))


def gaussian_blur(img, radius=0, sigma=0):
    p = _rgb(_pil(img))
    r = float(radius) if radius and float(radius) > 0 else (float(sigma) if sigma else 2.0)
    return _wrap(p.filter(ImageFilter.GaussianBlur(radius=r)))


def despeckle(image):
    """Noise reduction — the C module's despeckle is a median filter."""
    return _wrap(_rgb(_pil(image)).filter(ImageFilter.MedianFilter(3)))


def normalize(image):
    """Stretch per-channel contrast (ImageOps.autocontrast over RGB,
    alpha preserved untouched)."""
    p = _pil(image)
    if p.mode in ('RGBA', 'LA', 'PA'):
        rgba = p.convert('RGBA')
        r, g, b, a = rgba.split()
        rgb = ImageOps.autocontrast(Image.merge('RGB', (r, g, b)))
        out = Image.merge('RGBA', (*rgb.split(), a))
    elif p.mode == 'L':
        out = ImageOps.autocontrast(p)
    else:
        out = ImageOps.autocontrast(_rgb(p))
    return _wrap(out)


def oil_paint(image, radius=-1, high_quality=True):
    """Coarse approximation of the oil-paint effect (the C module runs a
    Kuwahara-style filter): a max filter at the requested radius followed
    by a median smoothing pass."""
    p = _rgb(_pil(image))
    r = int(radius) if radius is not None and int(radius) > 0 else 1
    size = 2 * r + 1
    out = p.filter(ImageFilter.MaxFilter(size)).filter(ImageFilter.MedianFilter(3))
    return _wrap(out)


def dominant_color(image):
    """Most common color as a QColor (single-color median-cut quantize).

    Known divergence from the C module: the C dominant_color picks the most
    FREQUENT 32-level-quantized color with a saturation tie-break and a
    preference for vibrant colors; median-cut returns the mean color of the
    whole image instead. Consumers are gui2 (color themes) and
    metadata/sources — GUI/network code paths that never run in the wasm
    worker, so the approximation only has to not crash."""
    from qt.core import QColor
    p = _flat_rgb(_rgb(_pil(image)))
    q = p.quantize(colors=1, method=Image.Quantize.MEDIANCUT)
    pal = q.getpalette() or [0, 0, 0]
    return QColor(pal[0], pal[1], pal[2])


def quantize(image, maximum_colors=256, dither=True, palette=()):
    """Quantize to at most `maximum_colors` colors. A non-empty `palette`
    (sequence of QRgb ints, 0xAARRGGBB) pins the color table and, as in
    the C module, overrides maximum_colors. Returns an RGB QImage (the
    palette roundtrips through the encoders identically and avoids P-mode
    edge cases in downstream shim operations)."""
    p = _flat_rgb(_rgb(_pil(image)))
    dither_mode = Image.Dither.FLOYDSTEINBERG if dither else Image.Dither.NONE
    if palette:
        pal_img = Image.new('P', (1, 1))
        data = []
        for qrgb in palette:
            qrgb = int(qrgb) & 0xFFFFFFFF
            data += [(qrgb >> 16) & 0xFF, (qrgb >> 8) & 0xFF, qrgb & 0xFF]
        data += [0] * (768 - len(data))
        pal_img.putpalette(data)
        out = p.quantize(palette=pal_img, dither=dither_mode)
    else:
        colors = max(2, min(int(maximum_colors), 256))
        out = p.quantize(colors=colors, method=Image.Quantize.MEDIANCUT, dither=dither_mode)
    return _wrap(out.convert('RGB'))


def has_transparent_pixels(image):
    p = _pil(image)
    if p.mode in ('RGBA', 'LA', 'PA'):
        lo, _hi = p.convert('RGBA').split()[3].getextrema()
        return lo < 255
    if p.mode == 'P' and 'transparency' in p.info:
        return True
    return False


def set_opacity(image, alpha):
    """Copy of image with its alpha channel scaled by `alpha` (0.0-1.0)."""
    p = _pil(image).convert('RGBA')
    factor = max(0.0, min(1.0, float(alpha)))
    r, g, b, a = p.split()
    a = a.point(lambda v: int(v * factor))
    return _wrap(Image.merge('RGBA', (r, g, b, a)))


def texture_image(image, texturei):
    """Tile `texturei` across and down until it covers `image`'s bounds
    (the canvas image supplies only the size). The C texture_image memcpy-
    overwrites the canvas when the texture has no alpha, and premultiplied-
    blends otherwise — pasting each tile with the tile itself as the mask
    reproduces the blend (an earlier shim version dropped texture alpha and
    always overwrote)."""
    p = _pil(image)
    t = _pil(texturei)
    tw, th = t.size
    if tw <= 0 or th <= 0:
        return _wrap(p)
    has_alpha = t.mode in ('RGBA', 'LA', 'PA') or (
        t.mode == 'P' and 'transparency' in t.info)
    if has_alpha:
        t = t.convert('RGBA')
        out = p.copy() if p.mode == 'RGBA' else p.convert('RGBA')
        mask = t
    else:
        mode = p.mode if p.mode in ('RGB', 'RGBA') else 'RGB'
        t = t.convert(mode) if t.mode != mode else t
        out = Image.new(mode, p.size)
        mask = None
    for y in range(0, out.height, th):
        for x in range(0, out.width, tw):
            out.paste(t, (x, y), mask)
    return _wrap(out)


def ordered_dither(image):
    """eInk dither: reduce to 16 evenly spaced gray levels with dithering
    (Pillow error-diffusion over a 16-entry gray palette; falls back to
    plain level rounding), returning a Grayscale8 image — matching what
    eink_dither_image()'s callers expect from the C OrderedDither path."""
    p = _pil(image).convert('L')
    try:
        # 16 evenly spaced gray levels (0, 17, ... 255) as a P-mode palette
        pal_img = Image.new('P', (16, 1))
        pal_img.putpalette(bytes(range(0, 256, 17)) * 3)
        q = p.quantize(palette=pal_img, dither=Image.Dither.FLOYDSTEINBERG)
        out = q.convert('L')
    except Exception:
        # Deterministic fallback: nearest of the 16 levels (0, 17, ... 255).
        out = p.point(lambda v: min(255, (v // 17) * 17))
    return _wrap(out)
