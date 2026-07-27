// Tests that the pipeline attributes the git PUSH to the assignee, not the box account. The box's git
// uses `gh` as its credential helper and `gh` honors GH_TOKEN, so setting GH_TOKEN=<assignee token> at
// pipeline start makes every `git push` authenticate as the assignee (fixing "Harshit pushed" emails on
// commits authored by the assignee). applyAssigneeIdentity is the one place the pipeline sets this.
// Run: node test/push-attribution.test.mjs
import { applyAssigneeIdentity } from '../git-identity.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✅ ${m}`); } else { fail++; console.log(`  ❌ ${m}`); } };

const save = { tok: process.env.GH_TOKEN, mv: process.env.GH_TOKEN_MVARMA };

console.log('pipeline push attribution');
{
  // Assignee with a configured token → GH_TOKEN is set to it (so git push runs as them).
  process.env.GH_TOKEN_MVARMA = 'ghp_test_manan';
  delete process.env.GH_TOKEN;
  applyAssigneeIdentity({ assignee: { email: 'mvarma@argusoft.com', name: 'Manan Varma' } });
  ok(process.env.GH_TOKEN === 'ghp_test_manan', 'assignee with token → GH_TOKEN set to the assignee token');

  // Set even when the git commit identity is present — token routing is independent of it.
  ok(process.env.GIT_AUTHOR_EMAIL === 'mvarma@argusoft.com', 'commit identity still applied alongside');

  // Unconfigured assignee → GH_TOKEN untouched (falls back to the box account, same as before).
  delete process.env.GH_TOKEN_MVARMA; delete process.env.GH_TOKEN;
  applyAssigneeIdentity({ assignee: { email: 'nobody@example.com' } });
  ok(process.env.GH_TOKEN === undefined, 'no configured token → GH_TOKEN not set (box default push)');

  // No assignee at all → GH_TOKEN untouched.
  delete process.env.GH_TOKEN;
  applyAssigneeIdentity({});
  ok(process.env.GH_TOKEN === undefined, 'no assignee → GH_TOKEN not set');
}

// restore env we touched
if (save.tok === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = save.tok;
if (save.mv === undefined) delete process.env.GH_TOKEN_MVARMA; else process.env.GH_TOKEN_MVARMA = save.mv;

console.log(fail ? `\n❌ ${fail} FAILED — ${pass} passed, ${fail} failed` : `\n✅ ALL PASSED — ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
