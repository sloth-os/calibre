# cPalmdoc — Palmdoc compression, ported from calibre/ebooks/compression/palmdoc.py.
# calibre ships a pure-Python compressor (py_compress_doc) that its own tests
# prove byte-identical to the C one; decompression is a small LZ77 decoder
# transcribed from the C algorithm (compress.c semantics).

import io
from struct import pack


def compress(data: bytes) -> bytes:
    if not data:
        return b''
    return py_compress_doc(data)


def py_compress_doc(data: bytes) -> bytes:
    out = io.BytesIO()
    i = 0
    ldata = len(data)
    while i < ldata:
        if i > 10 and (ldata - i) > 10:
            chunk = b''
            match = -1
            for j in range(10, 2, -1):
                chunk = data[i : i + j]
                try:
                    match = data.rindex(chunk, 0, i)
                except ValueError:
                    continue
                if (i - match) <= 2047:
                    break
                match = -1
            if match >= 0:
                n = len(chunk)
                m = i - match
                code = 0x8000 + ((m << 3) & 0x3FF8) + (n - 3)
                out.write(pack('>H', code))
                i += n
                continue
        ch = data[i : i + 1]
        och = ch[0] if isinstance(ch, bytes) else ord(ch)
        i += 1
        if ch == b' ' and i < ldata:
            onch = data[i : i + 1][0]
            if 0x40 <= onch < 0x80:
                out.write(pack('>B', onch ^ 0x80))
                i += 1
                continue
        if och == 0 or (8 < och < 0x80):
            out.write(ch)
        else:
            j = i
            binseq = [ch]
            while j < ldata and len(binseq) < 8:
                ch = data[j : j + 1]
                och = ch[0]
                if och == 0 or (8 < och < 0x80):
                    break
                binseq.append(ch)
                j += 1
            out.write(pack('>B', len(binseq)))
            out.write(b''.join(binseq))
            i += len(binseq) - 1
    return out.getvalue()


def decompress(data: bytes) -> bytes:
    out = io.BytesIO()
    i = 0
    ldata = len(data)
    while i < ldata:
        c = data[i]
        i += 1
        if c == 0:
            out.write(b'\x00')
        elif 1 <= c <= 8:
            out.write(data[i : i + c])
            i += c
        elif 9 <= c < 0x80:
            out.write(bytes((c,)))
        elif 0x80 <= c <= 0xBF:
            if i >= ldata:
                break
            c2 = data[i]
            i += 1
            pair = ((c << 8) | c2) & 0xFFFF
            delta = (pair >> 3) & 0x7FF
            length = (pair & 0x7) + 3
            pos = out.tell()
            if delta == 0 or delta > pos:
                # invalid backreference: emit literally
                out.write(bytes((c,)))
            else:
                # overlapping copy, byte by byte (length may exceed delta)
                cur = out.tell()
                buf = out.getvalue()
                for k in range(length):
                    out.write(buf[cur - delta + k : cur - delta + k + 1])
        elif 0xC0 <= c <= 0xFF:
            out.write(b' ')
            out.write(bytes((c ^ 0x80,)))
    return out.getvalue()
