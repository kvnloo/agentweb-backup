// Tests for the background-watch pure helpers that drive the autonomous merge loop. server.mjs has no
// exports, so (per this repo's convention) these are FAITHFUL COPIES — keep in sync. Run: node test/watch.test.mjs
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✅ ${m}`); } else { fail++; console.log(`  ❌ ${m}`); } };

// ── Faithful copies of chat/server.mjs ──
function parseWatch(text) {
  const t = text || '';
  const done = /\[\[WATCH_DONE\]\]/i.test(t);
  const m = t.match(/\[\[WATCH:\s*([^\]]*)\]\]/i);
  return { done, reason: !done && m ? m[1].trim() : null };
}
function stripWatchMarkers(text) {
  return (text || '').replace(/\[\[WATCH:\s*[^\]]*\]\]/gi, '').replace(/\[\[WATCH_DONE\]\]/gi, '').replace(/\n{3,}/g, '\n\n').trim();
}
function watchDecision(watch, { now, memMB, minMemMB, busy }) {
  if (!watch) return 'skip';
  if (now >= watch.until) return 'expired';
  if (now < watch.nextAt) return 'wait';
  if (busy) return 'wait';
  if (memMB != null && memMB < minMemMB) return 'skip';
  return 'fire';
}

console.log('parseWatch');
{
  ok(parseWatch('all good, merged').reason === null && !parseWatch('x').done, 'no markers → {reason:null, done:false}');
  const w = parseWatch('checking...\n[[WATCH: PR #2084 Backend tests running]]');
  ok(!w.done && w.reason === 'PR #2084 Backend tests running', '[[WATCH: r]] → captures & trims the reason');
  ok(parseWatch('done\n[[WATCH_DONE]]').done === true, '[[WATCH_DONE]] → done:true');
  ok(parseWatch('[[WATCH: still waiting]]\n[[WATCH_DONE]]').done === true, 'DONE wins when both markers present');
  ok(parseWatch('[[watch: lower case]]').reason === 'lower case', 'markers are case-insensitive');
  ok(parseWatch('[[WATCH:   spaced   ]]').reason === 'spaced', 'reason is trimmed');
}

console.log('stripWatchMarkers');
{
  ok(stripWatchMarkers('Merged #1.\n\n[[WATCH_DONE]]') === 'Merged #1.', 'strips [[WATCH_DONE]] + trailing blank');
  ok(stripWatchMarkers('Waiting.\n[[WATCH: ci running]]') === 'Waiting.', 'strips [[WATCH: …]]');
  ok(stripWatchMarkers('a\n\n\n\nb') === 'a\n\nb', 'collapses 3+ newlines left by a stripped marker');
  ok(stripWatchMarkers('plain text') === 'plain text', 'leaves normal text untouched');
}

console.log('watchDecision');
{
  const base = { nextAt: 1000, since: 0, until: 100000 };
  ok(watchDecision(null, { now: 5000, memMB: 8000, minMemMB: 3000, busy: false }) === 'skip', 'no watch → skip');
  ok(watchDecision(base, { now: 100000, memMB: 8000, minMemMB: 3000, busy: false }) === 'expired', 'now >= until → expired (cap hit)');
  ok(watchDecision(base, { now: 500, memMB: 8000, minMemMB: 3000, busy: false }) === 'wait', 'now < nextAt → wait (not due yet)');
  ok(watchDecision(base, { now: 5000, memMB: 8000, minMemMB: 3000, busy: true }) === 'wait', 'a turn already running → wait');
  ok(watchDecision(base, { now: 5000, memMB: 1500, minMemMB: 3000, busy: false }) === 'skip', 'low memory → skip (never add to OOM)');
  ok(watchDecision(base, { now: 5000, memMB: 8000, minMemMB: 3000, busy: false }) === 'fire', 'due + free + idle → fire');
  ok(watchDecision(base, { now: 1000, memMB: 8000, minMemMB: 3000, busy: false }) === 'fire', 'boundary: now === nextAt fires (>=, not >)');
  ok(watchDecision(base, { now: 5000, memMB: null, minMemMB: 3000, busy: false }) === 'fire', 'unknown memory (null) does not block a fire');
}

console.log(fail ? `\n❌ ${fail} FAILED — ${pass} passed, ${fail} failed` : `\n✅ ALL PASSED — ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
