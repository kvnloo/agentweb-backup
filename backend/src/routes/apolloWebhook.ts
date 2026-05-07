/**
 * Apollo run_waterfall_email async result webhook.
 *
 * Mounted on a PUBLIC path (before crmRoutes' auth middleware) because Apollo
 * doesn't send a JWT — they just POST to the webhook URL we hand them. Auth is
 * the shared `X-Apollo-Webhook-Secret` request header, compared in constant
 * time against getApolloWebhookSecret(). Headers (not query strings) so the
 * secret never lands in nginx access logs or load-balancer traces.
 *
 *   POST /api/crm/webhooks/apollo
 *   X-Apollo-Webhook-Secret: <webhookSecret>
 *
 * The placeholder cache row written by Tier 3 (apollo:async_request:<request_id>)
 * maps the request_id back to a specific lead. We never overwrite an existing
 * email — the lead may have been filled by Tier 1/2/4 in the meantime.
 */

import express, { Request, Response, Router } from 'express';
import { timingSafeEqual } from 'crypto';
import { crmDb } from '../services/db';
import { apolloAsyncRequestCacheKey } from '../services/apolloCacheKeys';
import { getApolloWebhookSecret } from '../utils/secretsManager';

/**
 * Constant-time header secret check. Returns false for length mismatches
 * without ever leaking that information through compare timing — Buffer
 * lengths are equalised by padding before timingSafeEqual.
 */
function safeSecretEquals(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) {
    // Still run the compare against `b` to spend roughly the same time as a
    // success path — the result is discarded.
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

const router: Router = express.Router();

interface ApolloWebhookPayload {
  request_id?: string;
  person?: {
    id?: string;
    email?: string;
    email_status?: string;
  };
  email?: string;
  email_status?: string;
}

router.post('/', async (req: Request, res: Response) => {
  try {
    const expectedSecret = await getApolloWebhookSecret().catch(() => null);
    if (!expectedSecret) {
      console.warn('[apollo webhook] webhook secret not configured — refusing');
      return res.status(503).json({ message: 'webhook not configured' });
    }
    // Header-based auth. Express lower-cases header names; supertest preserves
    // case. Read both forms defensively.
    const headerVal = req.header('X-Apollo-Webhook-Secret') ?? req.header('x-apollo-webhook-secret') ?? '';
    if (!headerVal || !safeSecretEquals(headerVal, expectedSecret)) {
      return res.status(401).json({ message: 'invalid webhook secret' });
    }

    const payload: ApolloWebhookPayload = req.body ?? {};
    const requestId = payload.request_id;
    if (!requestId || typeof requestId !== 'string') {
      return res.status(400).json({ message: 'missing request_id' });
    }

    const key = apolloAsyncRequestCacheKey({ requestId });
    if (!key) return res.status(400).json({ message: 'invalid request_id' });
    const placeholder = await crmDb.getEnrichmentCacheItem(key.canonicalId, key.sk);
    if (!placeholder || placeholder.cacheType !== 'apollo' || !placeholder.rawData?.listId) {
      console.warn('[apollo webhook] no placeholder for request_id', requestId);
      return res.status(202).json({ accepted: true, matched: false });
    }
    const { listId, leadId, userId: placeholderUserId } = placeholder.rawData;

    // C1: re-verify ownership. The placeholder is our own write (Tier 3 stamps
    // userId before handing the URL to Apollo), so a missing or mismatched
    // userId means: legacy placeholder pre-this-fix, the lead/list moved
    // between tenants, or a forged/replayed placeholder. Refuse to write.
    if (!placeholderUserId) {
      console.warn('[apollo webhook] placeholder missing userId — refusing to write', requestId);
      return res.status(202).json({ accepted: true, matched: false });
    }
    const list: any = await crmDb.getLeadListById(listId).catch(() => null);
    if (!list || list.userId !== placeholderUserId) {
      console.warn('[apollo webhook] list missing or owner changed since Tier 3 — refusing', requestId);
      return res.status(202).json({ accepted: true, matched: false });
    }
    const lead: any = await crmDb.getLeadById(listId, leadId);
    if (!lead) {
      return res.status(202).json({ accepted: true, matched: false, leadDeleted: true });
    }

    if (lead.email && lead.enrichmentMetadata?.email?.apolloRequestId === requestId) {
      return res.status(200).json({ accepted: true, matched: true, alreadyProcessed: true });
    }

    const email = payload.person?.email ?? payload.email;
    const emailStatus = payload.person?.email_status ?? payload.email_status;
    if (!email) {
      return res.status(200).json({ accepted: true, matched: true, hadEmail: false });
    }
    if (lead.email) {
      return res.status(200).json({ accepted: true, matched: true, hadEmail: true, skipped: 'lead already has email' });
    }

    const status = (emailStatus ?? '').toLowerCase();
    const confidence: 'high' | 'medium' | 'low' =
      status === 'verified' ? 'high' :
      status === 'guessed' ? 'low' :
      'medium';
    const newMeta: Record<string, any> = { ...((lead.enrichmentMetadata ?? {}) as Record<string, any>) };
    newMeta.email = {
      source: 'web_search',
      provider: 'apollo',
      confidence,
      enrichedAt: new Date().toISOString(),
      sourceQuote: `Apollo waterfall (${status || 'unknown'})`,
      apolloRequestId: requestId,
    };
    await crmDb.updateLead(listId, leadId, { email, enrichmentMetadata: newMeta });
    return res.status(200).json({ accepted: true, matched: true, hadEmail: true, listId, leadId });
  } catch (err: any) {
    console.error('[apollo webhook] error:', err);
    return res.status(500).json({ message: err.message || 'webhook processing failed' });
  }
});

export default router;
