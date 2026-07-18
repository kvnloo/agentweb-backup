// Tests for the natural-language merge trigger's cheap KEYWORD GATE (faithful copy of MERGE_KEYWORD).
// The gate decides which messages are worth sending to the strict yes/no classifier — it must never let
// an obvious non-merge message reach (waste) the model, and must catch the merge verb forms so a real
// request is never dropped. The classifier itself (the no-false-fire guarantee) was live-validated 16/16
// against tricky inputs ("don't merge", "is it mergeable?", "merge conflict", "merge main into the
// branch", "should we merge?" → all NO; "merge it", "ship it", "merge when green" → all YES).
// Run: node test/merge-trigger.test.mjs
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✅ ${m}`); } else { fail++; console.log(`  ❌ ${m}`); } };

// ── Faithful copy of chat/server.mjs MERGE_KEYWORD (keep in sync) ──
const MERGE_KEYWORD = /\bmerg(e|es|ed|ing)\b|\bship\s+it\b/i;
const gate = (t) => MERGE_KEYWORD.test(t || '');

console.log('MERGE_KEYWORD gate');
{
  // reaches the classifier (all merge verb forms + "ship it")
  for (const m of ['merge it', 'merge this PR', 'go ahead and merge', 'please merge', 'merged', 'it merges cleanly', 'start merging it', 'ship it', 'SHIP IT'])
    ok(gate(m), `passes the gate → classified: "${m}"`);

  // skipped entirely (no merge verb) — these can NEVER trigger a merge, no model call
  for (const m of ['fix the failing test', "what's the PR status?", 'run the tests', 'rebase onto main', 'looks good', 'add a null check'])
    ok(!gate(m), `skipped (never merges): "${m}"`);

  // gate lets merge-ambiguous phrases THROUGH (the classifier, not the gate, rejects these)
  ok(gate('there is a merge conflict') && gate('merge main into the branch'), 'ambiguous "merge …" reaches the classifier (which returns no)');
  // an adjective, not the verb — safely skipped (real asks use the verb "merge")
  ok(!gate('is this mergeable?'), '"mergeable" (adjective) is skipped');
}

console.log(fail ? `\n❌ ${fail} FAILED — ${pass} passed, ${fail} failed` : `\n✅ ALL PASSED — ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
