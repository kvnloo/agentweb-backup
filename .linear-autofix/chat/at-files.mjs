// File/folder listing for the chat composer's @-mention picker. Sourced from `git ls-files` inside a
// chat's worktree — tracked files plus new untracked ones, with .gitignore honoured (so node_modules,
// dist, and build output never appear). Folders are derived from the file paths. Contents are never
// read and every path comes straight from git (repo-relative, no `..`), so an @-query can never escape
// the worktree. The raw listing is cached briefly per worktree so per-keystroke queries don't re-shell git.
import { execFileSync } from 'node:child_process';

const CACHE = new Map(); // cwd -> { at, entries }
const TTL_MS = 15000;

function gitList(cwd, args) {
  try {
    return execFileSync('git', args, {
      cwd, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'],
    }).split('\0').filter(Boolean);
  } catch { return []; } // not a git repo, git missing, timeout → no suggestions rather than a throw
}

// Every worktree entry (files + the folders derived from their paths), cached per cwd.
export function listWorktreeEntries(cwd, { cache = true } = {}) {
  const hit = cache && CACHE.get(cwd);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.entries;
  const files = [
    ...gitList(cwd, ['ls-files', '-z']),                              // tracked
    ...gitList(cwd, ['ls-files', '-z', '--others', '--exclude-standard']), // new, non-ignored
  ];
  const seen = new Set(), dirs = new Set(), fileEntries = [];
  for (const f of files) {
    if (seen.has(f)) continue;
    seen.add(f);
    fileEntries.push({ path: f, type: 'file' });
    for (let i = f.indexOf('/'); i >= 0; i = f.indexOf('/', i + 1)) dirs.add(f.slice(0, i));
  }
  const entries = [...fileEntries, ...[...dirs].map((path) => ({ path, type: 'dir' }))];
  if (cache) CACHE.set(cwd, { at: Date.now(), entries });
  return entries;
}

// Dirs before files, then alphabetical.
const byTypeThenName = (a, b) => (a.type === b.type ? a.path.localeCompare(b.path) : a.type === 'dir' ? -1 : 1);

// Rank: exact basename < basename-prefix < path-prefix < basename-substring < path-substring; -1 = no match.
function score(p, query) {
  const lp = p.toLowerCase();
  const base = lp.slice(lp.lastIndexOf('/') + 1);
  if (base === query) return 0;
  if (base.startsWith(query)) return 1;
  if (lp.startsWith(query)) return 2;
  if (base.includes(query)) return 3;
  if (lp.includes(query)) return 4;
  return -1;
}
function rank(entries, query, limit) {
  const scored = [];
  for (const e of entries) {
    const s = score(e.path, query);
    if (s >= 0) scored.push({ e, s });
  }
  scored.sort((a, b) => a.s - b.s || a.e.path.length - b.e.path.length || a.e.path.localeCompare(b.e.path));
  return scored.slice(0, limit).map((x) => x.e);
}

// The immediate children of `pfx` (one segment down), so a folder can be browsed one level at a time.
function immediateChildren(scoped, pfx, limit) {
  const seen = new Set(), out = [];
  for (const e of scoped) {
    const rest = e.path.slice(pfx.length);
    const slash = rest.indexOf('/');
    const seg = slash >= 0 ? rest.slice(0, slash) : rest;
    const childPath = pfx + seg;
    if (seen.has(childPath)) continue;
    seen.add(childPath);
    out.push({ path: childPath, type: slash >= 0 ? 'dir' : e.type });
  }
  return out.sort(byTypeThenName).slice(0, limit);
}

// Suggestions for an @-mention. Without `dir`: empty query → top-level entries, else a ranked substring
// search over the whole worktree. With `dir` (browsing a folder): empty query → that folder's immediate
// children, else a ranked search scoped to that folder's subtree.
export function searchWorktreeFiles(cwd, q, limit = 25, opts = {}) {
  const entries = listWorktreeEntries(cwd, opts);
  const query = String(q || '').trim().toLowerCase();
  const dir = String(opts.dir || '').replace(/\/+$/, '');
  if (dir) {
    const pfx = dir + '/';
    const scoped = entries.filter((e) => e.path.startsWith(pfx));
    return query ? rank(scoped, query, limit) : immediateChildren(scoped, pfx, limit);
  }
  if (!query) return entries.filter((e) => !e.path.includes('/')).sort(byTypeThenName).slice(0, limit);
  return rank(entries, query, limit);
}
