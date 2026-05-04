/**
 * CRM routes for enrich.so:
 *
 *   POST /lists/:listId/leads/:leadId/validate-email
 *     Force-refresh validation for a single lead's email. Persists the result
 *     under customFields.email_validation with enrichmentMetadata.
 *
 *   POST /leads/lookup-by-email
 *     Reverse-lookup an email and return a draft lead profile (no persistence).
 *     Used by the "Quick Add by Email" UX in customer-portal.
 *
 * Mounted into the parent /api/crm router from crm.ts.
 */

import express, { Request, Response, Router } from 'express';
import { AuthenticatedRequest } from '../middleware/auth';
import { crmDb, userDb } from '../services/db';
import { getEnrichSoService } from '../services/enrichSoService';
import { QuotaExceededError, LookupByEmailQuotaExceededError, type QuotaTracker } from '../services/enrichSoQuota';
import { validateLeadsInBackground } from '../services/enrichSoLeadValidation';

// Conservative RFC-5322-ish check — sufficient to reject obvious garbage and
// catch typos. Real deliverability is what enrich.so checks; this is just a
// gate to prevent burning credits on `__proto__` etc.
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function isValidEmailFormat(email: string): boolean {
  return EMAIL_REGEX.test(email) && email.length <= 254;
}

// Quota tracker is owned by the EnrichSoService singleton; the route reaches
// it via this thin accessor so tests can inject a fake.
let _quotaForRoute: QuotaTracker | null = null;
export function setQuotaTrackerForLookupRoute(t: QuotaTracker | null): void {
  _quotaForRoute = t;
}
function getQuotaTracker(): QuotaTracker | null {
  return _quotaForRoute;
}

const router: Router = express.Router();

async function canAccessCrmList(
  userId: string,
  list: { userId: string } | Record<string, any>,
): Promise<boolean> {
  if (list.userId === userId) return true;
  const [user, owner] = await Promise.all([
    userDb.getUserById(userId),
    userDb.getUserById(list.userId),
  ]);
  return !!(user?.orgId && owner?.orgId && user.orgId === owner.orgId);
}

/**
 * POST /lists/:listId/leads/:leadId/validate-email
 * Body: (none)
 * Returns: { status, confidence, isCatchAll, fromCache, checkedAt }
 */
router.post('/lists/:listId/leads/:leadId/validate-email', async (req: Request, res: Response) => {
  const { listId, leadId } = req.params;
  const userId = (req as AuthenticatedRequest).user?.userId;
  if (!userId) return res.status(401).json({ message: 'Unauthorized' });

  try {
    const list = await crmDb.getLeadListById(listId);
    if (!list) return res.status(404).json({ message: 'Lead list not found' });
    if (!(await canAccessCrmList(userId, list as any))) {
      return res.status(403).json({ message: 'Access denied' });
    }
    const lead: any = await crmDb.getLeadById(listId, leadId);
    if (!lead) return res.status(404).json({ message: 'Lead not found' });
    if (!lead.email || !String(lead.email).trim()) {
      return res.status(400).json({ message: 'Lead has no email to validate' });
    }

    const result = await getEnrichSoService().validateEmail(lead.email, { forceRefresh: true, userId });

    // Use the targeted setLeadEmailValidation path (M4 fix) — updates only the
    // email_validation keys via DDB document-path SET, preserving sibling
    // customFields entries against concurrent user edits.
    const now = new Date().toISOString();
    const validation = {
      status: result.status,
      confidence: result.confidence,
      isCatchAll: result.isCatchAll,
      provider: result.provider,
      message: result.message,
      checkedAt: result.checkedAt,
    };
    const metadata = {
      source: 'web_search',
      confidence: result.confidence,
      enrichedAt: now,
      sourceQuote: `Email verification: ${result.message ?? result.status}`,
    };
    await crmDb.setLeadEmailValidation(listId, leadId, validation, metadata);

    return res.json({
      success: true,
      status: result.status,
      confidence: result.confidence,
      isCatchAll: result.isCatchAll,
      fromCache: result.fromCache,
      checkedAt: result.checkedAt,
    });
  } catch (error: any) {
    if (error instanceof QuotaExceededError) {
      return res.status(429).json({ message: error.message, endpoint: error.endpoint, limit: error.limit });
    }
    console.error('[CRM enrich.so] validate-email error:', error);
    return res.status(500).json({ message: error.message || 'Failed to validate email' });
  }
});

/**
 * POST /leads/find-email
 * Body: { firstName, lastName, domain?, company? }
 * Returns: { found, email?, confidence?, fromCache, checkedAt }
 *
 * Same auth + format gates as lookup-by-email; shares the same daily lookup
 * quota counter so the user can't burn extra credits via this route.
 */
router.post('/leads/find-email', async (req: Request, res: Response) => {
  const userId = (req as AuthenticatedRequest).user?.userId;
  if (!userId) return res.status(401).json({ message: 'Unauthorized' });

  const firstName = (req.body?.firstName ?? '').toString().trim();
  const lastName = (req.body?.lastName ?? '').toString().trim();
  const domainRaw = (req.body?.domain ?? '').toString().trim().toLowerCase();
  const company = (req.body?.company ?? '').toString().trim();

  if (!firstName && !lastName) {
    return res.status(400).json({ message: 'firstName or lastName is required' });
  }
  if (!domainRaw && !company) {
    return res.status(400).json({ message: 'domain or company is required' });
  }
  // If domain is supplied, sanity-check the format. Bare hostnames pass; URLs are stripped.
  let domain = domainRaw;
  if (domain) {
    domain = domain.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) {
      return res.status(400).json({ message: 'invalid domain format' });
    }
  }

  // Shared lookup quota.
  const tracker = getQuotaTracker();
  if (tracker) {
    try {
      await tracker.checkLookupByEmailQuota(userId);
    } catch (err: any) {
      if (err instanceof LookupByEmailQuotaExceededError) {
        return res.status(429).json({ message: err.message, limit: err.limit, scope: 'lookup' });
      }
      throw err;
    }
  }

  try {
    const result = await getEnrichSoService().findEmail(
      { firstName, lastName, domain: domain || undefined, company: domain ? undefined : company },
      { userId },
    );
    if (tracker) {
      try { await tracker.recordLookupByEmailUsage(userId); } catch (e) {
        console.error('[CRM enrich.so] recordLookupByEmail failed (find-email):', (e as Error).message);
      }
    }
    return res.json({
      found: result.found,
      email: result.email,
      confidence: result.confidence,
      isCatchAll: result.isCatchAll,
      fromCache: result.fromCache,
      checkedAt: result.checkedAt,
    });
  } catch (error: any) {
    if (error instanceof QuotaExceededError) {
      return res.status(429).json({ message: error.message, endpoint: error.endpoint, limit: error.limit });
    }
    console.error('[CRM enrich.so] find-email error:', error);
    return res.status(500).json({ message: error.message || 'Failed to find email' });
  }
});

/**
 * POST /lists/:listId/leads/validate-emails
 * Body: { leadIds?: string[] }  (omit → all leads in list)
 * Returns: 202 { queued: number, skipped: number }
 *
 * Kicks off background validation. Pills update on individual leads as each
 * call completes. Skipped count = leads with no email (or empty email).
 */
router.post('/lists/:listId/leads/validate-emails', async (req: Request, res: Response) => {
  const { listId } = req.params;
  const userId = (req as AuthenticatedRequest).user?.userId;
  if (!userId) return res.status(401).json({ message: 'Unauthorized' });

  const { leadIds } = req.body ?? {};
  if (leadIds !== undefined && !Array.isArray(leadIds)) {
    return res.status(400).json({ message: 'leadIds must be an array when provided' });
  }

  try {
    const list = await crmDb.getLeadListById(listId);
    if (!list) return res.status(404).json({ message: 'Lead list not found' });
    if (!(await canAccessCrmList(userId, list as any))) {
      return res.status(403).json({ message: 'Access denied' });
    }

    // Fetch the target leads. Distinguish three cases:
    //   - leadIds provided & non-empty → fetch those specific leads
    //   - leadIds provided & empty ([]) → no-op (explicit "validate nothing");
    //     prevents a buggy UI from silently re-validating every lead and burning quota
    //   - leadIds omitted (undefined) → fetch every lead in the list
    let targetLeads: Array<{ leadId: string; email?: string }> = [];
    if (Array.isArray(leadIds)) {
      if (leadIds.length === 0) {
        return res.status(202).json({ queued: 0, skipped: 0 });
      }
      const fetched = await Promise.all(
        leadIds.map((id: string) => crmDb.getLeadById(listId, id).catch(() => null)),
      );
      targetLeads = fetched.filter(Boolean).map((l: any) => ({ leadId: l.leadId, email: l.email }));
    } else {
      let lastKey: any = undefined;
      do {
        const page = await crmDb.getLeadsByListId(listId, 100, lastKey);
        for (const l of page.items) {
          targetLeads.push({ leadId: (l as any).leadId, email: (l as any).email });
        }
        lastKey = page.lastEvaluatedKey;
      } while (lastKey);
    }

    const validatable = targetLeads.filter((l) => l.email && l.email.trim());
    const skipped = targetLeads.length - validatable.length;

    // Fire and forget — pills update as each completes.
    void validateLeadsInBackground(listId, validatable, userId);

    return res.status(202).json({ queued: validatable.length, skipped });
  } catch (error: any) {
    console.error('[CRM enrich.so] validate-emails error:', error);
    return res.status(500).json({ message: error.message || 'Failed to queue email validation' });
  }
});

/**
 * POST /leads/lookup-by-email
 * Body: { email: string }
 * Returns: { found, draft: { firstName, lastName, company, title, linkedin, ... } }
 *
 * No persistence — the customer-portal Quick Add dialog uses this to pre-fill
 * the new-lead form for user review.
 */
router.post('/leads/lookup-by-email', async (req: Request, res: Response) => {
  const userId = (req as AuthenticatedRequest).user?.userId;
  if (!userId) return res.status(401).json({ message: 'Unauthorized' });

  const email = (req.body?.email ?? '').trim().toLowerCase();
  if (!email) return res.status(400).json({ message: 'email is required' });
  if (!isValidEmailFormat(email)) {
    return res.status(400).json({ message: 'invalid email format' });
  }

  // Tight per-route quota gate (50/day default). Independent from the
  // underlying reverseLookup API quota — this is what bounds abuse.
  const tracker = getQuotaTracker();
  if (tracker) {
    try {
      await tracker.checkLookupByEmailQuota(userId);
    } catch (err: any) {
      if (err instanceof LookupByEmailQuotaExceededError) {
        return res.status(429).json({ message: err.message, limit: err.limit, scope: 'lookup-by-email' });
      }
      throw err;
    }
  }

  try {
    const result = await getEnrichSoService().reverseLookup(email, { userId });
    if (tracker) {
      try { await tracker.recordLookupByEmailUsage(userId); } catch (e) {
        console.error('[CRM enrich.so] recordLookupByEmail failed:', (e as Error).message);
      }
    }
    if (!result.found) {
      return res.json({ found: false, draft: null });
    }
    return res.json({
      found: true,
      fromCache: result.fromCache,
      checkedAt: result.checkedAt,
      draft: {
        email,
        firstName: result.firstName,
        lastName: result.lastName,
        company: result.companyName,
        title: result.jobTitle,
        linkedin: result.profileUrl,
        location: result.location,
        headline: result.headline,
      },
    });
  } catch (error: any) {
    if (error instanceof QuotaExceededError) {
      return res.status(429).json({ message: error.message, endpoint: error.endpoint, limit: error.limit });
    }
    console.error('[CRM enrich.so] lookup-by-email error:', error);
    return res.status(500).json({ message: error.message || 'Failed to look up email' });
  }
});

export default router;
