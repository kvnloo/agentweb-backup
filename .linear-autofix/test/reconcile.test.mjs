// Standalone test harness for reconcileWithRemote (no framework in .linear-autofix).
// Builds REAL temp git repos to simulate: rebased-remote (ENG-243), remote-ahead-with-new-local,
// dirty worktree, and a true conflict. Run: node reconcile.test.mjs
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { reconcileWithRemote } from '../autofix.mjs';

const g = (cwd, ...a) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8' }); return r; };
const G = (cwd, ...a) => { const r = g(cwd, ...a); if (r.status !== 0) throw new Error(`git ${a.join(' ')} failed in ${cwd}:\n${r.stderr||r.stdout}`); return (r.stdout||'').trim(); };
const sha = (cwd, ref='HEAD') => G(cwd, 'rev-parse', ref);
const patchId = (cwd, ref) => { const show = spawnSync('git', ['show', ref], { cwd, encoding: 'utf8' }).stdout; return spawnSync('git', ['patch-id','--stable'], { cwd, input: show, encoding: 'utf8' }).stdout.trim().split(' ')[0]; };
const commit = (cwd, file, body, msg) => { writeFileSync(path.join(cwd, file), body); G(cwd, 'add', file); G(cwd, 'commit', '-q', '-m', msg); };
const setId = (cwd) => { G(cwd,'config','user.email','t@t'); G(cwd,'config','user.name','t'); };

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✅ ${m}`); } else { fail++; console.log(`  ❌ ${m}`); } };

// Build: bare origin with main + a fix branch based off an OLD main; a local clone as the "worktree".
function scaffold() {
  const root = mkdtempSync(path.join(tmpdir(), 'recon-'));
  const origin = path.join(root, 'origin.git');
  G(root, 'init', '--bare', '-b', 'main', 'origin.git');
  const seed = path.join(root, 'seed');
  G(root, 'init', '-b', 'main', 'seed'); setId(seed);
  commit(seed, 'base.txt', 'v1\n', 'base1');
  G(seed, 'remote', 'add', 'origin', origin); G(seed, 'push', '-q', 'origin', 'main');
  // fix branch off main
  G(seed, 'checkout', '-q', '-b', 'fix');
  commit(seed, 'feature.txt', 'FEATURE\n', 'feat: the fix');
  commit(seed, 'feature.test.txt', 'TEST\n', 'test: the fix');
  G(seed, 'push', '-q', 'origin', 'fix');
  // the "worktree" = a fresh clone at the fix branch
  const wt = path.join(root, 'wt');
  G(root, 'clone', '-q', origin, 'wt'); setId(wt);
  G(wt, 'checkout', '-q', 'fix');
  return { root, origin, seed, wt };
}

// ---- Scenario 1: remote branch REBASED server-side onto a newer main (the ENG-243 case) ----
console.log('Scenario 1: remote rebased (our commits already there by patch-id) → fast-forward, no push');
{
  const { root, origin, seed, wt } = scaffold();
  const localFeatPid = patchId(wt, 'HEAD~1'), localTestPid = patchId(wt, 'HEAD');
  // advance main on origin, then rebase fix onto it (new SHAs, same patch-ids) and force-push
  G(seed, 'checkout', '-q', 'main');
  commit(seed, 'base.txt', 'v1\nv2\n', 'base2: main advances');
  G(seed, 'push', '-q', 'origin', 'main');
  G(seed, 'checkout', '-q', 'fix');
  G(seed, 'rebase', '-q', 'main');
  G(seed, 'push', '-q', '-f', 'origin', 'fix');
  const remoteTip = G(seed, 'rev-parse', 'HEAD');
  // local worktree is now stale/diverged; reconcile
  const res = reconcileWithRemote(wt, 'fix', 'main', () => {});
  ok(res.ok === true && res.needPush === false, `returns {ok:true, needPush:false} (got ${JSON.stringify(res)})`);
  ok(sha(wt) === remoteTip, 'worktree HEAD fast-forwarded to remote tip');
  // no work lost: both fix commits still present by patch-id
  const haveFeat = patchId(wt, 'HEAD~1') === localFeatPid || patchId(wt, 'HEAD') === localFeatPid;
  const haveTest = patchId(wt, 'HEAD') === localTestPid || patchId(wt, 'HEAD~1') === localTestPid;
  ok(haveFeat && haveTest, 'both fix commits preserved by patch-id (no data loss)');
  rmSync(root, { recursive: true, force: true });
}

// ---- Scenario 2: remote strictly AHEAD; local has a genuinely new commit → replay + push ----
console.log('Scenario 2: remote ahead + a new local commit → cherry-pick new one, needPush');
{
  const { root, origin, seed, wt } = scaffold();
  // someone pushed another commit to fix on the remote
  G(seed, 'checkout', '-q', 'fix');
  commit(seed, 'other.txt', 'OTHER\n', 'feat: other person work');
  G(seed, 'push', '-q', 'origin', 'fix');
  // local makes its OWN new commit (touches a different file → no conflict)
  commit(wt, 'mine.txt', 'MINE\n', 'feat: my new commit');
  const myPid = patchId(wt, 'HEAD');
  const res = reconcileWithRemote(wt, 'fix', 'main', () => {});
  ok(res.ok === true && res.needPush === true, `returns {ok:true, needPush:true} (got ${JSON.stringify(res)})`);
  // remote's commit is now an ancestor, and my commit sits on top
  ok(G(wt, 'log', '--oneline').includes('other person work'), "remote's commit adopted");
  ok(patchId(wt, 'HEAD') === myPid, 'my new commit replayed on top');
  // push works as a fast-forward now
  ok(g(wt, 'push', 'origin', 'HEAD').status === 0, 'push succeeds after reconcile');
  rmSync(root, { recursive: true, force: true });
}

// ---- Scenario 3: dirty worktree → refuse (never reset over uncommitted work) ----
console.log('Scenario 3: dirty worktree → {ok:false, dirty-worktree}');
{
  const { root, wt } = scaffold();
  writeFileSync(path.join(wt, 'feature.txt'), 'UNCOMMITTED EDIT\n');
  const res = reconcileWithRemote(wt, 'fix', 'main', () => {});
  ok(res.ok === false && res.reason === 'dirty-worktree', `refused (got ${JSON.stringify(res)})`);
  rmSync(root, { recursive: true, force: true });
}

// ---- Scenario 4: true conflict on a new commit → abort + restore original HEAD exactly ----
console.log('Scenario 4: conflicting new commit → {ok:false, conflict} and HEAD restored');
{
  const { root, seed, wt } = scaffold();
  // remote adds a commit editing feature.txt
  G(seed, 'checkout', '-q', 'fix');
  commit(seed, 'feature.txt', 'FEATURE\nremote-line\n', 'feat: remote edits feature');
  G(seed, 'push', '-q', 'origin', 'fix');
  // local adds a CONFLICTING new commit editing the same file/region
  commit(wt, 'feature.txt', 'FEATURE-local-conflict\n', 'feat: local edits feature');
  const origLocal = sha(wt);
  const res = reconcileWithRemote(wt, 'fix', 'main', () => {});
  ok(res.ok === false && res.reason === 'cherry-pick-conflict', `reports conflict (got ${JSON.stringify(res)})`);
  ok(sha(wt) === origLocal, 'HEAD restored to original (no data loss, remote untouched)');
  ok((g(wt, 'status', '--porcelain').stdout || '').trim() === '', 'worktree clean after abort (no half-applied pick)');
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? '✅ ALL PASS' : '❌ FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
