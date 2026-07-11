// Tests for the 24h idle-preview reaper's DECISION (idlePreviews) — the teardown itself is a spawn.
// It reuses the same lastHit() signal as the cap eviction, so proving idlePreviews proves the reuse:
// a preview with a recent URL open OR chat message is never idle, only genuinely-abandoned ones are.
// Run: node test/preview-idle.test.mjs
import { idlePreviews, lastHit } from '../preview/policy.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✅ ${m}`); } else { fail++; console.log(`  ❌ ${m}`); } };

const H = 3600 * 1000;
const NOW = 1_700_000_000_000;      // fixed "now" so the test is deterministic
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
const DAY = 24 * H;

console.log('idlePreviews (24h idle reaper decision)');
{
  // preview-state keyed lowercase; chat-state keyed UPPERCASE — mirror the real files.
  const state = {
    fresh: { at: iso(1 * H) },        // brought up 1h ago
    stale: { at: iso(30 * H) },       // brought up 30h ago, nothing since → abandoned
    reopened: { at: iso(30 * H) },    // brought up 30h ago BUT its URL was opened 2h ago
    chatty: { at: iso(30 * H) },      // brought up 30h ago BUT recent chat activity
    edge: { at: iso(24 * H) },        // exactly at the threshold
  };
  const access = { reopened: iso(2 * H) };
  const chat = { CHATTY: { messages: [{ at: iso(1 * H) }] } };

  const idle = idlePreviews(DAY, NOW, state, access, chat);
  const ids = idle.map((x) => x.b);

  ok(ids.includes('stale'), 'abandoned preview (30h, untouched) → reaped');
  ok(!ids.includes('fresh'), 'recently brought-up preview → kept');
  ok(!ids.includes('reopened'), 'URL opened 2h ago → kept (last hit reused)');
  ok(!ids.includes('chatty'), 'recent chat activity → kept (last hit reused)');
  ok(ids.includes('edge'), 'exactly at 24h threshold → reaped (>= is idle)');
  // oldest-idle first, matching the cap-eviction ordering
  ok(idle.length >= 2 && idle[0].hit <= idle[idle.length - 1].hit, 'returned oldest-idle first');
  // sanity: the reused lastHit picks the LATEST of the three signals
  ok(lastHit('reopened', state, access, chat) === Date.parse(iso(2 * H)), 'lastHit picks the URL-open time over the older bring-up');
}

console.log(`\n${fail === 0 ? '✅ ALL PASSED' : '❌ FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
