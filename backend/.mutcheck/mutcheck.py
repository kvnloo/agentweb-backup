#!/usr/bin/env python3
"""
Mutation check that cannot silently pass.

Every failure mode I hit by hand is now an error instead of a green tick:
  * anchor not found, or found more than once  -> refuses to run
  * replacement identical to the anchor        -> refuses to run
  * file unchanged after the write             -> refuses to run
  * suite already failing before the mutation  -> refuses to run (can't attribute)
  * suite still passing after the mutation     -> reports VACUOUS, loudly
The file is always restored, including on exception.

  mutcheck.py <file> <suite-pattern> <<'SPEC'
  --- ANCHOR
  ...exact source text...
  --- REPLACEMENT
  ...text to put in its place...
  SPEC
"""
import subprocess, sys, shutil, pathlib, re

def run_suite(pattern):
    r = subprocess.run(
        ['npx', 'jest', pattern, '--silent'],
        capture_output=True, text=True, cwd=str(pathlib.Path(__file__).resolve().parents[1]),
        env={**__import__('os').environ, 'NODE_OPTIONS': '--max-old-space-size=6144'},
    )
    out = r.stdout + r.stderr
    line = next((l.strip() for l in out.splitlines() if l.strip().startswith('Tests:')), '(no summary)')
    # A mutation that breaks COMPILATION is not evidence that the test binds — it proves
    # only that the file stopped building. Jest still prints a `Tests:` line in that case,
    # so a naive `'failed' in out` reports BINDS for a broken edit.
    broke_build = 'Test suite failed to run' in out
    # Count real assertion failures, not the word "failed" anywhere in the output.
    m = re.search(r'Tests:.*?(\d+) failed', line)
    failed = bool(m) and int(m.group(1)) > 0
    return failed, line, broke_build

def main():
    path, pattern = sys.argv[1], sys.argv[2]
    spec = sys.stdin.read()
    if '--- ANCHOR' not in spec or '--- REPLACEMENT' not in spec:
        sys.exit('spec needs --- ANCHOR and --- REPLACEMENT sections')
    anchor = spec.split('--- ANCHOR', 1)[1].split('--- REPLACEMENT', 1)[0].strip('\n')
    repl = spec.split('--- REPLACEMENT', 1)[1].strip('\n')

    p = pathlib.Path(path)
    src = p.read_text()
    n = src.count(anchor)
    if n != 1:
        sys.exit(f'REFUSING: anchor matched {n} times in {path} (need exactly 1). '
                 f'This is the silent no-op that makes a mutation check prove nothing.')
    if anchor == repl:
        sys.exit('REFUSING: replacement is identical to the anchor.')

    before_failed, before_line, before_broke = run_suite(pattern)
    if before_broke:
        sys.exit('REFUSING: suite does not build before the mutation.')
    if before_failed:
        sys.exit(f'REFUSING: suite is already failing before the mutation — {before_line}')

    backup = p.with_suffix(p.suffix + '.mutcheck.bak')
    shutil.copy2(p, backup)
    try:
        mutated = src.replace(anchor, repl, 1)
        if mutated == src:
            sys.exit('REFUSING: file unchanged after replace.')
        p.write_text(mutated)
        after_failed, after_line, after_broke = run_suite(pattern)
        print(f'  before : {before_line}')
        print(f'  after  : {after_line}')
        if after_broke:
            print('  verdict: INVALID — the mutation broke the build, which proves nothing '
                  'about the test. Use a semantically valid replacement.')
            return 3
        verdict = 'BINDS' if after_failed else '*** VACUOUS — the suite passes without the code ***'
        print(f'  verdict: {verdict}')
        return 0 if after_failed else 2
    finally:
        shutil.copy2(backup, p)
        backup.unlink()

if __name__ == '__main__':
    sys.exit(main())
