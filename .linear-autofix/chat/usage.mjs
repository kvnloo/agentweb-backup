// chat/usage.mjs — compute the per-conversation context-usage snapshot that drives /status, /context, and
// the sidebar "this conversation is getting large — /compact" nudge. Pure and dependency-free so it's
// unit-testable (see test/usage-snapshot.test.mjs); the caller stamps `at` and updates the cost total.
//
// contextUsed is measured from the LAST assistant message's input+cache — that's ≈ the size the next turn
// will resume. The model AND its context window come from that SAME final message's model, NOT from the
// model that spent the most tokens across the whole turn. Claude Code spawns Explore subagents on Haiku; a
// Haiku subagent can out-total the primary Opus answer, and picking "most tokens" then labels the turn
// Haiku and sizes the window to 200K — so a real ~211K Opus context reads as a false 105% and nags
// /compact when only ~21% of the 1M window is used. Tying the window to the final message's model (the same
// source as contextUsed) keeps the ratio honest. "Biggest-total model" survives only as a fallback for the
// (rare) case where the stream never reported a per-message model.
const muTotal = (x) => (x ? (x.inputTokens || 0) + (x.outputTokens || 0) + (x.cacheReadInputTokens || 0) + (x.cacheCreationInputTokens || 0) : 0);

export function usageSnapshot(prev, lastUsage, lastModel, result) {
  const u = lastUsage || result?.usage || null;
  const mu = result?.modelUsage || null;
  const biggest = mu ? Object.keys(mu).sort((a, b) => muTotal(mu[b]) - muTotal(mu[a]))[0] : null;
  // This turn reported nothing measurable — leave the prior snapshot in place (return null).
  if (!u && !lastModel && !biggest) return null;
  const model = lastModel || biggest || prev?.model || null;
  const windowOf = (m) => (m && mu && typeof mu[m]?.contextWindow === 'number') ? mu[m].contextWindow : null;
  const contextWindow = windowOf(lastModel) ?? windowOf(biggest) ?? prev?.contextWindow ?? null;
  return {
    contextUsed: u ? ((u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)) : (prev?.contextUsed ?? null),
    contextWindow,
    model,
    turns: result?.num_turns ?? null,
  };
}
