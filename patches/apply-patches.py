#!/usr/bin/env python3
"""Apply the wasm patches to a staged calibre source tree.

Usage: apply-patches.py <calibre-src-dir>

Each patch is a targeted, minimal edit that makes calibre's conversion engine
run under Pyodide, kept as small as possible so the engine keeps behaving
like desktop calibre everywhere else. Every patch is documented in place.

Patches:
  1. startup.py       skip `import resource` + rlimit work (no module in wasm)
  2. safe_atexit.py   atexit cleanup in-process (no subprocesses in wasm)
  3. utils/zipfile.py sequential extractall (no real threads in wasm)
"""
import sys
from pathlib import Path


def patch_file(path: Path, old: str, new: str) -> None:
    src = path.read_text(encoding='utf-8')
    if new in src:
        print(f'already patched {path.name}')
        return
    if old not in src:
        raise SystemExit(f'PATCH FAILED ({path.name}): block not found:\n{old[:200]}')
    path.write_text(src.replace(old, new, 1), encoding='utf-8')
    print(f'patched {path.name}')


def main() -> None:
    src = Path(sys.argv[1]).resolve()

    # ---1. startup.py: the resource module does not exist in pyodide ------
    patch_file(src / 'calibre' / 'startup.py', '''    else:
        import resource

        soft, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
        if soft < 1024:
            try:
                resource.setrlimit(resource.RLIMIT_NOFILE, (min(1024, hard), hard))
            except Exception:
                if DEBUG:
                    import traceback

                    traceback.print_exc()
''', '''    else:
        # wasm build: no resource module (pyodide) and rlimits do not exist
        # in a browser; sys.platform is 'emscripten' there.
        import sys as _sys
        if not _sys.platform.startswith('emscripten'):
            import resource

            soft, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
            if soft < 1024:
                try:
                    resource.setrlimit(resource.RLIMIT_NOFILE, (min(1024, hard), hard))
                except Exception:
                    if DEBUG:
                        import traceback

                        traceback.print_exc()
''')

    # ---2. safe_atexit.py: no subprocesses under wasm ---------------------
    patch_file(src / 'calibre' / 'utils' / 'safe_atexit.py', '''def _send_command(action: str, payload: str | list[str]) -> None:
    worker = ensure_worker()
''', '''def _send_command(action: str, payload: str | list[str]) -> None:
    if sys.platform.startswith('emscripten'):
        # wasm build: no subprocesses exist; register an ordinary atexit
        # callback (in-process cleanup instead of the crash-safe worker).
        import atexit as _atexit
        import shutil as _shutil

        def _cleanup(a=action, p=payload) -> None:
            try:
                if a == RMTREE_ACTION and isinstance(p, str):
                    _shutil.rmtree(p, ignore_errors=True)
                elif a == UNLINK_ACTION and isinstance(p, str):
                    unlink(p)
            except Exception:
                pass

        _atexit.register(_cleanup)
        return
    worker = ensure_worker()
''')

    # ---3. utils/zipfile.py: no real threads under pyodide ----------------
    patch_file(src / 'calibre' / 'utils' / 'zipfile.py', '''        with ThreadPoolExecutor(max_workers=12, thread_name_prefix='ZipFile-') as e:
            tuple(e.map(do_one, args))
''', '''        if sys.platform.startswith('emscripten'):
            # wasm build: no real threads; extract sequentially.
            for a in args:
                do_one(a)
        else:
            with ThreadPoolExecutor(max_workers=12, thread_name_prefix='ZipFile-') as e:
                tuple(e.map(do_one, args))
''')

    print('all patches applied')


if __name__ == '__main__':
    main()
