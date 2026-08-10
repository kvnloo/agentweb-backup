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
