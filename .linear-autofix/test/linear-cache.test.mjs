// Tests for the Linear fetch cache — server.mjs hit the Linear API live on every detail GET / poll /
// turn-prompt, which was half the multi-second detail latency. It now caches per-issue with
// stale-while-revalidate (same shape as usageCache). server.mjs has no exports, so (per this repo's
// convention) we keep a FAITHFUL COPY of fetchLinear + refreshLinear here, with resolveIssue and the
// clock injected, and verify: cold fetch blocks once; within TTL served from cache with no new call;
// stale serves the last good value immediately and refreshes in the background; a failing refresh
// keeps the last good value; a first-ever failure yields null. Run: node test/linear-cache.test.mjs
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✅ ${m}`); } else { fail++; console.log(`  ❌ ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// injectable clock + resolveIssue so the test is deterministic and offline
let NOW = 1_000_000;
const now = () => NOW;
let calls = 0;          // how many times the underlying Linear API was hit
let mode = 'ok';        // 'ok' | 'fail'
async function resolveIssue(identifier) {
  calls++;
  if (mode === 'fail') throw new Error('linear down');
  return { title: `${identifier} title @${calls}`, description: '', url: `u/${identifier}`, state: { name: 'Todo', type: 'unstarted' }, comments: { nodes: [] } };
}

// ── Faithful copy of chat/server.mjs fetchLinear + refreshLinear (keep in sync) ──
// (Date.now() → now(); 8s Promise.race timeout omitted — irrelevant to cache semantics.)
const LINEAR_TTL_MS = 30000;
const linearCache = new Map();
async function refreshLinear(identifier) {
  try {
    const issue = await resolveIssue(identifier);
    const data = {
      title: issue.title, description: issue.description || '', url: issue.url,
      stateName: issue.state?.name || null, stateType: issue.state?.type || null,
      comments: (issue.comments?.nodes || []).map((c) => ({ author: c.user?.name || 'someone', body: c.body, at: c.createdAt })),
    };
    linearCache.set(identifier, { at: now(), data });
    return data;
  } catch { return linearCache.get(identifier)?.data ?? null; }
}
async function fetchLinear(identifier) {
  const hit = linearCache.get(identifier);
  if (hit && now() - hit.at < LINEAR_TTL_MS) return hit.data;
  if (hit) { refreshLinear(identifier).catch(() => {}); return hit.data; }
  return refreshLinear(identifier);
}

console.log('Linear fetch cache');
{
  // cold: first fetch blocks and hits the API once
  calls = 0;
  const a = await fetchLinear('ENG-1');
  ok(a && a.title === 'ENG-1 title @1', 'cold fetch returns fresh data');
  ok(calls === 1, 'cold fetch makes exactly one API call');

  // within TTL: served from cache, no new API call
  NOW += 10_000; // still < 30s
  const b = await fetchLinear('ENG-1');
  ok(calls === 1, 'within TTL: no new API call');
  ok(b === a, 'within TTL: returns the cached object');

  // stale: past TTL → serve last-good immediately, refresh in the background
  NOW += 25_000; // now 35s since the cached `at` → stale
  const c = await fetchLinear('ENG-1');
  ok(c.title === 'ENG-1 title @1', 'stale read returns the last-good value immediately (not blocked)');
  await sleep(5); // let the background refresh settle
  ok(calls === 2, 'stale read triggered exactly one background refresh');
  const d = await fetchLinear('ENG-1'); // background refresh reset `at` to NOW → fresh again
  ok(calls === 2 && d.title === 'ENG-1 title @2', 'background-refreshed value is now cached & fresh');

  // failing refresh on a stale entry keeps the last good value (never regresses to null)
  mode = 'fail';
  NOW += 40_000; // stale again
  const e = await fetchLinear('ENG-1');
  await sleep(5);
  ok(e && e.title === 'ENG-1 title @2', 'stale + failed refresh serves last-good, not null');

  // first-ever fetch that fails → null (decoration, never a hard dependency)
  const f = await fetchLinear('ENG-NEVER');
  ok(f === null, 'cold fetch failure → null');
  mode = 'ok';
}

console.log(fail ? `\n❌ ${fail} FAILED — ${pass} passed, ${fail} failed` : `\n✅ ALL PASSED — ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
