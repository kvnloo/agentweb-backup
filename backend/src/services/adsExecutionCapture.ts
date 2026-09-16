import { getLearningRecommendations, attachExecutionReceipt } from './adsLearningDb';
/** Called only after the existing provider read-back proves a creative swap. The recommendation
 * still does not authorize execution; the existing confirmation path owns that decision. */
export async function observeVerifiedCreativeExecution(input: {
  userId: string; accountId: string; adId: string; creativeId: string; verified: boolean; now: string;
}): Promise<void> {
  if (process.env.ADS_LEARNING_MODE === 'off' || input.verified !== true || !input.creativeId) return;
  const deadline = Date.now() + 100;
  try {
    const page = await getLearningRecommendations('meta', input.accountId, 50);
    if (page.truncated) throw new Error('Incomplete receipt candidates');
    const rows = page.rows.filter(r => r.status === 'pending' && !r.context?.execution && r.context?.clientUserId === input.userId &&
      r.context.adId === input.adId && r.createdAt <= input.now && r.evaluationDate > input.now)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.recommendationId.localeCompare(b.recommendationId));
    // Only the newest window per measurement grain; one execution is never counted as many samples.
    const seen = new Set<string>();
    for (const r of rows) {
      if (seen.has(r.context!.metricScope)) continue;
      seen.add(r.context!.metricScope);
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('Receipt deadline exceeded');
      await attachExecutionReceipt(r, { reference: `meta:ad:${input.adId}:creative:${input.creativeId}`,
        clientUserId: input.userId, platform: 'meta', accountId: input.accountId, campaignId: r.context!.campaignId,
        recommendationId: r.recommendationId, executedAt: input.now, status: 'succeeded', adopted: true }, remaining);
    }
  } catch {
    console.error('[AdsLearning] execution receipt unavailable', { adId: input.adId });
  }
}
