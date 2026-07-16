import { createHash } from 'crypto';
import { humanEvalService, type HumanEvalAction, type HumanEvalCandidate, type HumanEvalReviewType } from './humanEvalService';
import { settingsService } from './settingsService';

export interface AutoHumanEvalInput {
  reviewType: HumanEvalReviewType;
  outputSummary: string;
  sourceKey: string;
  userId?: string;
  sessionId?: string;
  agentRunId?: string;
  artifactUrl?: string;
  chatUrl?: string;
  originalRequest?: string;
  action?: HumanEvalAction;
  /**
   * Ad vs Organic Post use-case tag (ENG-90). Set it only when the enqueueing
   * flow knows its use case; ambiguous flows omit it and the candidate is
   * stored fail-open as 'uncategorized'.
   */
  category?: string;
}

function dedupeSettingKey(sourceKey: string): string {
  const digest = createHash('sha256').update(sourceKey).digest('hex').slice(0, 32);
  return `human_eval_auto_${digest}`;
}

/**
 * Best-effort automatic human-eval enqueue.
 *
 * Artifact creation must never fail because Slack/settings/eval storage is down.
 * We dedupe by stable source keys (session+filename, landing-page id, enrichment
 * run id) after a successful enqueue so retries do not spam the eval channel.
 */
export async function enqueueAutoHumanEval(
  input: AutoHumanEvalInput,
): Promise<HumanEvalCandidate | null> {
  if (process.env.AUTO_HUMAN_EVAL_DISABLED === 'true') return null;

  const outputSummary = input.outputSummary?.trim();
  const sourceKey = input.sourceKey?.trim();
  if (!outputSummary || !sourceKey) return null;

  const settingKey = dedupeSettingKey(sourceKey);

  try {
    const existing = await settingsService.getSetting(settingKey);
    if (existing?.settingValue) return null;

    const candidate = await humanEvalService.createCandidate({
      reviewType: input.reviewType,
      outputSummary,
      userId: input.userId,
      sessionId: input.sessionId,
      agentRunId: input.agentRunId,
      artifactUrl: input.artifactUrl,
      chatUrl: input.chatUrl,
      originalRequest: input.originalRequest,
      action: input.action,
      category: input.category,
    });

    await settingsService.setSetting(
      settingKey,
      candidate.candidateId,
      `Automatic human eval candidate for ${sourceKey}`,
      'auto-human-eval',
    );

    return candidate;
  } catch (err: any) {
    console.warn('[auto-human-eval] enqueue failed:', err?.message || err);
    return null;
  }
}
