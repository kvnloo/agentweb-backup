// Tests for turnTokens — the per-turn token summary shown in the chat bubble footer (↑ input ↓ output).
// server.mjs has no exports, so (per this repo's convention) we keep a FAITHFUL COPY here. `in` must sum
// fresh + cache-read + cache-write (all input the turn processed, matching the STATS line), `out` the
// generated tokens; missing fields default to 0; no usage → null (nothing to render). Run: node test/turn-tokens.test.mjs
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✅ ${m}`); } else { fail++; console.log(`  ❌ ${m}`); } };

// ── Faithful copy of chat/server.mjs turnTokens (keep in sync) ──
const turnTokens = (u) => {
  if (!u) return null;
  const fresh = u.input_tokens || 0, cacheRead = u.cache_read_input_tokens || 0, cacheWrite = u.cache_creation_input_tokens || 0, out = u.output_tokens || 0;
  return { in: fresh + cacheRead + cacheWrite, out, fresh, cacheRead, cacheWrite };
};

console.log('turnTokens');
{
  // error path: no usage → null (bubble renders nothing)
  ok(turnTokens(null) === null, 'null usage → null');
  ok(turnTokens(undefined) === null, 'undefined usage → null');

  // boundary: empty object → all zeros (in=0,out=0 so the UI suppresses it)
  const z = turnTokens({});
  ok(z.in === 0 && z.out === 0 && z.fresh === 0 && z.cacheRead === 0 && z.cacheWrite === 0, 'empty usage → all zeros');

  // boundary: partial usage (only cache_read present) — other input fields default to 0
  const p = turnTokens({ cache_read_input_tokens: 5000 });
  ok(p.in === 5000 && p.cacheRead === 5000 && p.fresh === 0 && p.cacheWrite === 0 && p.out === 0, 'partial usage defaults missing fields to 0');

  // happy path: a real turn — `in` sums fresh + cache read + cache write; `out` stays separate
  const t = turnTokens({ input_tokens: 438, cache_read_input_tokens: 546385, cache_creation_input_tokens: 2579, output_tokens: 1668 });
  ok(t.in === 438 + 546385 + 2579, '`in` sums fresh + cacheRead + cacheWrite');
  ok(t.out === 1668, '`out` is output only (not folded into `in`)');
  ok(t.fresh === 438 && t.cacheRead === 546385 && t.cacheWrite === 2579, 'breakdown fields preserved for the tooltip');
}

console.log(fail ? `\n❌ ${fail} FAILED — ${pass} passed, ${fail} failed` : `\n✅ ALL PASSED — ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
