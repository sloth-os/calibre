# tokenizer — tinycss C extension stand-in.
#
# tinycss/tokenizer.py calls token_data.load_c_tokenizer() at import; the C
# module's init() receives the compiled token tables. tinycss ships a
# pure-Python tokenizer (tokenize_flat) that its own tests keep in sync, and
# the import falls back to it when load_c_tokenizer raises RuntimeError. So
# this shim: init() raises RuntimeError (engaging the pure-Python tokenizer
# for stylesheet parsing) while parse_color_string/parse_css4_color_string
# provide the color parsing entry points color3.py/color4.py import.
#
# color3.py already has a pure-Python fallback but color4.py imports
# parse_css4_color_string unconditionally; this shim implements CSS Color 4
# parsing on top of color3's Python parser for the constructs the ebook
# pipeline feeds it (hex, named, rgb/rgba, hsl/hsla), and returns
# NotImplemented for the exotics (lab/oklab/...) so color4's callers see the
# same "unsupported color" outcome the C build gives for what it can't parse.

from tinycss.color3 import py_parse_color_string, parse_color_string, RGBA


def init(*args, **kwargs):
    # Engage tinycss's pure-Python tokenizer (see module docstring).
    raise RuntimeError('the wasm build uses the pure-Python tinycss tokenizer')


def _clamp01(x):
    return max(0.0, min(1.0, x))


def parse_color_string(css_string):
    # color3 path: same contract as the C function.
    ans = py_parse_color_string(css_string)
    return ans


def parse_css4_color_string(css_string):
    """CSS Color 4 subset: #rgb/#rgba/#rrggbb/#rrggbbaa, named colors,
    rgb()/rgba() with commas or spaces and optional /alpha (percent or
    number), hsl()/hsla() likewise. Returns RGBA tuple or NotImplemented."""
    if not isinstance(css_string, str):
        raise TypeError('parse_css4_color_string() argument must be a str')
    s = css_string.strip()
    if not s:
        return NotImplemented

    def rgba(r, g, b, a=1.0):
        return (r, g, b, a)

    # Hex (3/4/6/8 digits)
    if s.startswith('#'):
        h = s[1:]
        if len(h) in (3, 4, 6, 8) and all(c in '0123456789abcdefABCDEF' for c in h):
            if len(h) == 3:
                return rgba(int(h[0] * 2, 16) / 255, int(h[1] * 2, 16) / 255, int(h[2] * 2, 16) / 255)
            if len(h) == 4:
                return rgba(int(h[0] * 2, 16) / 255, int(h[1] * 2, 16) / 255, int(h[2] * 2, 16) / 255, int(h[3] * 2, 16) / 255)
            if len(h) == 6:
                return rgba(int(h[0:2], 16) / 255, int(h[2:4], 16) / 255, int(h[4:6], 16) / 255)
            return rgba(int(h[0:2], 16) / 255, int(h[2:4], 16) / 255, int(h[4:6], 16) / 255, int(h[6:8], 16) / 255)
        return NotImplemented

    # Named / functional
    import re
    m = re.match(r'^([a-zA-Z]+)\s*\((.*)\)$', s)
    if m is None:
        # named color: delegate to color3 (covers all CSS named colors)
        ans = py_parse_color_string(s)
        if isinstance(ans, RGBA):
            return tuple(ans)
        if isinstance(ans, str):  # e.g. 'currentColor'
            return ans
        return NotImplemented
    func, args = m.group(1).lower(), m.group(2).strip()

    def split_args(args):
        # comma or space separated, with optional /alpha
        alpha = None
        if '/' in args:
            args, _, alpha = args.partition('/')
            alpha = alpha.strip()
        parts = [p for p in re.split(r'[,\s]+', args.strip()) if p]
        return parts, alpha

    try:
        if func in ('rgb', 'rgba'):
            parts, alpha = split_args(args)
            if len(parts) != 3:
                return NotImplemented
            vals = []
            for p in parts:
                if p.endswith('%'):
                    vals.append(_clamp01(float(p[:-1]) / 100))
                else:
                    vals.append(_clamp01(float(p) / 255))
            a = 1.0
            if alpha is not None:
                a = _clamp01(float(alpha[:-1]) / 100 if alpha.endswith('%') else float(alpha))
            return rgba(vals[0], vals[1], vals[2], a)
        if func in ('hsl', 'hsla'):
            parts, alpha = split_args(args)
            if len(parts) != 3:
                return NotImplemented
            h, sat, lig = parts
            import colorsys
            hue = float(h.rstrip('deg'))
            sat = float(sat[:-1]) / 100 if sat.endswith('%') else float(sat)
            lig = float(lig[:-1]) / 100 if lig.endswith('%') else float(lig)
            r, g, b = colorsys.hls_to_rgb((hue % 360) / 360, _clamp01(lig), _clamp01(sat))
            a = 1.0
            if alpha is not None:
                a = _clamp01(float(alpha[:-1]) / 100 if alpha.endswith('%') else float(alpha))
            return rgba(r, g, b, a)
    except (ValueError, ZeroDivisionError):
        return NotImplemented

    return NotImplemented
