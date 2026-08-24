// Tests for the @-mention file/folder search (chat/at-files.mjs). Builds a throwaway git repo with a
// gitignored dir and an untracked file, then exercises listing, ranking, filtering, caps and confinement.
// Run: node test/at-files.test.mjs
import { searchWorktreeFiles, listWorktreeEntries } from '../chat/at-files.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(os.tmpdir(), 'atfiles-'));
const git = (args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
git(['init', '-q']);
git(['config', 'user.email', 't@t']);
git(['config', 'user.name', 't']);
git(['config', 'commit.gpgsign', 'false']);
mkdirSync(path.join(dir, 'src', 'api'), { recursive: true });
writeFileSync(path.join(dir, 'src', 'server.ts'), 'x');
writeFileSync(path.join(dir, 'src', 'api', 'routes.ts'), 'x');
writeFileSync(path.join(dir, 'README.md'), 'x');
writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n');
mkdirSync(path.join(dir, 'node_modules', 'pkg'), { recursive: true });
writeFileSync(path.join(dir, 'node_modules', 'pkg', 'index.js'), 'x');
git(['add', '-A']);
git(['commit', '-qm', 'init']);
writeFileSync(path.join(dir, 'src', 'fresh.ts'), 'x'); // untracked, non-ignored → should still appear

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✅ ${m}`); } else { fail++; console.log(`  ❌ ${m}`); } };
const paths = (arr) => arr.map((e) => e.path);
const opt = { cache: false };

console.log('at-files.mjs — @-mention file/folder search');

const all = listWorktreeEntries(dir, opt);
ok(!paths(all).some((p) => p.startsWith('node_modules')), 'node_modules (gitignored) is excluded');
ok(all.some((e) => e.path === 'src' && e.type === 'dir'), 'derives the src/ folder as a dir');
ok(all.some((e) => e.path === 'src/api' && e.type === 'dir'), 'derives the nested src/api folder');
ok(paths(all).includes('src/fresh.ts'), 'includes a new untracked (non-ignored) file');
ok(!paths(all).some((p) => p.startsWith('/') || p.split('/').includes('..')), 'no absolute or parent-escaping paths');

const r1 = searchWorktreeFiles(dir, 'routes', 25, opt);
ok(paths(r1).includes('src/api/routes.ts'), 'query "routes" finds src/api/routes.ts');

const r2 = searchWorktreeFiles(dir, 'server', 25, opt);
ok(paths(r2)[0] === 'src/server.ts', 'basename match ranks server.ts first');

const r3 = searchWorktreeFiles(dir, 'nomatchxyz', 25, opt);
ok(r3.length === 0, 'no match returns empty');

const r4 = searchWorktreeFiles(dir, '', 25, opt);
ok(paths(r4).includes('README.md') && paths(r4).includes('src'), 'empty query returns top-level entries');
ok(!paths(r4).some((p) => p.includes('/')), 'empty query returns ONLY top-level entries');
ok(r4.findIndex((e) => e.type === 'dir') < r4.findIndex((e) => e.type === 'file'), 'empty query lists folders before files');

const r5 = searchWorktreeFiles(dir, 's', 2, opt);
ok(r5.length <= 2, 'respects the limit cap');

let threw = false;
try { searchWorktreeFiles('/nonexistent-xyz-12345', 'x', 5, opt); } catch { threw = true; }
ok(!threw, 'invalid cwd does not throw (returns empty)');

rmSync(dir, { recursive: true, force: true });
console.log(`\n${fail ? '❌' : '✅'} at-files: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
