/**
 * Corrected per-session model attribution.
 *
 * `session.llmModel` is only the model picker's last stored SELECTION, not
 * provenance — it says nothing about which model actually generated each
 * turn. A session can (and does, in production) run on one model, hit a
 * hard stop, and continue on a completely different model without
 * `llmModel` ever reflecting the switch — see ENG-892/ENG-1313 for the
 * incidents this caused (a daily report and a support investigation both
 * drew conclusions from the wrong model because they read `llmModel`).
 *
 * This derives the real attribution from the transcript: each assistant
 * message that recorded a model (`msg.llm`, stamped in
 * chatbotService.ts when the turn is persisted) contributes to
 * `generationModels`. Extracted from apiTools.ts's `get_chat_history`
 * handler, which already computed this correctly for the aggregate report
 * — this makes the same correction available anywhere a single session is
 * read, not just the aggregate report.
 */

export interface SessionModelAttribution {
  /** Models that actually generated an assistant turn, derived from the transcript. Null when no message recorded one. */
  generationModels: string[] | null;
  /**
   * The model(s) to name for this session — already resolved, do not
   * re-derive from llmModel/generationModels. Null only when nothing is
   * recorded at all.
   */
  attributedModels: string[] | null;
  /**
   * 'transcript' when every assistant turn recorded a model (trustworthy);
   * 'partial-transcript' when only some did (real but incomplete);
   * 'selection-only' when no turn recorded a model at all, so this fell
   * back to the picker (state as unverified whenever reported).
   */
  attributionBasis: 'transcript' | 'partial-transcript' | 'selection-only' | null;
  /**
   * The exact per-session model line to display — use verbatim, do not
   * compose your own from llmModel/attributedModels. "picker: X · ran: Y"
   * form when the picker disagrees with what ran (including when the
   * picker is one of several models that ran — a multi-model run is never
   * "agreement" with a single-value picker). Collapses to a single model
   * name when exactly one model ran and it is the picker, or when there is
   * nothing to contrast (selection-only). Carries its own
   * "(partial — N of M assistant turns unlabelled)" suffix when
   * attributionBasis is 'partial-transcript'. Null only when
   * attributedModels is null.
   */
  modelLine: string | null;
}

interface AttributableMessage {
  role?: string;
  llm?: string;
}

export function computeSessionModelAttribution(
  messages: AttributableMessage[] | undefined | null,
  llmModel: string | null | undefined,
): SessionModelAttribution {
  const generationModelsSet = new Set<string>();
  let unlabelledAssistantTurns = 0;
  let assistantTurnCount = 0;

  for (const msg of messages || []) {
    if (msg?.role !== 'assistant') continue;
    assistantTurnCount++;
    if (typeof msg?.llm === 'string' && msg.llm) {
      generationModelsSet.add(msg.llm);
    } else {
      unlabelledAssistantTurns++;
    }
  }

  const generationModels = generationModelsSet.size > 0 ? [...generationModelsSet] : null;
  const attributedModels: string[] | null = generationModelsSet.size > 0
    ? [...generationModelsSet]
    : (llmModel ? [llmModel] : null);
  const attributionBasis: SessionModelAttribution['attributionBasis'] =
    generationModelsSet.size > 0
      ? (unlabelledAssistantTurns > 0 ? 'partial-transcript' : 'transcript')
      : (llmModel ? 'selection-only' : null);
  const partialQualifier = attributionBasis === 'partial-transcript'
    ? ` (partial — ${unlabelledAssistantTurns} of ${assistantTurnCount} assistant turns unlabelled)`
    : '';
  const modelLine: string | null = attributedModels
    ? (llmModel && (attributedModels.length !== 1 || attributedModels[0] !== llmModel)
        ? `picker: ${llmModel} · ran: ${attributedModels.join(', ')}${partialQualifier}`
        : `${attributedModels.join(', ')}${partialQualifier}`)
    : null;

  return { generationModels, attributedModels, attributionBasis, modelLine };
}
