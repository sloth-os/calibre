# progress_indicator — no-op shim for the C extension calibre.utils.img
# imports on EVERY image decode (set_image_allocation_limit guards QImage's
# allocation ceiling on desktop). In the wasm build there is no QImage
# allocator to cap: images decode through Pillow, whose own
# DecompressionBombGuard (default pixel cap) is the live guard, and the
# whole worker heap is bounded besides.
#
# The GUI half of the real extension (ProgressIndicator widget, icon/theme
# helpers) lives behind calibre.gui2 — which is shadowed wholesale by the
# shim gui2 module — so none of those names are reachable headless. They
# are deliberately absent: an ImportError names the missing symbol loudly,
# exactly like a desktop calibre with a broken extension install.


def set_image_allocation_limit(size_in_mb: int = 1024) -> None:
    """No-op: Pillow's decompression-bomb guard applies instead."""
    return None


class ProgressIndicator:
    """GUI-only on desktop; never constructed on the conversion path."""

    def __init__(self, *args, **kwargs):
        raise NotImplementedError(
            'ProgressIndicator is a GUI widget and is not available in the wasm build')
