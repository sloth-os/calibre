# qt — stub of calibre's PyQt6 loader for the wasm build.
#
# In the browser there is no Qt. The modules that import qt.core at module
# level and sit on the conversion path (calibre.utils.img, calibre.ebooks.covers)
# get a tiny emulation layer instead: qt.core exists and exports names that
# stand for the handful of classes those modules actually use, implemented
# over Pillow. qt.webengine imports fail loudly (PDF output is disabled in
# the wasm build anyway — its writer needs a real WebEngine).
