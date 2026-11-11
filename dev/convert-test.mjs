// Conversion test: run real ebook conversions under Pyodide (TXT->EPUB,
// then EPUB->AZW3 and EPUB->MOBI) through calibre's plumber, exactly as the
// production worker will.

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, 'noop.js'));
const { loadPyodide } = require(path.join(here, 'pyodide', 'pyodide', 'pyodide.js'));

const STAGE = path.join(here, 'stage');

const py = await loadPyodide();

// ---- unpack wheels ----
const wheelsDir = path.join(here, 'vendor', 'wheels');
const wheelExtract = path.join(here, 'vendor', 'extracted');
fs.rmSync(wheelExtract, { recursive: true, force: true });
fs.mkdirSync(wheelExtract, { recursive: true });
for (const whl of fs.readdirSync(wheelsDir)) {
  fs.mkdirSync(path.join(wheelExtract, '.tmp'), { recursive: true });
  execSyncExtract(whl);
}
function execSyncExtract(whl) {
  const { execSync } = require('node:child_process');
  execSync(`cd ${wheelExtract} && python3 -c "
import zipfile
zipfile.ZipFile('${path.join(wheelsDir, whl)}').extractall('.')
"`);
}
console.log('wheels unpacked');

function syncDir(localDir, remoteDir) {
  py.FS.mkdirTree(remoteDir);
  for (const e of fs.readdirSync(localDir, { withFileTypes: true })) {
    const lp = path.join(localDir, e.name);
 const rp = remoteDir + '/' + e.name;
    if (e.isDirectory()) syncDir(lp, rp);
    else if (e.isFile()) py.FS.writeFile(rp, new Uint8Array(fs.readFileSync(lp)));
  }
}
syncDir(wheelExtract, '/site/vendor');
syncDir(path.join(STAGE, 'calibre_shims'), '/site/shims');
syncDir(path.join(STAGE, 'calibre-src'), '/site/calibre-src');
syncDir(path.join(STAGE, 'resources'), '/site/resources');
console.log('staged');

const CONVERT = String.raw`
import os, sys, time, traceback

for p in ('/site/calibre-src', '/site/shims', '/site/vendor'):
    sys.path.insert(0, p)

sys.resources_location = '/site/resources'
sys.extensions_location = '/site/calibre-src/calibre/plugins'
os.environ['CALIBRE_CONFIG_DIRECTORY'] = '/home/calibre-config'
os.makedirs('/home/calibre-config', exist_ok=True)

# Silence the umask warning from constants.py? (it prints once)
print('[boot] importing plumber...', flush=True)
from calibre.ebooks.conversion.plumber import Plumber
print('[boot] plumber imported', flush=True)

def convert(input_path, output_path, t0label):
    from calibre.utils.logging import Log
    log = Log(level=Log.WARN)
    log.print = lambda *a, **k: print('[calibre]', *a, **k)
    t0 = time.time()
    plumber = Plumber(input_path, output_path, log=log)
    plumber.run()
    dt = time.time() - t0
    size = os.path.getsize(output_path)
    print(f'[convert] {t0label}: OK in {dt:.1f}s, output {size} bytes', flush=True)
    return size

# ---- Test 1: TXT -> EPUB ----
with open('/work/in.txt', 'w', encoding='utf-8') as f:
    f.write('Chapter One\n\nThe quick brown fox jumps over the lazy dog. ' * 200)
    f.write('\n\nChapter Two\n\nIt was the best of times, it was the worst of times. ' * 200)

convert('/work/in.txt', '/work/out.epub', 'TXT->EPUB')

# verify the epub is a valid zip with the right content
from zipfile import ZipFile
with ZipFile('/work/out.epub') as zf:
    names = zf.namelist()
    print('[verify] epub entries:', len(names), 'first:', names[:4], flush=True)
    assert 'mimetype' in names, 'mimetype missing'
    assert any('content' in n for n in names), 'no content file'

# ---- Test 2: EPUB -> AZW3 ----
convert('/work/out.epub', '/work/out.azw3', 'EPUB->AZW3')
with open('/work/out.azw3', 'rb') as f:
    head = f.read(68)
# MOBI-family files: 'BOOKMOBI' at offset 60 (after the PDB header).
print('[verify] azw3 magic@60:', head[60:68])
assert head[60:68] == b'BOOKMOBI', f'unexpected azw3 magic {head[60:68]!r}'

# ---- Test 3: EPUB -> MOBI ----
convert('/work/out.epub', '/work/out.mobi', 'EPUB->MOBI')
with open('/work/out.mobi', 'rb') as f:
    head = f.read(68)
print('[verify] mobi magic@60:', head[60:68])
assert head[60:68] == b'BOOKMOBI', f'unexpected mobi magic {head[60:68]!r}'

# ---- Test 4: TXT -> MOBI (covers the rescale_image/save_cover_data_to path) ----
convert('/work/in.txt', '/work/out2.mobi', 'TXT->MOBI')

print('ALL CONVERSION TESTS PASSED', flush=True)
`;

py.FS.mkdirTree('/work');
py.FS.mkdirTree('/home/calibre-config');
try {
  py.runPython(CONVERT);
  console.log('CONVERT TEST PASSED');
} catch (e) {
  console.error('CONVERT FAILED:');
 console.error(String(e).slice(0, 6000));
  process.exitCode = 1;
}
