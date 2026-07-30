// Tests the context-usage snapshot that drives /status, /context, and the "conversation is getting large"
// nudge. The bug (ENG-48): contextUsed was measured from the LAST assistant message (a real ~211K Opus
// turn) but the model/window were taken from the model with the MOST total tokens across the turn — and a
// Haiku Explore subagent can out-total the primary Opus answer, so the turn got labelled Haiku, the window
// sized to 200K, and 211K/200K rendered as a FALSE 105% (nagging /compact when only ~21% is used). The fix
// ties the window to the SAME final message's model as contextUsed. Run: node test/usage-snapshot.test.mjs
import { usageSnapshot } from '../chat/usage.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✅ ${m}`); } else { fail++; console.log(`  ❌ ${m}`); } };

// The exact ENG-48 shape: an Opus turn whose final message is 2 fresh + 206200 cache-read + 4713 cache-write
// (= 210,915 context), while a Haiku subagent burned 1.2M tokens this turn — so Haiku is the biggest-total
// model, but the CONTEXT lives in the Opus session.
const opusLast = { input_tokens: 2, cache_read_input_tokens: 206200, cache_creation_input_tokens: 4713, output_tokens: 2861 };
const result = {
  num_turns: 1,
  total_cost_usd: 1.29,
  modelUsage: {
    'claude-opus-4-8':  { inputTokens: 2,    outputTokens: 2861, cacheReadInputTokens: 206200, cacheCreationInputTokens: 4713,   contextWindow: 1000000 },
    'claude-haiku-4-5': { inputTokens: 1000, outputTokens: 5000, cacheReadInputTokens: 800000, cacheCreationInputTokens: 400000, contextWindow: 200000  },
  },
};

console.log('usage snapshot — window tracks the final message, not the biggest-total model');
{
  const snap = usageSnapshot(null, opusLast, 'claude-opus-4-8', result);
  ok(snap.contextUsed === 210915, 'contextUsed = last message input+cache (210,915)');
  ok(snap.model === 'claude-opus-4-8', 'model = the final (primary) message model, not the Haiku subagent');
  ok(snap.contextWindow === 1000000, 'window = Opus 1M, not Haiku 200K');
  const pct = Math.round((snap.contextUsed / snap.contextWindow) * 100);
  ok(pct === 21, `percentage is honest (~21%), not a false >100% (${pct}%)`);
  ok(pct < 80, 'no /compact nudge (below the 80% threshold)');
  // Document the bug the fix corrects: the OLD "biggest-total model" pick WOULD have chosen Haiku/200K → 105%.
  const muTot = (x) => (x.inputTokens||0)+(x.outputTokens||0)+(x.cacheReadInputTokens||0)+(x.cacheCreationInputTokens||0);
  const biggest = Object.keys(result.modelUsage).sort((a, b) => muTot(result.modelUsage[b]) - muTot(result.modelUsage[a]))[0];
  ok(biggest === 'claude-haiku-4-5' && snap.model !== biggest, 'diverges from the old biggest-total pick (which was Haiku)');
}

console.log('\nfallbacks & edges');
{
  // Older CLI that never reports a per-message model → fall back to the biggest-total model (single Opus here).
  const soloOpus = { 'claude-opus-4-8': { inputTokens: 5, outputTokens: 100, cacheReadInputTokens: 90000, cacheCreationInputTokens: 1000, contextWindow: 1000000 } };
  const snap = usageSnapshot(null, opusLast, null, { num_turns: 1, modelUsage: soloOpus });
  ok(snap.model === 'claude-opus-4-8' && snap.contextWindow === 1000000, 'no lastModel → biggest-total model + its window');

  // A genuine Haiku-only turn stays Haiku/200K (we don't over-size).
  const haikuOnly = { 'claude-haiku-4-5': { inputTokens: 10, outputTokens: 50, cacheReadInputTokens: 5000, cacheCreationInputTokens: 0, contextWindow: 200000 } };
  const hs = usageSnapshot(null, { input_tokens: 10, cache_read_input_tokens: 5000, cache_creation_input_tokens: 0, output_tokens: 50 }, 'claude-haiku-4-5', { num_turns: 1, modelUsage: haikuOnly });
  ok(hs.model === 'claude-haiku-4-5' && hs.contextWindow === 200000, 'real Haiku turn keeps Haiku/200K');

  // No modelUsage window for the model → carry the previous snapshot's window forward.
  const prev = { contextUsed: 999, contextWindow: 1000000, model: 'claude-opus-4-8' };
  const noWin = usageSnapshot(prev, opusLast, 'claude-opus-4-8', { num_turns: 1, modelUsage: { 'claude-opus-4-8': { inputTokens: 2 } } });
  ok(noWin.contextWindow === 1000000, 'missing modelUsage window → previous snapshot window carried forward');

  // Nothing reported this turn → return null so the caller keeps the prior snapshot untouched.
  ok(usageSnapshot(prev, null, null, null) === null, 'no usage/model/modelUsage → null (leave prior snapshot)');

  // contextUsed falls back to result.usage when there is no per-message lastUsage.
  const fromResult = usageSnapshot(null, null, 'claude-opus-4-8', { num_turns: 1, usage: { input_tokens: 3, cache_read_input_tokens: 100, cache_creation_input_tokens: 7 }, modelUsage: { 'claude-opus-4-8': { inputTokens: 3, contextWindow: 1000000 } } });
  ok(fromResult.contextUsed === 110, 'contextUsed falls back to result.usage when lastUsage is absent');
}

console.log(fail ? `\n❌ ${fail} FAILED — ${pass} passed, ${fail} failed` : `\n✅ ALL PASSED — ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
