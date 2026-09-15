/** ENG-502 slice 1: shadow creative-refresh proposals from the existing fatigue assessment.
 * No LLM, ad-platform writes, account-memory writes, scoring, or threshold mutation.
 * Capture is create-once per client/account/ad/reporting window, using ENG-1550's condition.
 */
import { createHash } from 'crypto';
import { createRecommendation, getSettlingWindowDays, type Recommendation } from './outcomeLedger';
import { getRecommendation, putNewRecommendation, RecommendationExistsError } from './outcomeLedgerDb';

export interface FatigueCaptureInput {
  clientUserId: string;
  accountId: string;
  campaignIds: string[];
  ads: unknown[];
  fatigued: Array<{ id: string; reasons: string[] }>;
  now: string;
}
const text = (s: unknown): s is string => typeof s === 'string' && s.trim().length > 0;
const MAX_CAPTURE_PER_ASSESSMENT = 3;
const REQUEST_TIMEOUT_MS = 1500;
const numeric = (n: unknown): number => typeof n === 'number' || (typeof n === 'string' && n.trim() !== '') ? Number(n) : NaN;
const date = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) &&
  Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s;
function plusDays(s: string, days: number): string {
  return new Date(Date.parse(s) + days * 86_400_000).toISOString();
}

function proposal(input: FatigueCaptureInput, raw: unknown): Recommendation {
  const ad = raw as any;
  const current = ad?.current_insights?.data?.[0];
  const prior = ad?.prior_insights?.data?.[0];
  const currentCtr = numeric(current?.ctr);
  const priorCtr = numeric(prior?.ctr);
  if (!text(input.clientUserId) || !text(input.accountId) || !Number.isFinite(Date.parse(input.now)) ||
      !text(ad?.id) || !text(ad?.campaign_id) || !input.campaignIds.includes(ad.campaign_id) ||
      !date(current?.date_start) || !date(current?.date_stop) || !date(prior?.date_start) || !date(prior?.date_stop) ||
      prior.date_start > prior.date_stop || prior.date_stop >= current.date_start || current.date_start > current.date_stop ||
      current.date_stop > input.now.slice(0, 10) || !Number.isFinite(currentCtr) || !Number.isFinite(priorCtr) ||
      currentCtr <= 0 || priorCtr <= currentCtr || priorCtr > 100) {
    throw new Error('Incomplete campaign attribution or CTR evidence; no recommendation recorded');
  }
  const recommendationId = `fatigue_${createHash('sha256').update(JSON.stringify([
    input.clientUserId, 'meta', input.accountId, ad.campaign_id, ad.id, current.date_start, current.date_stop,
  ])).digest('hex')}`;
  // This is an explicitly uncalibrated recovery hypothesis, not a claim of causal evidence.
  // Its AD metric scope must never be scored against campaign-level ENG-916 snapshots.
  const evaluationDate = plusDays(`${current.date_stop}T23:59:59.999Z`, 14);
  return createRecommendation({
    platform: 'meta', accountId: input.accountId, recommendationId,
    hypothesis: 'Review refreshing the fatigued creative; a replacement may recover its prior-window CTR.',
    predictedMetric: 'ctr', predictedDirection: 'increase',
    predictedMagnitudePct: (priorCtr / currentCtr - 1) * 100,
    evaluationDate, createdAt: input.now, createdBy: 'emma:creative-fatigue',
    context: {
      version: 1, clientUserId: input.clientUserId, campaignId: ad.campaign_id, adId: ad.id,
      metricScope: 'ad', mode: 'shadow', source: 'assess_client_health',
      sourceWindow: { since: current.date_start, until: current.date_stop },
      rationale: 'The existing client-health CTR-drop detector flagged this creative against its resolved account threshold.',
      evidence: [
        { reference: `meta:${input.accountId}:${ad.campaign_id}:${ad.id}:${prior.date_start}/${prior.date_stop}`, metric: 'ctr', value: priorCtr },
        { reference: `meta:${input.accountId}:${ad.campaign_id}:${ad.id}:${current.date_start}/${current.date_stop}`, metric: 'ctr', value: currentCtr },
      ],
      assumptions: [
        'Refreshing creative requires approval and execution; adoption is unknown.',
        'Prior-window CTR is an uncalibrated recovery target, not a measured treatment effect.',
        'Spend, audience, placement and other interventions would need to be controlled before causal scoring.',
        'This is ad-level CTR; campaign snapshots cannot establish its outcome.',
      ],
      confidence: 'uncalibrated', reviewState: 'unreviewed',
      reviewAfter: plusDays(evaluationDate, getSettlingWindowDays('meta')),
    },
  });
}

/** Failure is observable and isolated per recommendation. The producing assessment stays usable.
 * A conditional conflict is a retry only after a strongly consistent read confirms the scope.
 * Never log an entire ad, token, client record, or exception from the platform boundary. */
export async function captureFatigueRecommendations(input: FatigueCaptureInput): Promise<void> {
  if (process.env.ADS_LEARNING_MODE === 'off') return;
  const findings = input.fatigued.filter(f => f.reasons.includes('ctr_drop'))
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (findings.length > MAX_CAPTURE_PER_ASSESSMENT) {
    console.warn('[AdsLearning] capture limited', { omitted: findings.length - MAX_CAPTURE_PER_ASSESSMENT });
  }
  // This shadow slice captures at most three proposals. The assessment still returns ALL
  // fatigue findings. Parallel bounded SDK requests cap added latency at two request timeouts.
  await Promise.all(findings.slice(0, MAX_CAPTURE_PER_ASSESSMENT).map(async finding => {
    try {
      const recommendation = proposal(input, input.ads.find((ad: any) => ad?.id === finding.id));
      try {
        await putNewRecommendation(recommendation, REQUEST_TIMEOUT_MS);
      } catch (error) {
        if (!(error instanceof RecommendationExistsError)) throw error;
        const existing = await getRecommendation('meta', input.accountId, recommendation.recommendationId, REQUEST_TIMEOUT_MS);
        const a = existing?.context;
        const b = recommendation.context!;
        if (!a || a.clientUserId !== b.clientUserId || a.campaignId !== b.campaignId || a.adId !== b.adId ||
            a.sourceWindow.since !== b.sourceWindow.since || a.sourceWindow.until !== b.sourceWindow.until) {
          throw new Error('Recommendation identity conflict');
        }
      }
      console.info('[AdsLearning] capture confirmed', { recommendationId: recommendation.recommendationId, mode: 'shadow' });
    } catch {
      console.error('[AdsLearning] capture failed', { source: 'assess_client_health', adId: finding.id });
    }
  }));
}
