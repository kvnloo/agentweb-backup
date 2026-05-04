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

// ─── Bulk operations on the whole list ───────────────────────────────────────
//
// All three "Validate / Find / Lookup" bulk endpoints follow the same shape:
//   1. Walk all leads in the list (paginated)
//   2. Filter to "applicable" ones based on what data the lead already has
//   3. Background-process each via the EnrichSoService (counts toward quota)
//   4. Write results back to the lead, but ONLY into empty fields so we never
//      clobber user-entered data
// They return 202 with { queued, skipped, alreadyProcessed }.

async function fetchAllLeads(listId: string): Promise<any[]> {
  const out: any[] = [];
  let lastKey: any = undefined;
  do {
    const page = await crmDb.getLeadsByListId(listId, 100, lastKey);
    out.push(...page.items);
    lastKey = page.lastEvaluatedKey;
  } while (lastKey);
  return out;
}

/**
 * Background bulk find-email — for leads with name + (company or website) but
 * no email, look up the email and write it back to the lead record. Does not
 * block the response. Failures per-lead are swallowed (logged).
 */
async function findEmailsForLeadsInBackground(
  listId: string,
  leads: any[],
  userId: string,
): Promise<void> {
  let svc;
  try { svc = getEnrichSoService(); } catch { return; }
  await Promise.allSettled(leads.map(async (lead) => {
    const firstName = (lead.firstName ?? '').trim();
    const lastName = (lead.lastName ?? '').trim();
    const company = (lead.company ?? '').trim();
    const website = (lead.website ?? '').trim();
    const domain = website
      ? website.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '')
      : '';
    if ((!firstName && !lastName) || (!domain && !company)) return;
    try {
      const r = await svc.findEmail(
        { firstName, lastName, domain: domain || undefined, company: domain ? undefined : company },
        { userId },
      );
      if (r.found && r.email) {
        await crmDb.updateLead(listId, lead.leadId, { email: r.email });
      }
    } catch (err) {
      console.error('[CRM enrich.so] bulk find-email failed for', lead.leadId, ':', (err as Error).message);
    }
  }));
}

/**
 * Background bulk reverse-lookup — for leads with email but missing one or
 * more profile fields (firstName/lastName/company/title/linkedin), fetch the
 * profile and fill ONLY the empty fields. Never overwrites user data.
 */
async function lookupProfilesForLeadsInBackground(
  listId: string,
  leads: any[],
  userId: string,
): Promise<void> {
  let svc;
  try { svc = getEnrichSoService(); } catch { return; }
  await Promise.allSettled(leads.map(async (lead) => {
    const email = (lead.email ?? '').trim();
    if (!email) return;
    try {
      const r = await svc.reverseLookup(email, { userId });
      if (!r.found) return;
      const updates: Record<string, string> = {};
      if (!lead.firstName && r.firstName) updates.firstName = r.firstName;
      if (!lead.lastName && r.lastName) updates.lastName = r.lastName;
      if (!lead.company && r.companyName) updates.company = r.companyName;
      if (!lead.title && r.jobTitle) updates.title = r.jobTitle;
      if (!lead.linkedin && r.profileUrl) updates.linkedin = r.profileUrl;
      if (Object.keys(updates).length > 0) {
        await crmDb.updateLead(listId, lead.leadId, updates as any);
      }
    } catch (err) {
      console.error('[CRM enrich.so] bulk lookup failed for', lead.leadId, ':', (err as Error).message);
    }
  }));
}

function isApplicableForFindEmail(lead: any): boolean {
  return !lead.email
    && (!!lead.firstName || !!lead.lastName)
    && (!!lead.company || !!lead.website);
}

function isApplicableForLookup(lead: any): boolean {
  if (!lead.email) return false;
  // Applicable when at least one profile field is missing
  return !lead.firstName || !lead.lastName || !lead.company || !lead.title || !lead.linkedin;
}

/**
 * GET /lists/:listId/leads/enrichment-counts
 * Returns counts that the bulk-confirm dialogs use to show "X will process,
 * Y already processed" before the user confirms. Cheap — just walks the
 * leads table once and tallies.
 */
router.get('/lists/:listId/leads/enrichment-counts', async (req: Request, res: Response) => {
  const { listId } = req.params;
  const userId = (req as AuthenticatedRequest).user?.userId;
  if (!userId) return res.status(401).json({ message: 'Unauthorized' });

  try {
    const list = await crmDb.getLeadListById(listId);
    if (!list) return res.status(404).json({ message: 'Lead list not found' });
    if (!(await canAccessCrmList(userId, list as any))) {
      return res.status(403).json({ message: 'Access denied' });
    }

    const leads = await fetchAllLeads(listId);
    const total = leads.length;
    const withEmail = leads.filter((l: any) => !!l.email).length;
    const validatePending = leads.filter((l: any) => l.email && !l.customFields?.email_validation).length;
    const validateAlreadyDone = withEmail - validatePending;
    const findPending = leads.filter(isApplicableForFindEmail).length;
    const lookupPending = leads.filter(isApplicableForLookup).length;
    // "Already processed" for find = leads that NOW have email (we can't tell
    // if it was provider-found or user-typed, but for UX showing how many are
    // "complete" is what matters).
    const findAlreadyDone = withEmail;
    // For lookup, "already done" = leads with all profile fields filled
    const lookupAlreadyDone = leads.filter((l: any) =>
      l.email && l.firstName && l.lastName && l.company && l.title && l.linkedin,
    ).length;

    return res.json({
      total,
      validate: { pending: validatePending, alreadyDone: validateAlreadyDone },
      find:     { pending: findPending,     alreadyDone: findAlreadyDone },
      lookup:   { pending: lookupPending,   alreadyDone: lookupAlreadyDone },
    });
  } catch (error: any) {
    console.error('[CRM enrich.so] enrichment-counts error:', error);
    return res.status(500).json({ message: error.message || 'Failed to compute enrichment counts' });
  }
});

/**
 * POST /lists/:listId/leads/find-emails
 * Body: (none — operates on the whole list)
 * Returns: 202 { queued, skipped, alreadyDone }
 */
router.post('/lists/:listId/leads/find-emails', async (req: Request, res: Response) => {
  const { listId } = req.params;
  const userId = (req as AuthenticatedRequest).user?.userId;
  if (!userId) return res.status(401).json({ message: 'Unauthorized' });

  try {
    const list = await crmDb.getLeadListById(listId);
    if (!list) return res.status(404).json({ message: 'Lead list not found' });
    if (!(await canAccessCrmList(userId, list as any))) {
      return res.status(403).json({ message: 'Access denied' });
    }
    const leads = await fetchAllLeads(listId);
    const applicable = leads.filter(isApplicableForFindEmail);
    const alreadyDone = leads.filter((l: any) => !!l.email).length;
    const skipped = leads.length - applicable.length - alreadyDone;
    void findEmailsForLeadsInBackground(listId, applicable, userId);
    return res.status(202).json({ queued: applicable.length, skipped, alreadyDone });
  } catch (error: any) {
    console.error('[CRM enrich.so] bulk find-emails error:', error);
    return res.status(500).json({ message: error.message || 'Failed to queue email finder' });
  }
});

/**
 * POST /lists/:listId/leads/lookup-emails
 * Body: (none — operates on the whole list)
 * Returns: 202 { queued, skipped, alreadyDone }
 */
router.post('/lists/:listId/leads/lookup-emails', async (req: Request, res: Response) => {
  const { listId } = req.params;
  const userId = (req as AuthenticatedRequest).user?.userId;
  if (!userId) return res.status(401).json({ message: 'Unauthorized' });

  try {
    const list = await crmDb.getLeadListById(listId);
    if (!list) return res.status(404).json({ message: 'Lead list not found' });
    if (!(await canAccessCrmList(userId, list as any))) {
      return res.status(403).json({ message: 'Access denied' });
    }
    const leads = await fetchAllLeads(listId);
    const applicable = leads.filter(isApplicableForLookup);
    const alreadyDone = leads.filter((l: any) =>
      l.email && l.firstName && l.lastName && l.company && l.title && l.linkedin,
    ).length;
    const skipped = leads.length - applicable.length - alreadyDone;
    void lookupProfilesForLeadsInBackground(listId, applicable, userId);
    return res.status(202).json({ queued: applicable.length, skipped, alreadyDone });
  } catch (error: any) {
    console.error('[CRM enrich.so] bulk lookup-emails error:', error);
    return res.status(500).json({ message: error.message || 'Failed to queue profile lookup' });
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
