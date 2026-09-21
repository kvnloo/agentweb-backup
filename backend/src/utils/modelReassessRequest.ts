/**
 * ENG-1565 — closes a silent no-op: model resolution reads ONLY the request's
 * `llmModel` field (agentModeController.ts's `resolveEffectiveModelForUser` call,
 * fed from `req.body.llmModel`/the model picker). No code path parses chat message
 * text for an intent to switch/reassess models — so a prose instruction like
 * "reassess using a new model" is inert by construction. Production evidence:
 * session e6c9e693-ff33-4883-a18a-9d674b4074c4 (2026-08-25), audited on ENG-426 —
 * the user asked in chat to reassess with a new model; the next turn silently
 * resolved the SAME model with no acknowledgement that nothing changed.
 *
 * This does not build in-chat model switching (a materially larger feature —
 * intent parsing, wiring to the picker/session state, confirmation UX). It closes
 * the silence only: when the message reads as a model-change request AND the turn
 * that follows ran on the same model as before, say so explicitly instead of
 * continuing as if the request was actioned.
 *
 * Same append-only, pure `(content, ...) => content` shape as its neighbours at
 * the finalize point in agentModeService.ts: `reconcileFalseFailureReport`
 * (ENG-971, ../../utils/falseFailureReport.ts) and `reconcileUnconsumedCursors`
 * (ENG-1207 AC3, ./agentMode/core/unconsumedCursor.ts).
 */

interface AttributableMessage {
  role?: string;
  llm?: string;
}

/**
 * Deliberately biased toward precision over recall: "model" is an overloaded word
 * ("pricing model", "business model", "data model"), and a false positive here
 * tells the user something false ("the model didn't change") about a message that
 * was never about models at all. A missed real request just leaves today's
 * silence — the same as before this fix, not a regression. Requires an
 * action verb followed, within a short window, by "a/an new/different/another/
 * other model(s)" — or the bare imperative "switch/change models".
 */
const MODEL_CHANGE_REQUEST_PATTERN =
  /\b(?:reassess|switch|change|try|use|pick|select)\b[^.!?\n]{0,40}\b(?:a\s+|an\s+)?(?:new|different|another|other)\s+models?\b|\b(?:switch|change)\s+models\b/i;

/**
 * CodeRabbit (PR #2642): the base pattern alone matches "Do not switch to a
 * different model" and "What does it mean to switch to a different model?" —
 * neither is a request. Same precision-over-recall bias as the base pattern:
 * reject rather than guess.
 */
const NEGATION_PATTERN =
  /\b(?:don't|do not|doesn't|does not|didn't|did not|never|won't|will not|wouldn't|would not|shouldn't|should not|can't|cannot|no need to)\b/i;

const EXPLANATORY_QUESTION_PATTERN =
  /\b(?:what does|what is|what would|why would|how does|how would|can you explain|explain what|what happens)\b[^.!]*\?/i;

/**
 * Exported (ENG-1205) so the named-model detector in ./modelMentionRequest.ts
 * applies the SAME two guards rather than growing a second, drifting copy of
 * them. "Don't switch to Opus 5" and "what would switching to Opus 5 do?" are
 * not requests, whichever detector reads them.
 */
export function hasNegation(messageContent: string): boolean {
  return NEGATION_PATTERN.test(messageContent);
}

export function isExplanatoryQuestion(messageContent: string): boolean {
  return EXPLANATORY_QUESTION_PATTERN.test(messageContent);
}

export function looksLikeModelChangeRequest(messageContent: string | null | undefined): boolean {
  if (!messageContent || typeof messageContent !== 'string') return false;
  if (!MODEL_CHANGE_REQUEST_PATTERN.test(messageContent)) return false;
  if (hasNegation(messageContent)) return false;
  if (isExplanatoryQuestion(messageContent)) return false;
  return true;
}

/**
 * The model that generated the last assistant turn in the session's prior
 * history — "before" for the purposes of "did the model actually change".
 * `msg.llm` is stamped in chatbotService.ts when a turn is persisted (same
 * field `sessionModelAttribution.ts` reads for ENG-1579's per-session
 * attribution). Null when history is empty or no assistant turn recorded one
 * (older sessions, pre-attribution) — callers must treat null as "unknown",
 * never as "unchanged".
 */
export function findLastAssistantModel(
  messages: readonly AttributableMessage[] | null | undefined,
): string | null {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== 'assistant') continue;
    return typeof msg.llm === 'string' && msg.llm ? msg.llm : null;
  }
  return null;
}

function buildModelUnchangedAck(modelAfter: string): string {
  return (
    "Note: I can't switch models from a chat message — this reply still ran on " +
    `the same model as before (\`${modelAfter}\`). To use a different model, pick ` +
    'it from the model selector before sending your next message.'
  );
}

/**
 * Append-only: never rewrites `content`, only adds a trailing note, and only when
 * every condition holds. `modelBefore`/`modelAfter` being anything other than two
 * equal, known strings means either the request is unrelated to models, unknown
 * history (nothing to compare against), or the model DID change (e.g. the picker
 * was flipped in the same request that also carried this text) — none of those
 * are the silent no-op this guards against, so stay quiet.
 */
export function reconcileModelReassessAck(
  content: string,
  messageContent: string | null | undefined,
  modelBefore: string | null | undefined,
  modelAfter: string | null | undefined,
): string {
  if (!content) return content;
  if (!modelBefore || !modelAfter || modelBefore !== modelAfter) return content;
  if (!looksLikeModelChangeRequest(messageContent)) return content;
  return `${content}\n\n${buildModelUnchangedAck(modelAfter)}`;
}
