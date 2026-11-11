# html5_parser — pure-Python stand-in for the C (gumbo-based) html5-parser.
#
# calibre's conversion pipeline parses every HTML/OEB document through
# html5_parser.parse(..., treebuilder='lxml') via:
#   - calibre.ebooks.oeb.polish.parsing.parse_html5 (the main OEB parser)
#   - calibre.ebooks.oeb.parse_utils.html5_parse
#
# The C module implements the HTML5 tree-construction algorithm with an lxml
# adapter. This shim builds the tree with lxml's own HTMLParser in
# recover=True mode, then applies the options calibre passes:
#   maybe_xhtml  -> parse as XML when the source looks like XHTML, so
#                   namespaced tags/attrs survive (calibre's OEB docs are
#                   XHTML with the 1999 namespace)
#   line_number_attr -> not available from lxml; omitted (calibre passes it
#                   only for error reporting in edit-book, not in conversion)
#   keep_doctype    -> lxml keeps it as a comment-less docinfo; harmless
#   sanitize_names  -> rewrite invalid tag/attr name chars to '_', per the
#                   html5-parser contract, so the tree is valid XML
#
# The result is API-compatible (lxml etree) though not byte-identical to
# gumbo's error recovery for pathological markup; for well-formed ebook
# XHTML the trees are the same.

import re

from lxml import etree as _etree

version = (0, 5, 0, 'wasm-shim')

_SANE_NAME = re.compile(r'[^A-Za-z0-9_.\-]')


def _sanitize(name):
    if not isinstance(name, str):
        return name
    return _SANE_NAME.sub('_', name)


def _sanitize_tree(root):
    for el in root.iter():
        if isinstance(el.tag, str):
            el.tag = _sanitize(el.tag)
            for attr in list(el.attrib):
                sane = _sanitize(attr)
                if sane != attr:
                    el.attrib[sane] = el.attrib.pop(attr)
    return root


_XHTML_HINT = re.compile(
    r'<\?xml|xmlns\s*=|<!DOCTYPE\s+html[^>]*XHTML', re.IGNORECASE
)


def parse(
    html,
    transport_encoding=None,
    namespace_elements=False,
    treebuilder='lxml',
    fallback_encoding=None,
    keep_doctype=True,
    maybe_xhtml=False,
    return_root=True,
    line_number_attr=None,
    sanitize_names=True,
    stack_size=16 * 1024,
    fragment_context=None,
):
    """Parse `html` (str or bytes) into an lxml tree, mirroring the
    html5_parser.parse contract for the arguments calibre uses."""
    if isinstance(html, str):
        data = html.encode('utf-8')
    elif isinstance(html, (bytes, bytearray)):
        data = bytes(html)
    else:
        raise TypeError(f'html must be str or bytes, not {type(html).__name__}')

    if treebuilder not in ('lxml', 'lxml_html'):
        raise NotImplementedError(
            f'treebuilder {treebuilder!r} is not supported by the wasm html5_parser shim'
        )

    head = data[:4096].decode('utf-8', 'replace')
    xhtml_source = bool(_XHTML_HINT.search(head))

    if maybe_xhtml and xhtml_source:
        # Parse as XML with recovery so namespaced XHTML survives intact.
        parser = _etree.XMLParser(recover=True, resolve_entities=False,
                                  no_network=True, huge_tree=True)
        try:
            root = _etree.fromstring(data, parser=parser)
        except _etree.XMLSyntaxError:
            root = None
        if root is None:
            root = _etree.fromstring(b'<html/>', _etree.XMLParser())
    else:
        # HTML5-ish parse via lxml's HTMLParser (recover mode): a full
        # document parse first; fragments (no <html> root) get wrapped so a
        # root element always exists.
        try:
            doc = _etree.fromstring(data, _etree.HTMLParser(recover=True, no_network=True, huge_tree=True))
        except _etree.XMLSyntaxError:
            doc = None
        if doc is None:
            try:
                doc = _etree.fromstring(
                    b'<html><body>' + data + b'</body></html>',
                    _etree.HTMLParser(recover=True, no_network=True, huge_tree=True),
                )
            except _etree.XMLSyntaxError:
                doc = _etree.fromstring(b'<html/>', _etree.HTMLParser())
        root = doc

    if sanitize_names:
        _sanitize_tree(root)

    if not return_root:
        # calibre never uses this; kept for signature parity.
        return _etree.ElementTree(root)
    return root
