# calibre_extensions — pure-Python shims for calibre's C extensions.
#
# calibre.constants appends an ExtensionsImporter to sys.meta_path that
# resolves `calibre_extensions.<name>` against .so files in
# sys.extensions_location. In the wasm build there are no .so files, so this
# package is placed on sys.path (via the bundle bootstrap) BEFORE calibre is
# imported: the standard path finder answers `calibre_extensions.<name>`
# from here before the appended importer is ever consulted.
#
# The shim surface is deliberately minimal: only what the ebook conversion
# pipeline touches. An extension calibre tries to import that has no shim
# here fails with a plain ImportError — exactly what happens on desktop
# calibre when an extension file is missing — so calibre's own fallbacks
# (try/except ImportError) engage. Extensions whose loss breaks a format
# (lzx/msdes for LIT, bzzdec for DJVU) simply make that format unavailable,
# which the app reports per-format.
#
# Shimmed here:
#   speedup      barename/namespace/clean_xml_chars/parse_date/parse_iso8601/O_CLOEXEC
#   icu          collation + case mapping + chr
#   tokenizer    CSS color parsing (color3+color4 subset)
#   fast_html_entities  HTML entity replacement
#   cPalmdoc     Palmdoc compression (PDB/DOC)
#   translator   gettext .mo catalogs
#   imageops     keeps calibre.utils.img importable; bridges to Pillow paths
#   uchardet     encoding detection (via chardet)
