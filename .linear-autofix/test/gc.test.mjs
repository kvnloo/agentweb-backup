// Tests for gc.mjs worktree-reaping decisions (ENG-1017).
// Maps to the human-written behavioral contract on the Linear issue:
//   1. a worktree whose linked PR is merged is removed
//   2. an unresolvable identifier past the age threshold is removed, logged by name
//   3. a genuinely in-progress worktree is never removed
// Run: node --test .linear-autofix/test/gc.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { decideWorktree } from '../gc.mjs';

const DONE_TYPES = ['completed', 'canceled'];
const base = { doneTypes: DONE_TYPES, unresolvedMaxAgeDays: 14 };

// Contract 1: linked PR merged → remove, even while the issue sits in a started
// state like Verifying/Merged (the exact leak from the issue: 12 issues, ~23 GB).
test('issue in Verifying (started) with merged PR and no open PR is removed', () => {
  const d = decideWorktree({
    ...base,
    resolved: true,
    issueStateType: 'started',
    issueStateName: 'Verifying',
    prCounts: { open: 0, merged: 1, closedUnmerged: 0 },
  });
  assert.equal(d.action, 'remove');
  assert.match(d.reason, /merged/i);
});

// Greptile P1 (2026-08-10): a closed-without-merge PR alongside a merged one means not
// all associated work was merged — the worktree must be kept.
test('merged PR plus a closed-unmerged PR is kept', () => {
  const d = decideWorktree({
    ...base,
    resolved: true,
    issueStateType: 'started',
    issueStateName: 'Verifying',
    prCounts: { open: 0, merged: 1, closedUnmerged: 1 },
  });
  assert.equal(d.action, 'keep');
});

// Greptile P1 (2026-08-10): a transient Linear failure (network/auth/DNS) must never be
// treated as "unresolvable identifier" and aged out — it fails safe to keep.
test('transient Linear lookup failure keeps the worktree even past the age threshold', () => {
  const d = decideWorktree({ ...base, resolved: false, lookupFailed: true, ageDays: 365 });
  assert.equal(d.action, 'keep');
  assert.match(d.reason, /lookup failed/i);
});

test('done-type issue is still removed (existing behavior preserved)', () => {
  const d = decideWorktree({
    ...base,
    resolved: true,
    issueStateType: 'completed',
    issueStateName: 'Done',
    prCounts: null,
  });
  assert.equal(d.action, 'remove');
});

// Contract 3: genuinely in-progress work is never removed.
test('in-progress issue with an open PR is kept', () => {
  const d = decideWorktree({
    ...base,
    resolved: true,
    issueStateType: 'started',
    issueStateName: 'In Progress',
    prCounts: { open: 1, merged: 1 },
  });
  assert.equal(d.action, 'keep');
});

test('in-progress issue with no PR evidence at all is kept', () => {
  const d = decideWorktree({
    ...base,
    resolved: true,
    issueStateType: 'started',
    issueStateName: 'In Progress',
    prCounts: { open: 0, merged: 0 },
  });
  assert.equal(d.action, 'keep');
});

test('PR lookup failure fails safe to keep, never to remove', () => {
  const d = decideWorktree({
    ...base,
    resolved: true,
    issueStateType: 'started',
    issueStateName: 'Verifying',
    prCounts: null, // gh unavailable / errored
  });
  assert.equal(d.action, 'keep');
});

test('unstarted issue is kept regardless of merged branches elsewhere', () => {
  const d = decideWorktree({
    ...base,
    resolved: true,
    issueStateType: 'unstarted',
    issueStateName: 'Todo',
    prCounts: { open: 0, merged: 0 },
  });
  assert.equal(d.action, 'keep');
});

// Contract 2: unresolvable identifiers age out instead of leaking forever.
test('unresolvable identifier older than the threshold is removed', () => {
  const d = decideWorktree({ ...base, resolved: false, ageDays: 30 });
  assert.equal(d.action, 'remove');
  assert.match(d.reason, /unresolvable/i);
  assert.match(d.reason, /30/);
});

test('unresolvable identifier under the threshold is kept', () => {
  const d = decideWorktree({ ...base, resolved: false, ageDays: 3 });
  assert.equal(d.action, 'keep');
});

test('unresolvable identifier with unknown age is kept (fail safe)', () => {
  const d = decideWorktree({ ...base, resolved: false, ageDays: null });
  assert.equal(d.action, 'keep');
});

test('exact threshold age is kept — strictly older than N days removes', () => {
  const d = decideWorktree({ ...base, resolved: false, ageDays: 14 });
  assert.equal(d.action, 'keep');
});

// Greptile P1 (2026-08-10, second review): the age scan races with live writers.
// ageDaysOf must fail safe (null → keep) on any raced stat error, and a fresh
// write must never be misread as an old tree.
import { ageDaysOf, scanNewestMtime } from '../gc.mjs';
import { mkdtempSync, mkdirSync, writeFileSync as wf, utimesSync, chmodSync, rmSync as rm } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('ageDaysOf reports the age of a genuinely old tree', () => {
  const d = mkdtempSync(join(tmpdir(), 'gc-age-'));
  try {
    wf(join(d, 'f.txt'), 'x');
    const old = (Date.now() - 30 * 86400000) / 1000;
    utimesSync(join(d, 'f.txt'), old, old);
    utimesSync(d, old, old);
    const age = ageDaysOf(d);
    assert.ok(age >= 29 && age <= 31, `expected ~30, got ${age}`);
  } finally { rm(d, { recursive: true, force: true }); }
});

test('ageDaysOf is 0 for a tree with a fresh nested write', () => {
  const d = mkdtempSync(join(tmpdir(), 'gc-age-'));
  try {
    mkdirSync(join(d, 'sub'));
    wf(join(d, 'sub', 'f.txt'), 'x');
    const old = (Date.now() - 30 * 86400000) / 1000;
    utimesSync(d, old, old); // top-level looks idle; nested file is fresh
    assert.equal(ageDaysOf(d), 0);
  } finally { rm(d, { recursive: true, force: true }); }
});

test('a scan error anywhere fails safe to null (age unknown → keep)', () => {
  if (process.getuid && process.getuid() === 0) return; // root ignores modes
  const d = mkdtempSync(join(tmpdir(), 'gc-age-'));
  try {
    mkdirSync(join(d, 'sub'));
    wf(join(d, 'sub', 'f.txt'), 'x');
    chmodSync(join(d, 'sub'), 0o000); // readdir fails mid-scan, like a raced mutation
    assert.equal(scanNewestMtime(d), null);
    assert.equal(ageDaysOf(d), null);
  } finally {
    chmodSync(join(d, 'sub'), 0o755);
    rm(d, { recursive: true, force: true });
  }
});

// Greptile P1 (2026-08-10, third review): a write landing AFTER the age scan but before
// rmSync was silently destroyed — the scan and the removal were not atomic. The fix is a
// quarantine rename (atomic barrier: post-rename writers fail loudly with ENOENT) plus an
// age re-check on the quarantined tree; any write inside the scan→rename window bumps
// mtime and the dir is restored untouched.
import { quarantineIfStillAged } from '../gc.mjs';
import { existsSync as ex, renameSync } from 'node:fs';

test('quarantineIfStillAged removes-eligible old tree: renamed to quarantine, path returned', () => {
  const d = mkdtempSync(join(tmpdir(), 'gc-q-'));
  const t = join(d, 'wt');
  mkdirSync(t);
  try {
    wf(join(t, 'f.txt'), 'x');
    const old = (Date.now() - 30 * 86400000) / 1000;
    utimesSync(join(t, 'f.txt'), old, old);
    utimesSync(t, old, old);
    const q = quarantineIfStillAged(t, 14);
    assert.ok(q && q !== t, 'expected a quarantine path');
    assert.ok(!ex(t), 'original path must be gone (atomic barrier)');
    assert.ok(ex(q), 'quarantined tree must exist for deletion');
  } finally { rm(d, { recursive: true, force: true }); }
});

test('quarantineIfStillAged restores and keeps a tree that turned fresh after the first scan', () => {
  const d = mkdtempSync(join(tmpdir(), 'gc-q-'));
  const t = join(d, 'wt');
  mkdirSync(t);
  try {
    wf(join(t, 'f.txt'), 'x'); // fresh write — simulates a writer racing the earlier scan
    const q = quarantineIfStillAged(t, 14);
    assert.equal(q, null, 'fresh tree must not be reaped');
    assert.ok(ex(t), 'tree must be restored to its original path');
  } finally { rm(d, { recursive: true, force: true }); }
});

test('quarantineIfStillAged fails safe to keep when the rename itself races (dir gone)', () => {
  const d = mkdtempSync(join(tmpdir(), 'gc-q-'));
  try {
    assert.equal(quarantineIfStillAged(join(d, 'never-existed'), 14), null);
  } finally { rm(d, { recursive: true, force: true }); }
});

// A rename preserves already-open file descriptors and process cwds, so the age re-check
// alone cannot see a holder that will write right up to rmSync. openHandleHolders proves
// via /proc that no process holds a handle inside the quarantined tree; holders present or
// an unprovable check (no /proc) → restore and keep. Fake /proc trees drive each branch.
import { openHandleHolders } from '../gc.mjs';
import { symlinkSync } from 'node:fs';

function makeTree(d, ageDays = 30) {
  const t = join(d, 'wt');
  mkdirSync(t);
  wf(join(t, 'f.txt'), 'x');
  const old = (Date.now() - ageDays * 86400000) / 1000;
  utimesSync(join(t, 'f.txt'), old, old);
  utimesSync(t, old, old);
  return t;
}
function makeProc(d, entries) {
  const proc = join(d, 'proc');
  mkdirSync(proc);
  for (const [pid, { cwd, fds = {} }] of Object.entries(entries)) {
    const base = join(proc, pid);
    mkdirSync(base);
    mkdirSync(join(base, 'fd'));
    if (cwd) symlinkSync(cwd, join(base, 'cwd'));
    for (const [fd, target] of Object.entries(fds)) symlinkSync(target, join(base, 'fd', fd));
  }
  return proc;
}

test('openHandleHolders reports a pid holding an fd inside the dir, ignores outsiders', () => {
  const d = mkdtempSync(join(tmpdir(), 'gc-fd-'));
  try {
    const t = makeTree(d);
    const proc = makeProc(d, {
      101: { cwd: d, fds: { 3: join(t, 'f.txt') } },
      102: { cwd: '/', fds: { 3: join(d, 'elsewhere.txt') } },
    });
    assert.deepEqual(openHandleHolders(t, proc), ['101']);
  } finally { rm(d, { recursive: true, force: true }); }
});

test('openHandleHolders reports a pid whose cwd is inside the dir', () => {
  const d = mkdtempSync(join(tmpdir(), 'gc-fd-'));
  try {
    const t = makeTree(d);
    const proc = makeProc(d, { 201: { cwd: t } });
    assert.deepEqual(openHandleHolders(t, proc), ['201']);
  } finally { rm(d, { recursive: true, force: true }); }
});

test('openHandleHolders returns null (unprovable) when the proc table is unreadable', () => {
  const d = mkdtempSync(join(tmpdir(), 'gc-fd-'));
  try {
    const t = makeTree(d);
    assert.equal(openHandleHolders(t, join(d, 'no-such-proc')), null);
  } finally { rm(d, { recursive: true, force: true }); }
});

test('openHandleHolders skips-and-logs an uninspectable pid without reporting it as a holder', () => {
  // EACCES on a pid (foreign-uid or non-dumpable, e.g. sshd) must not crash the scan or
  // fail the whole check closed — that would make GC unable to reap on any real host —
  // but it is logged, never silently equated with "no holder".
  const d = mkdtempSync(join(tmpdir(), 'gc-fd-'));
  try {
    const t = makeTree(d);
    const proc = makeProc(d, { 401: { cwd: '/' }, 402: { cwd: '/', fds: { 3: join(t, 'f.txt') } } });
    chmodSync(join(proc, '401', 'fd'), 0o000);
    const logged = [];
    const orig = console.log;
    console.log = (...a) => logged.push(a.join(' '));
    try {
      assert.deepEqual(openHandleHolders(t, proc), ['402'], 'readable holder still found');
    } finally { console.log = orig; chmodSync(join(proc, '401', 'fd'), 0o755); }
    assert.ok(logged.some((l) => l.includes('uninspectable') && l.includes('401')), 'skip must be logged with the pid');
  } finally { rm(d, { recursive: true, force: true }); }
});

test('openHandleHolders treats a pid vanished mid-scan (ENOENT entries) as gone, not unprovable', () => {
  const d = mkdtempSync(join(tmpdir(), 'gc-fd-'));
  try {
    const t = makeTree(d);
    const proc = makeProc(d, { 501: {} });
    rm(join(proc, '501', 'fd'), { recursive: true, force: true }); // no cwd link, no fd dir → ENOENT everywhere
    assert.deepEqual(openHandleHolders(t, proc), []);
  } finally { rm(d, { recursive: true, force: true }); }
});

test('quarantineIfStillAged restores and keeps an aged tree with a live fd holder', () => {
  const d = mkdtempSync(join(tmpdir(), 'gc-fd-'));
  try {
    const t = makeTree(d);
    const proc = makeProc(d, { 301: { cwd: '/', fds: { 4: join(t, 'f.txt') } } });
    // The holder's fd symlink points at the ORIGINAL path; after the quarantine rename the
    // kernel would rewrite it to the quarantined path. Point the fake at the post-rename
    // path, which is what the real /proc shows at check time.
    rm(join(proc, '301', 'fd', '4'), { force: true });
    symlinkSync(join(`${t}.gc-quarantine`, 'f.txt'), join(proc, '301', 'fd', '4'));
    const q = quarantineIfStillAged(t, 14, proc);
    assert.equal(q, null, 'tree with a live holder must not be reaped');
    assert.ok(ex(t), 'tree must be restored to its original path');
  } finally { rm(d, { recursive: true, force: true }); }
});

test('quarantineIfStillAged restores and keeps when the holder check is unprovable', () => {
  const d = mkdtempSync(join(tmpdir(), 'gc-fd-'));
  try {
    const t = makeTree(d);
    const q = quarantineIfStillAged(t, 14, join(d, 'no-such-proc'));
    assert.equal(q, null, 'unprovable holder check must fail safe to keep');
    assert.ok(ex(t), 'tree must be restored to its original path');
  } finally { rm(d, { recursive: true, force: true }); }
});

test('quarantineIfStillAged reaps an aged tree when /proc proves no holders', () => {
  const d = mkdtempSync(join(tmpdir(), 'gc-fd-'));
  try {
    const t = makeTree(d);
    const proc = makeProc(d, { 401: { cwd: '/', fds: { 3: '/somewhere/else' } } });
    const q = quarantineIfStillAged(t, 14, proc);
    assert.ok(q && ex(q), 'holder-free aged tree must be reaped');
  } finally { rm(d, { recursive: true, force: true }); }
});
