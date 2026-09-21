import { getDueRecommendations, completeEvaluation, getLearningMetrics } from '../services/adsLearningDb';
import { hasLearningContext } from '../services/outcomeLedger';
import { getRecommendation } from '../services/outcomeLedgerDb';
import { evaluateSettledRecommendation } from '../services/adsOutcomeEvaluator';
import { adsMetricsDb } from '../services/adsMetricsDb';
let running = false;
let cursor: Record<string, any> | undefined;
/** Bounded page per tick; cursor rotates the backlog without an unbounded scan. Replica races
 * are resolved by the atomic pending→scored write, not by this process-local overlap guard. */
export async function runAdsLearningEvaluation(now = new Date()): Promise<void> {
  if (process.env.ADS_LEARNING_MODE === 'off' || running) return;
  running = true;
  try {
    const page = await getDueRecommendations(now, cursor);
    for (const candidate of page.rows) {
      try {
        const r = await getRecommendation(candidate.platform, candidate.accountId, candidate.recommendationId, 1500);
        if (!r || r.status !== 'pending' || r.platform !== 'meta' || !hasLearningContext(r)) continue;
        const c = r.context;
        let baseline = { rows: [], truncated: false } as Awaited<ReturnType<typeof adsMetricsDb.getSnapshotsByCampaign>>;
        let outcome = baseline;
        if (c?.metricScope === 'campaign' && c.execution?.adopted) {
          const days = (Date.parse(c.sourceWindow.until) - Date.parse(c.sourceWindow.since)) / 86400000 + 1;
          if (Number.isInteger(days) && days >= 7 && days <= 28) {
            baseline = await getLearningMetrics(r.platform, r.accountId, c.campaignId, c.sourceWindow.since.slice(0, 10), c.sourceWindow.until.slice(0, 10));
            outcome = await getLearningMetrics(r.platform, r.accountId, c.campaignId,
               new Date(Date.parse(r.evaluationDate.slice(0, 10)) - (days - 1) * 86400000).toISOString().slice(0, 10),
              r.evaluationDate.slice(0, 10));
          }
        }
        const scored = evaluateSettledRecommendation({ recommendation: r, now: now.toISOString(), receipt: c?.execution ?? null, baseline, outcome });
        if (scored) {
          await completeEvaluation(scored);
          console.info('[AdsLearning] evaluated', { recommendationId: r.recommendationId, verdict: scored.verdict });
        }
      } catch (error) {
        console.error('[AdsLearning] evaluation failed', { recommendationId: candidate.recommendationId,
          error: error instanceof Error ? error.name : 'unknown' });
      }
    }
    cursor = page.cursor;
    if (cursor) console.info('[AdsLearning] due backlog continues next tick');
  } finally { running = false; }
}
