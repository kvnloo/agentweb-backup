/**
 * ENG-1205 — make a model correction visible after a reload, not just on the
 * live turn.
 *
 * The customer portal learns about a correction from the generate response body
 * (`modelSelection`/`requestedModel`, `agentModeController.ts` res.json). That
 * covers the turn as it lands and nothing afterwards: the persisted message
 * carries `llm` but no policy reason, so a refresh left the badge saying
 * "Gemini 3.1 Flash Lite" with nothing explaining why it disagreed with the
 * picker — which is the ENG-1200 complaint one step removed.
 *
 * The fix needs no new plumbing. The controller already writes the full decision
 * onto the SESSION (`updateSessionLlmModel(..., toStoredModelPolicyDecision(...))`)
 * immediately before dispatch, and `generateMarketingResponse` re-reads that
 * session at the top of the run. So the turn's own decision is already in hand
 * at the point `responseMessage.llm` is stamped — the per-message provenance
 * seam ENG-892 established — and the correction can be stamped right beside it.
 */

export interface StoredPolicyDecision {
  requestedModel?: string | null;
  effectiveModel?: string | null;
  modelSelection?: string | null;
}

/** Identical shape to the customer portal's `ChatMessage.modelCorrection`. */
export interface MessageModelCorrection {
  requestedModel: string;
  effectiveModel: string;
}

/**
 * The correction to stamp on this turn's assistant messages, or null.
 *
 * Mirrors the portal's `resolveModelCorrection` (same three rejections: not
 * `corrected`, an incomplete pair, an equal pair) and adds one the portal does
 * not need:
 *
 * `llmUsagePolicyDecision` is a single slot on the session, overwritten every
 * turn. A run that did not write it — a resumed run, a replay, a scheduled turn
 * dispatched from a different path — would otherwise stamp a NEWER turn's
 * correction onto its own messages and misattribute the model. Requiring the
 * decision's `effectiveModel` to equal the model this turn actually ran on
 * makes a stale slot fail closed: no stamp, which is the pre-existing
 * behaviour, rather than a confident wrong one.
 */
export function resolveTurnModelCorrection(
  decision: StoredPolicyDecision | null | undefined,
  modelThatRan: string | null | undefined,
): MessageModelCorrection | null {
  if (!decision || !modelThatRan) return null;
  if (decision.modelSelection !== 'corrected') return null;
  const { requestedModel, effectiveModel } = decision;
  if (!requestedModel || !effectiveModel) return null;
  if (requestedModel === effectiveModel) return null;
  if (effectiveModel !== modelThatRan) return null;
  return { requestedModel, effectiveModel };
}
