# imageops — Qt image bridge used by calibre.utils.img. In the wasm build
# image_from_data() takes its fallback path (QImageReader over QBuffer,
# Pillow-backed in the qt shim), and overlay() is only used by
# blend_on_canvas for cover letterboxing — implemented here with PIL paste.

have_qt = False


def load_from_data_without_gil(qimage, data):
    # Returning False makes image_from_data use its QImageReader fallback
 # (which in the qt shim lands on Pillow) — the same contract the C
    # module's "could not load" branch has.
    return False


def overlay(img, canvas, left, top):
    """Overlay `img` onto `canvas` at (left, top). img/canvas are
 Pillow-backed QImage instances from the qt shim."""
    base = canvas.to_pil()
    over = img.to_pil()
    if base.mode not in ('RGBA', 'RGB'):
        base = base.convert('RGBA')
    if over.mode not in ('RGBA', 'RGB'):
        over = over.convert('RGBA')
    base.paste(over, (int(left), int(top)), over if over.mode == 'RGBA' else None)
    from qt.core import QImage
    canvas.__init__()
    new = QImage.from_pil(base)
    canvas._pil = new.to_pil()
    return None


def set_image_allocation_limit(size_in_mb=1024):
    return None
