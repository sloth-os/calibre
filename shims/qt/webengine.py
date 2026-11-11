# qt.webengine — deliberately raises on import: the wasm build has no
# QtWebEngine, so PDF output (which renders HTML via WebEngine) is reported
# as unsupported by the app rather than crashing the pipeline.

raise ImportError(
    'qt.webengine is not available in the calibre wasm build '
    '(PDF output requires QtWebEngine)'
)
