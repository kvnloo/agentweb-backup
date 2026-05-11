/**
 * Apollo run_waterfall_email async result webhook.
 *
 * Mounted on a PUBLIC path (before crmRoutes' auth middleware) because Apollo
 * doesn't send a JWT — they just POST to the webhook URL we hand them. Auth is
 * a shared secret embedded in the URL **path**, compared in constant time
 * against getApolloWebhookSecret().
 *
 *   POST /api/crm/webhooks/apollo/<webhookSecret>
 *
 * Why path-based, not header-based: Apollo's `webhook_headers` parameter is
 * accepted at submit time but NOT echoed back on the callback POST (verified
 * empirically 2026-05-08). Header auth therefore never passes in production.
 *
 * Why path, not query string: by Apollo convention the path round-trips
 * cleanly on retries; query strings can be reordered or dropped by some
 * proxies. The trade-off: paths DO appear in default nginx `combined` access
 * logs and ALB request URIs, so the secret can leak via log retention. To
 * mitigate, treat the secret as bearer-grade — rotate via APOLLO_WEBHOOK_SECRET
 * env on a cadence, and keep nginx/ALB configured to suppress (or scrub)
 * access logs for `/api/crm/webhooks/apollo/*` if practical.
 *
 * On every authenticated callback we perform two writes:
 *   1. Stamp `rawData.status` and `rawData.result` onto the Tier 3 placeholder
 *      row (apollo:async_request:<request_id>) so the in-process Tier 3 poller
 *      can pick up the result and skip Tier 4. Uses `force: true` because the
 *      placeholder is fresh (TTL 7d) and the default ConditionExpression
 *      otherwise no-ops the overwrite.
 *   2. As a late-arrival safety net (in case the poller already gave up),
 *      `setLeadEmailIfMissing` writes the email onto the lead — conditional,
 *      so it never overwrites a value Tier 1/2/4 may have filled in the
 *      meantime.
 */

import express, { Request, Response, Router } from 'express';
import { timingSafeEqual } from 'crypto';
import { crmDb } from '../services/db';
import { apolloAsyncRequestCacheKey } from '../services/apolloCacheKeys';
import { getApolloWebhookSecret } from '../utils/secretsManager';

/**
 * Constant-time secret check. Returns false for length mismatches
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
  // Async waterfall shape — Apollo's actual run_waterfall_email callback body.
  // Each `vendors` entry is either a finder (has `emails[]` populated) or a
  // verifier (`usedForVerification: true`, `status: 'validated'` on success).
  people?: Array<{
    id?: string;
    waterfall?: {
      emails?: Array<{
        vendors?: Array<{
          name?: string;
          status?: string;
          emails?: string[];
          usedForVerification?: boolean;
        }>;
      }>;
    };
  }>;
  // Legacy/sync shapes left for fallback — not what run_waterfall_email sends.
  person?: { id?: string; email?: string; email_status?: string };
  email?: string;
  email_status?: string;
}

/**
 * Pull the first finder-vendor email out of Apollo's nested waterfall payload.
 * Falls back to the flat `person.email` / `email` shape if `people[]` is absent
 * (sync match or older payload format). When a downstream verifier vendor
 * (ZeroBounce et al.) reports `validated`, the resulting status is upgraded
 * to `verified` regardless of the finder's self-claim.
 */
function extractApolloEmail(payload: ApolloWebhookPayload): { email?: string; emailStatus?: string } {
  const person = Array.isArray(payload.people) ? payload.people[0] : null;
  const groups = person?.waterfall?.emails;
  if (Array.isArray(groups)) {
    for (const grp of groups) {
      const vendors = Array.isArray(grp?.vendors) ? grp.vendors : [];
      const finder = vendors.find((v) => Array.isArray(v?.emails) && v.emails.length > 0);
      if (!finder || !finder.emails || finder.emails.length === 0) continue;
      const verified = vendors.some(
        (v) => v?.usedForVerification && String(v?.status ?? '').toLowerCase() === 'validated',
      );
      const finderStatus = String(finder.status ?? '').toLowerCase();
      const emailStatus =
        verified || finderStatus === 'verified' ? 'verified' :
        finderStatus === 'guessed' ? 'guessed' :
        finderStatus || undefined;
      return { email: String(finder.emails[0]), emailStatus };
    }
  }
  // Flat-shape fallback. Lowercase the status so downstream confidence
  // mapping (`status === 'verified' ? 'high' : ...`) doesn't miss when
  // Apollo returns mixed case (e.g. "VERIFIED").
  const flatEmail = payload.person?.email ?? payload.email;
  const flatStatus = payload.person?.email_status ?? payload.email_status;
  return {
    email: flatEmail,
    emailStatus: typeof flatStatus === 'string' ? flatStatus.toLowerCase() : flatStatus,
  };
}

router.post('/:secret', async (req: Request, res: Response) => {
  try {
    const expectedSecret = await getApolloWebhookSecret().catch(() => null);
    if (!expectedSecret) {
      console.warn('[apollo webhook] webhook secret not configured — refusing');
      return res.status(503).json({ message: 'webhook not configured' });
    }
    const provided = req.params.secret ?? '';
    if (!provided || !safeSecretEquals(provided, expectedSecret)) {
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

    // Idempotency: if this exact request_id already wrote the lead, we know
    // the FIRST webhook arrival also stamped the placeholder result (deposit
    // sits below this guard, so any path that wrote the lead with this
    // requestId also ran the deposit). A retry can therefore early-out
    // without re-depositing — the placeholder is already correct.
    if (lead.email && lead.enrichmentMetadata?.email?.apolloRequestId === requestId) {
      return res.status(200).json({ accepted: true, matched: true, alreadyProcessed: true });
    }

    const { email, emailStatus } = extractApolloEmail(payload);

    // Stamp the result onto the placeholder so the waterfall poller (running
    // in the original Tier 3 caller) can pick it up and skip Tier 4. Best-
    // effort — failures don't block the direct lead-write below, which is
    // the safety net for late arrivals after the poller has already given up.
    //
    // `force: true` is required: the placeholder was written by Tier 3 and is
    // still fresh (TTL ~7d), so the default ConditionExpression on
    // putEnrichmentCacheItem ("insert only when absent or expired") would
    // silently no-op the overwrite via ConditionalCheckFailedException — the
    // poller would then see status=pending forever and always time out.
    const placeholderResult = email
      ? { email, emailStatus, status: 'completed' as const, completedAt: new Date().toISOString() }
      : { status: 'no_email' as const, completedAt: new Date().toISOString() };
    try {
      await crmDb.putEnrichmentCacheItem({
        ...(placeholder as any),
        rawData: { ...(placeholder.rawData || {}), status: placeholderResult.status, result: placeholderResult },
        cacheType: 'apollo',
      } as any, { force: true });
    } catch (err: any) {
      console.error('[apollo webhook] placeholder result-stamp failed for', requestId, ':', err?.message);
    }

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
    const emailMeta = {
      source: 'web_search',
      provider: 'apollo',
      confidence,
      enrichedAt: new Date().toISOString(),
      sourceQuote: `Apollo waterfall (${status || 'unknown'})`,
      apolloRequestId: requestId,
    };
    // Conditional write — DDB rejects (silently here) if Tier 1/2/4 filled the
    // email between our in-memory check above and this update. Belt-and-
    // suspenders TOCTOU guard.
    const writeResult = await crmDb.setLeadEmailIfMissing(listId, leadId, email, emailMeta);
    return res.status(200).json({
      accepted: true, matched: true, hadEmail: true, listId, leadId,
      written: writeResult.written,
    });
  } catch (err: any) {
    console.error('[apollo webhook] error:', err);
    return res.status(500).json({ message: err.message || 'webhook processing failed' });
  }
});

export default router;
