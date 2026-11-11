# compression — kovidgoyal's compression-codec facade package. calibre
# imports zlib/bz2 from it (`from compression import zlib`).
#
# The package is not on PyPI and not in the calibre source tree — it is
# vendored on build hosts (see calibre commit 301e3e0cb15 "use the new
# compression package to import compression codecs from"). The shim aliases
# it to the standard library codecs, whose API the package mirrors by
# design. Nothing in the ebook conversion path uses the package's
# non-stdlib extras.

import bz2 as _bz2
import lzma as _lzma
import zlib as _zlib

zlib = _zlib
bz2 = _bz2
lzma = _lzma

__all__ = ['zlib', 'bz2', 'lzma']
