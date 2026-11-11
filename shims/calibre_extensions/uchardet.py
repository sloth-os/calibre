# uchardet — encoding detection. calibre.ebooks.chardet.detect() uses this to
# sniff the encoding of HTML/text inputs. The pure-Python chardet package
# (vendored as a wheel) is used underneath; chardet covers every encoding
# uchardet does for the ebook corpus, and calibre already treats a miss as
# 'confidence 0' + utf-8 fallback.

def detect(bytestring):
    import chardet
    result = chardet.detect(bytestring)
    encoding = (result.get('encoding') or '').lower() or None
    # uchardet returns '' for unknown; chardet returns None — normalize to ''
    # so .lower() in calibre's wrapper stays happy.
    return encoding or ''
