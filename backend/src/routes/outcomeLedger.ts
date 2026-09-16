/**
 * ENG-1550 — outcome ledger API.
 *
 * Three routes over `services/outcomeLedger*`: read own history, record a prediction, score a
 * pending one.
 *
 * ─── Authorisation ──────────────────────────────────────────────────────────────────────────
 *
 * READ is owner-scoped, same `resolveOwnedAccount` shape as `adsThresholds.ts` — a customer can
 * see the agent's track record on their own account. WRITE (record + score) is `requireAdmin`,
 * not owner-scoped: unlike a threshold, a recommendation is not something a customer sets — it is
 * the agent's own prediction about itself, and letting a caller mint or resolve its own scored
 * verdicts would let them rewrite the agent's track record. The loop system that actually
 * generates recommendations calls the service functions directly (not through HTTP) once it
 * exists; these admin routes exist for manual recording/scoring and ops visibility in the
 * meantime — same staged rollout ENG-918 used (store + API first, consumer wired separately).
 */

import express from 'express';
import { randomUUID } from 'crypto';
import { authenticateToken, requireAdmin } from '../middleware/auth';
import { userDb } from '../services/db';
import { cleanAccountId, getConnectedMetaAccountsList } from '../services/metaAccountCredentials';
import {
  createRecommendation,
  scoreRecommendation,
  applyScore,
  type OutcomePlatform,
} from '../services/outcomeLedger';
import { getRecommendationsForAccount, getRecommendation, putNewRecommendation, putScoredRecommendation } from '../services/outcomeLedgerDb';

const router = express.Router();

/** Same shape and same reasoning as `adsThresholds.ts`'s `resolveOwnedAccount` — re-fetches the
 * user fresh rather than trusting token-decode-time state, and only 'meta' has a resolver wired. */
async function resolveOwnedAccount(
  userId: string,
  platform: string,
  accountId: string,
): Promise<{ ok: true; accountId: string; platform: OutcomePlatform } | { ok: false; status: number; error: string }> {
  if (platform !== 'meta') {
    return {
      ok: false,
      status: 400,
      error: `platform '${platform}' is not supported yet — only 'meta' has a connected-account ownership check`,
    };
  }

  const user = await userDb.getUserById(userId);
  if (!user) return { ok: false, status: 404, error: 'User not found' };

  const cleaned = cleanAccountId(accountId);
  const owned = getConnectedMetaAccountsList(user).some((acc: any) => acc.accountId === cleaned);
  if (!owned) {
    return { ok: false, status: 403, error: 'Ad account is not one of your connected accounts' };
  }

  return { ok: true, accountId: cleaned, platform: 'meta' };
}

/**
 * GET /api/outcome-ledger/:platform/:accountId
 *
 * Every recommendation recorded for this account, pending and scored alike.
 */
router.get('/:platform/:accountId', authenticateToken, async (req: any, res) => {
  try {
    const owned = await resolveOwnedAccount(req.user.userId, req.params.platform, req.params.accountId);
    if (!owned.ok) return res.status(owned.status).json({ error: owned.error });

    const recommendations = (await getRecommendationsForAccount(owned.platform, owned.accountId))
      // Shared platform accounts do not grant access to another client's captured rationale.
      // Existing connected-account ownership proves access to the account, not to a legacy
      // row. createdBy is an admin/execution actor, not its client. Ambiguous rows fail closed.
      .filter(r => r.context?.clientUserId === req.user.userId);
    res.json({ platform: owned.platform, accountId: owned.accountId, recommendations });
  } catch (error: any) {
    console.error('[ENG-1550] read outcome ledger failed:', error);
    res.status(500).json({ error: 'Failed to read outcome ledger' });
  }
});

/** Bounded scoped guidance; account ownership and client identity are server-derived. */
router.get('/:platform/:accountId/learning', authenticateToken, async (req: any, res) => {
  try {
    const owned = await resolveOwnedAccount(req.user.userId, req.params.platform, req.params.accountId);
    if (!owned.ok) return res.status(owned.status).json({ error: owned.error });
    if (req.query.campaignId !== undefined && (typeof req.query.campaignId !== 'string' || !req.query.campaignId.trim() || req.query.campaignId.length > 2000)) {
      return res.status(400).json({ error: 'Invalid campaign scope' });
    }
    const { getScopedLearning } = await import('../services/adsLearningDb');
    const lessons = await getScopedLearning({ userId: req.user.userId, accountId: owned.accountId, platform: owned.platform,
      campaignId: typeof req.query.campaignId === 'string' ? req.query.campaignId : undefined, now: new Date().toISOString() });
    res.json({ mode: 'shadow', lessons });
  } catch { res.status(503).json({ error: 'Learning unavailable' }); }
});

/** Explicit review/rollback only; the scheduler has no authority to call this. */
router.post('/:platform/:accountId/learning/:memoryId/:action', authenticateToken, async (req: any, res) => {
  try {
    const owned = await resolveOwnedAccount(req.user.userId, req.params.platform, req.params.accountId);
    if (!owned.ok) return res.status(owned.status).json({ error: owned.error });
    if (!['approve', 'revert'].includes(req.params.action)) return res.status(400).json({ error: 'Invalid review action' });
    const targetScope = req.body?.scope ?? 'campaign';
    if (!['client', 'campaign', 'channel'].includes(targetScope)) return res.status(400).json({ error: 'Invalid learning scope' });
    const { reviewLearning } = await import('../services/adsLearningReview');
    const result = await reviewLearning({ userId: req.user.userId, accountId: owned.accountId, platform: owned.platform,
      campaignId: typeof req.body?.campaignId === 'string' ? req.body.campaignId : undefined, now: new Date().toISOString() },
      req.params.memoryId, req.params.action, targetScope);
    return res.status(result.applied ? 200 : 409).json(result);
  } catch { res.status(409).json({ error: 'Learning review could not be applied' }); }
});

router.post('/:platform/:accountId/:recommendationId/decline', authenticateToken, async (req: any, res) => {
  try {
    const owned = await resolveOwnedAccount(req.user.userId, req.params.platform, req.params.accountId);
    if (!owned.ok) return res.status(owned.status).json({ error: owned.error });
    const r = await getRecommendation(owned.platform, owned.accountId, req.params.recommendationId);
    if (!r?.context || r.context.clientUserId !== req.user.userId) return res.status(404).json({ error: 'Recommendation not found' });
    if (r.status !== 'pending' || r.context.execution) return res.status(409).json({ error: 'Recommendation already resolved' });
    const { attachExecutionReceipt } = await import('../services/adsLearningDb');
    await attachExecutionReceipt(r, { reference: `decline:${req.user.userId}:${r.recommendationId}`, clientUserId: req.user.userId,
      platform: owned.platform, accountId: owned.accountId, campaignId: r.context.campaignId, recommendationId: r.recommendationId,
      status: 'declined', adopted: false, executedAt: new Date().toISOString() }, 1500);
    res.json({ adopted: false });
  } catch { res.status(409).json({ error: 'Recommendation could not be declined' }); }
});

/**
 * POST /api/outcome-ledger/:platform/:accountId
 *
 * Record a new prediction. `recommendationId` is server-minted (`randomUUID`), not accepted from
 * the body — the caller states what it predicted, not what its own audit-trail key should be.
 */
router.post('/:platform/:accountId', authenticateToken, requireAdmin, async (req: any, res) => {
  try {
    if (req.params.platform !== 'meta' && req.params.platform !== 'google_ads') {
      return res.status(400).json({ error: `platform '${req.params.platform}' is not supported` });
    }
    const { hypothesis, predictedMetric, predictedDirection, predictedMagnitudePct, evaluationDate } = req.body ?? {};

    const recommendation = createRecommendation({
      accountId: cleanAccountId(req.params.accountId),
      platform: req.params.platform,
      recommendationId: randomUUID(),
      hypothesis,
      predictedMetric,
      predictedDirection,
      predictedMagnitudePct,
      evaluationDate,
      createdAt: new Date().toISOString(),
      createdBy: req.user.userId,
    });

    await putNewRecommendation(recommendation);
    res.status(201).json(recommendation);
  } catch (error: any) {
    // createRecommendation's own input validation (empty hypothesis, non-finite magnitude) throws
    // a plain Error — surfaced as 400 since it describes a malformed request, not a server fault.
    console.error('[ENG-1550] record recommendation failed:', error);
    res.status(400).json({ error: error?.message ?? 'Failed to record recommendation' });
  }
});

/**
 * POST /api/outcome-ledger/:platform/:accountId/:recommendationId/score
 *
 * Score a pending recommendation against a caller-supplied actual. The route does not read the
 * metrics store itself — the caller supplies `actualValue`/`baselineValue` (or omits them to
 * report "no data") — keeping this route's job to persistence/authorisation and leaving the
 * metric read (which store, which window) to whatever surface calls it, mirroring how `evidence`
 * is supplied rather than derived in `adsThresholds.ts`'s PUT route.
 */
router.post('/:platform/:accountId/:recommendationId/score', authenticateToken, requireAdmin, async (req: any, res) => {
  try {
    if (req.params.platform !== 'meta' && req.params.platform !== 'google_ads') {
      return res.status(400).json({ error: `platform '${req.params.platform}' is not supported` });
    }
    const accountId = cleanAccountId(req.params.accountId);
    const existing = await getRecommendation(req.params.platform, accountId, req.params.recommendationId);
    if (!existing) return res.status(404).json({ error: 'Recommendation not found' });
    if (existing.status !== 'pending') {
      return res.status(409).json({ error: 'Recommendation has already been scored', reason: 'already_scored' });
    }
    // The manual scorer has no attribution/evidence contract and cannot establish ad-level
    // outcomes from ENG-916's campaign metrics. Keep shadow captures pending until a supported
    // evaluator exists; do not let a manual numeric pair fabricate a causal verdict.
    if (existing.context) {
      return res.status(409).json({ error: 'Shadow recommendation requires attributed evaluation', reason: 'attributed_evaluation_required' });
    }

    const { adopted, actualValue, baselineValue } = req.body ?? {};
    if (typeof adopted !== 'boolean') {
      return res.status(400).json({ error: 'adopted must be a boolean' });
    }
    // No NaN/Infinity guard needed here: JSON cannot represent either (both serialize to `null`),
    // so an HTTP caller can never produce a non-finite `typeof 'number'` value in `req.body` — the
    // finiteness guard belongs in `scoreRecommendation` itself, which is reachable by any future
    // non-HTTP caller too, not duplicated here where it could never actually fire.

    const score = scoreRecommendation({
      recommendation: existing,
      now: new Date().toISOString(),
      adopted,
      actualValue: typeof actualValue === 'number' ? actualValue : null,
      baselineValue: typeof baselineValue === 'number' ? baselineValue : null,
    });

    const scored = applyScore(existing, score);
    await putScoredRecommendation(scored);
    res.json(scored);
  } catch (error: any) {
    // A concurrent second scorer can race past the pending-status pre-check above; the DB layer's
    // own condition expression still rejects it, but as a bare Error rather than the friendly 409
    // the pre-check path returns for the identical logical situation. Recognised here so both
    // paths through "this was already scored" produce the same status code.
    if (error instanceof Error && error.message.includes('is not pending')) {
      return res.status(409).json({ error: error.message, reason: 'already_scored' });
    }
    console.error('[ENG-1550] score recommendation failed:', error);
    res.status(500).json({ error: 'Failed to score recommendation' });
  }
});

export default router;
