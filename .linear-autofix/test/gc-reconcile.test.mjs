// Standalone test for gc.mjs's reapableWorktreelessIds — the reconciler that removes state.json
// entries which never produced a worktree once their Linear issue is Done/Canceled (e.g. ENG-214 /
// ENG-128, which ended `blocked` with no branch and lingered in the sidebar after being marked Done).
// No framework in .linear-autofix — run: node test/gc-reconcile.test.mjs
import { reapableWorktreelessIds } from '../gc.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✅ ${m}`); } else { fail++; console.log(`  ❌ ${m}`); } };
const arrEq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

// A fake Linear resolver: maps identifier -> state type. Unknown ids throw (deleted/renamed issue).
const resolverFor = (states) => async (id) => {
  if (!(id in states)) throw new Error('not found');
  return { state: { name: states[id], type: states[id] } };
};
const noLock = () => false;
const opts = (extra) => ({ resolveIssue: resolverFor(extra.states || {}), lockActive: extra.lockActive || noLock, ...extra });

async function run() {
  console.log('reapableWorktreelessIds:');

  // 1) Done / canceled worktree-less entries are reaped; open ones are kept.
  {
    const entries = [
      { identifier: 'ENG-214' },  // blocked → now Done
      { identifier: 'ENG-128' },  // blocked → now canceled
      { identifier: 'ENG-300' },  // still open
    ];
    const states = { 'ENG-214': 'completed', 'ENG-128': 'canceled', 'ENG-300': 'started' };
    const out = await reapableWorktreelessIds(entries, new Set(), opts({ states }));
    ok(arrEq(out, ['ENG-214', 'ENG-128']), 'reaps completed + canceled, keeps the started one');
  }

  // 2) Entries that DO have a worktree are skipped (the worktree scan owns them) — case-insensitively.
  {
    const entries = [{ identifier: 'ENG-214' }];
    const out = await reapableWorktreelessIds(entries, new Set(['eng-214']), opts({ states: { 'ENG-214': 'completed' } }));
    ok(arrEq(out, []), 'skips an entry that has a worktree (case-insensitive match)');
  }

  // 3) Standalone CHAT-* entries are never touched (not Linear issues).
  {
    const entries = [{ identifier: 'CHAT-3', standalone: true }];
    const out = await reapableWorktreelessIds(entries, new Set(), opts({ states: { 'CHAT-3': 'completed' } }));
    ok(arrEq(out, []), 'skips standalone CHAT-* entries');
  }

  // 4) A locked/in-flight issue is left alone even if Done.
  {
    const entries = [{ identifier: 'ENG-214' }];
    const out = await reapableWorktreelessIds(entries, new Set(), opts({ states: { 'ENG-214': 'completed' }, lockActive: (id) => id === 'ENG-214' }));
    ok(arrEq(out, []), 'skips a locked entry');
  }

  // 5) An issue that no longer resolves (deleted/renamed) is kept, not reaped.
  {
    const entries = [{ identifier: 'ENG-999' }];
    const out = await reapableWorktreelessIds(entries, new Set(), opts({ states: {} }));
    ok(arrEq(out, []), 'keeps an entry whose Linear issue cannot be resolved');
  }

  // 6) Entries without an identifier are ignored (no crash).
  {
    const entries = [null, {}, { identifier: 'ENG-214' }];
    const out = await reapableWorktreelessIds(entries, new Set(), opts({ states: { 'ENG-214': 'completed' } }));
    ok(arrEq(out, ['ENG-214']), 'ignores null / identifier-less entries');
  }

  // 7) Custom doneTypes are honored (e.g. a workflow that only reaps "canceled").
  {
    const entries = [{ identifier: 'ENG-214' }, { identifier: 'ENG-128' }];
    const states = { 'ENG-214': 'completed', 'ENG-128': 'canceled' };
    const out = await reapableWorktreelessIds(entries, new Set(), { resolveIssue: resolverFor(states), lockActive: noLock, doneTypes: ['canceled'] });
    ok(arrEq(out, ['ENG-128']), 'honors a custom doneTypes list');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
