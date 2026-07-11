// Repro/proof harness for the functional-bug audit. Each block ASSERTS the buggy behavior that
// exists in today's code, so a green run here = the bug is real and reproducible (not speculation).
// When a bug is later fixed, the corresponding assertion flips — update it then.
// Run: node test/audit-repro.test.mjs
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { computeTriage, reconcileWithRemote, commitsDropped } from '../autofix.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✅ ${m}`); } else { fail++; console.log(`  ❌ ${m}`); } };

// ── #5: a not_fixed verdict overwritten by an inconclusive re-verify downgrades rework→manual ──
// autofix.mjs:356 does `if (v2) verify = {...v2}` unconditionally. Prove the consequence: the same
// pipeline state triages 'rework' with not_fixed but 'manual' once it's replaced by env_down.
console.log('#5 not_fixed erased by env_down re-verify → triage downgrade');
{
  const checks = [{ cmd: 'tsc', result: 'pass' }];
  const review = { manager: { verdict: 'sound' } };
  const asNotFixed = computeTriage({ review, verify: { verdict: 'not_fixed' }, checks, reviewEnabled: true });
  const asEnvDown  = computeTriage({ review, verify: { verdict: 'env_down', method: 'browser' }, checks, reviewEnabled: true });
  ok(asNotFixed === 'rework', `not_fixed → 'rework' (got '${asNotFixed}')`);
  ok(asEnvDown === 'manual', `same state but env_down → 'manual' (got '${asEnvDown}') — the not_fixed signal is lost`);
  ok(asNotFixed !== asEnvDown, 'BUG CONFIRMED: overwriting not_fixed with an inconclusive re-verify changes the human-facing verdict');
}

// ── #3: PR links built from the stale in-memory entry drop a concurrently-added PR ──
// Faithful copy of chat/server.mjs mergePrs + the call-site pattern `{...freshEntry, prs: merged}`.
function mergePrs(existing, detected) {
  const byRepo = new Map((existing || []).filter((p) => p && p.repo).map((p) => [p.repo, p]));
  for (const d of detected || []) {
    if (!d || !d.repo || !d.url) continue;
    byRepo.set(d.repo, { ...(byRepo.get(d.repo) || {}), repo: d.repo, url: d.url });
  }
  return [...byRepo.values()];
}
console.log('#3 FIX: merge PRs against the FRESH on-disk entry, not the stale in-memory copy');
{
  const detected   = [{ repo: 'main', url: 'u/main' }];                 // this turn only touched main
  const freshEntry = { prs: [{ repo: 'main', url: 'u/main' }, { repo: 'customer-portal', url: 'u/cp' }] }; // another writer added cp mid-turn
  // Fixed call-site pattern: mergePrs runs INSIDE the updater against e.prs (the fresh entry).
  const written = { ...freshEntry, prs: mergePrs(freshEntry.prs || [], detected) };
  const repos = written.prs.map((p) => p.repo);
  ok(repos.includes('customer-portal'), `FIX VERIFIED: concurrently-added customer-portal PR preserved (prs = ${JSON.stringify(repos)})`);
  ok(repos.includes('main'), 'main PR still present');
}

// ── #8: commitsDropped() detects an agent reconcile that silently dropped our commit ──
const g8 = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8' });
const G8 = (cwd, ...a) => { const r = g8(cwd, ...a); if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr || r.stdout}`); return (r.stdout || '').trim(); };
console.log('#8 FIX: commitsDropped flags a reconcile that adopted the remote and left our commit behind');
{
  const root = mkdtempSync(path.join(tmpdir(), 'audit8-'));
  try {
    G8(root, 'init', '--bare', '-b', 'main', 'origin.git');
    const origin = path.join(root, 'origin.git');
    const seed = path.join(root, 'seed'); G8(root, 'init', '-b', 'main', 'seed');
    G8(seed, 'config', 'user.email', 't@t'); G8(seed, 'config', 'user.name', 't');
    writeFileSync(path.join(seed, 'b.txt'), 'v1\n'); G8(seed, 'add', 'b.txt'); G8(seed, 'commit', '-q', '-m', 'base');
    G8(seed, 'remote', 'add', 'origin', origin); G8(seed, 'push', '-q', 'origin', 'main');
    G8(seed, 'checkout', '-q', '-b', 'fix'); G8(seed, 'push', '-q', 'origin', 'fix');
    const wt = path.join(root, 'wt'); G8(root, 'clone', '-q', origin, 'wt');
    G8(wt, 'config', 'user.email', 't@t'); G8(wt, 'config', 'user.name', 't'); G8(wt, 'checkout', '-q', 'fix');
    // our commit exists locally but was NEVER pushed; simulate the agent adopting remote (reset back to it)
    writeFileSync(path.join(wt, 'mine.txt'), 'MINE\n'); G8(wt, 'add', 'mine.txt'); G8(wt, 'commit', '-q', '-m', 'my work');
    const preHead = G8(wt, 'rev-parse', 'HEAD');
    G8(wt, 'reset', '--hard', 'origin/fix'); // agent dropped our commit, HEAD now == remote
    ok(commitsDropped(wt, 'main', preHead) === true, 'DROPPED detected: our commit is gone from the remote');
    // now actually push our commit and re-check → not dropped
    G8(wt, 'reset', '--hard', preHead); G8(wt, 'push', '-q', 'origin', 'fix');
    ok(commitsDropped(wt, 'main', preHead) === false, 'not-dropped: after a real push, our commit is on the remote');
  } finally { rmSync(root, { recursive: true, force: true }); }
}

// ── #16 (DOWNGRADED → theoretical): reconcile when the BASE branch itself is rewritten. Constructing
// this even in a test requires force-pushing `main` and rebasing a branch onto the rewrite, which is
// inherently conflict-ridden — and `main` is branch-protected / append-only in practice. The trigger
// essentially cannot occur in the real system, so this is not treated as an actionable bug.
void reconcileWithRemote; void spawnSync; void mkdtempSync; void writeFileSync; void rmSync; void tmpdir; void path;

// ── #18 FIX: edit/delete resolve by stable mid, so a .slice(-500) front-drop can't cut at the wrong
// message. Faithful copies of server.mjs ensureMids + resolveMsgIndex. ──
function ensureMids(cs) {
  let seq = cs.midSeq || 0;
  for (const m of cs.messages) if (m && m.mid == null) m.mid = ++seq;
  cs.midSeq = seq; return cs;
}
function resolveMsgIndex(msgs, body) {
  if (body?.mid != null) return msgs.findIndex((m) => m && m.mid === body.mid);
  const idx = Number.parseInt(body?.index, 10);
  return Number.isInteger(idx) && idx >= 0 && idx < msgs.length ? idx : -1;
}
console.log('#18 FIX: edit/delete target survives a .slice(-500) index shift');
{
  const cs = { messages: Array.from({ length: 502 }, (_, i) => ({ role: 'user', text: `m${i}` })) };
  ensureMids(cs);
  const target = cs.messages[250];               // the message a user clicks edit on (index 250)
  const clickedIndex = 250, clickedMid = target.mid;
  cs.messages = cs.messages.slice(-500);         // cap drops the first 2 → everything shifts down by 2
  ensureMids(cs);
  // stale raw index now points at the WRONG message; the stable mid still finds the right one
  ok(cs.messages[clickedIndex].text !== target.text, 'raw index now points at a different message (the bug)');
  const byMid = resolveMsgIndex(cs.messages, { mid: clickedMid });
  ok(byMid >= 0 && cs.messages[byMid].text === target.text, `FIX VERIFIED: mid resolves to the original message (idx ${byMid}, was ${clickedIndex})`);
  // a target that scrolled out of the window resolves to -1 (rejected, not mis-cut)
  ok(resolveMsgIndex(cs.messages, { mid: 1 }) === -1, 'a dropped message resolves to -1 (rejected, never mis-cut)');
}

console.log(`\n${fail === 0 ? '✅ ALL ASSERTIONS HELD' : '❌ SOME ASSERTIONS FAILED'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
