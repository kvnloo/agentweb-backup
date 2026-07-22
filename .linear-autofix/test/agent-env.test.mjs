// Tests for the chat-agent env scoping: the agent must touch Linear as the ISSUE'S ASSIGNEE, never via
// the shared/global LINEAR_API_KEY the server runs on. server.mjs has no exports, so (per this repo's
// convention) we keep FAITHFUL COPIES of assigneeLinearKey + agentEnv here. Run: node test/agent-env.test.mjs
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✅ ${m}`); } else { fail++; console.log(`  ❌ ${m}`); } };

// ── Faithful copies of chat/server.mjs (keep in sync). config/process.env are injected for the test. ──
function makeEnv(config, procEnv) {
  const assigneeLinearKey = (email) => {
    const ev = email ? config.assigneeLinearKeyEnv?.[email] : null;
    return (ev && procEnv[ev]) || null;
  };
  const resolveAssigneeGhToken = ({ email }) => procEnv[config.assigneeGhTokenEnv?.[email]] || null;
  function agentEnv(entry, attr) {
    const email = attr?.email || entry?.assigneeEmail || entry?.assignee?.email || null;
    const env = { ...procEnv };
    const linKey = assigneeLinearKey(email);
    if (linKey) env.LINEAR_API_KEY = linKey; else delete env.LINEAR_API_KEY;
    if (attr) {
      Object.assign(env, attr.idEnv || {});
      const ghToken = attr.email ? resolveAssigneeGhToken({ email: attr.email }) : null;
      if (ghToken) env.GH_TOKEN = ghToken;
    }
    return env;
  }
  return { assigneeLinearKey, agentEnv };
}

const config = {
  assigneeLinearKeyEnv: { 'mvarma@argusoft.com': 'LINEAR_KEY_MVARMA', 'aseth@argusoft.com': 'LINEAR_KEY_ASETH' },
  assigneeGhTokenEnv: { 'mvarma@argusoft.com': 'GH_TOKEN_MVARMA' },
};
// The shared/global key is the poller's own key; LINEAR_KEY_ASETH is intentionally left unset here to
// exercise the "assignee is configured in the map but their key env is empty" branch.
const procEnv = { LINEAR_API_KEY: 'GLOBAL-SHARED-key', LINEAR_KEY_MVARMA: 'MANAN-key', GH_TOKEN_MVARMA: 'MANAN-gh', PATH: '/usr/bin' };

console.log('agent env — Linear scoped to the assignee, shared key never leaks');
{
  const { agentEnv } = makeEnv(config, procEnv);

  // happy path: ENG-200 full turn, assignee Manan (has a key) → agent gets Manan's key, NOT the global
  const full = agentEnv({ assigneeEmail: 'mvarma@argusoft.com' }, { email: 'mvarma@argusoft.com', idEnv: { GIT_AUTHOR_NAME: 'Manan Varma' } });
  ok(full.LINEAR_API_KEY === 'MANAN-key', 'full turn: LINEAR_API_KEY is the assignee (Manan) key');
  ok(full.LINEAR_API_KEY !== 'GLOBAL-SHARED-key', 'full turn: the shared/global key is NOT used');
  ok(full.GH_TOKEN === 'MANAN-gh', 'full turn: assignee GH token attached');
  ok(full.GIT_AUTHOR_NAME === 'Manan Varma', 'full turn: assignee git identity attached');
  ok(full.PATH === '/usr/bin', 'full turn: the rest of the env is preserved');

  // error path: assignee configured but their key env is UNSET (e.g. aseth here) → NO Linear key (not shared)
  const noKey = agentEnv({ assigneeEmail: 'aseth@argusoft.com' }, { email: 'aseth@argusoft.com', idEnv: {} });
  ok(!('LINEAR_API_KEY' in noKey), 'assignee with an unset key env → LINEAR_API_KEY removed (never the shared key)');

  // error path: assignee not in the key map at all → LINEAR_API_KEY removed
  const unknown = agentEnv({ assigneeEmail: 'someone@else.com' }, { email: 'someone@else.com', idEnv: {} });
  ok(!('LINEAR_API_KEY' in unknown), 'unknown assignee → LINEAR_API_KEY removed');

  // boundary: no assignee at all → shared key still stripped (never leak it)
  const none = agentEnv({}, null);
  ok(!('LINEAR_API_KEY' in none), 'no assignee → shared key stripped');

  // read-only turn (attr null): Linear still scoped from the stored assignee, but NO git identity / GH token
  const ro = agentEnv({ assigneeEmail: 'mvarma@argusoft.com' }, null);
  ok(ro.LINEAR_API_KEY === 'MANAN-key', 'read-only turn: Linear still scoped to the assignee');
  ok(!('GH_TOKEN' in ro) && !('GIT_AUTHOR_NAME' in ro), 'read-only turn: no write-attribution env (GH/git identity)');

  // assignee resolves from entry.assignee.email when assigneeEmail is absent (standalone shape)
  const nested = agentEnv({ assignee: { email: 'mvarma@argusoft.com' } }, null);
  ok(nested.LINEAR_API_KEY === 'MANAN-key', 'assignee resolves from entry.assignee.email too');
}

console.log(fail ? `\n❌ ${fail} FAILED — ${pass} passed, ${fail} failed` : `\n✅ ALL PASSED — ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
