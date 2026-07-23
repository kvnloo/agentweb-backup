// Tests for stalePreviews() — the branch-HEAD drift detector behind gc auto-refresh and the sidebar
// "⚠ stale" marker. A live preview is a bring-up-time snapshot (ts-node backend + built-once portals);
// once the branch advances past the commit it was brought up from, it serves stale code. The git probe
// (headOf) is injected so the decision is deterministic. Run: node test/preview-staleness.test.mjs
import { stalePreviews } from '../preview/policy.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✅ ${m}`); } else { fail++; console.log(`  ❌ ${m}`); } };

// worktree → current HEAD, stubbed.
const heads = {
  '/wt/eng-1': 'bbbbbbb',   // moved on past its bring-up commit → stale
  '/wt/eng-2': 'aaaaaaa',   // still at its bring-up commit → fresh
  '/wt/eng-4': null,        // git probe fails → treat as unknown, don't flag
};
const headOf = (wt) => heads[wt];

const state = {
  'eng-1': { worktree: '/wt/eng-1', commit: 'aaaaaaa' },              // stale (aaaa → bbbb)
  'eng-2': { worktree: '/wt/eng-2', commit: 'aaaaaaa' },              // fresh
  'eng-3': { worktree: '/wt/eng-3' },                                 // no recorded commit → skip
  'eng-4': { worktree: '/wt/eng-4', commit: 'aaaaaaa' },              // HEAD unreadable → skip
  'eng-5': { worktree: '/wt/eng-5', commit: 'aaaaaaa', starting: true }, // in-flight placeholder → skip
};

console.log('stalePreviews');
{
  const stale = stalePreviews(state, headOf);
  const ids = stale.map((s) => s.b);
  ok(ids.includes('eng-1'), 'preview whose branch moved past its commit → stale');
  ok(!ids.includes('eng-2'), 'preview still at its bring-up commit → NOT stale');
  ok(!ids.includes('eng-3'), 'no recorded commit → skipped (can\'t judge)');
  ok(!ids.includes('eng-4'), 'unreadable HEAD (null) → skipped (no false positive)');
  ok(!ids.includes('eng-5'), 'in-flight starting placeholder → skipped');
  ok(stale.length === 1, 'exactly one stale preview found');
  const e1 = stale.find((s) => s.b === 'eng-1');
  ok(e1.from === 'aaaaaaa' && e1.to === 'bbbbbbb', 'reports from (bring-up) → to (branch head)');
  ok(e1.worktree === '/wt/eng-1', 'carries the worktree path for the refresh');
}

console.log('empty / all-fresh');
{
  ok(stalePreviews({}, headOf).length === 0, 'no previews → none stale');
  ok(stalePreviews({ 'eng-2': state['eng-2'] }, headOf).length === 0, 'single fresh preview → none stale');
}

console.log(`\n${fail === 0 ? '✅ ALL PASSED' : '❌ FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
