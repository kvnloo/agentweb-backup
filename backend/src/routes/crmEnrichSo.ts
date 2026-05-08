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
import { waterfallFindEmail } from '../services/enrichmentWaterfall';
import {
  startEmailJob,
  recordResult,
  completeJob,
  getJob,
} from '../services/emailJobTracker';
import { applyApolloMatchToLead } from '../services/applyApolloMatchToLead';
import type { LeadRecord } from '../services/crmEnrichmentService';
import {
  ALL_ENRICHMENT_FIELDS,
  EnrichmentFieldConfig,
  normalizeEnrichmentFieldConfig,
} from '../services/enrichmentFieldConfig';
import {
  runWithConcurrency,
  BULK_ENRICH_CONCURRENCY,
} from '../services/crmEnrichmentConcurrency';
import { findEmailsForLeadsInBackground } from '../services/crmFindEmailRunner';

// Conservative RFC-5322-ish check — sufficient to reject obvious garbage and
// catch typos. Real deliverability is what enrich.so checks; this is just a
// gate to prevent burning credits on `__proto__` etc.
// TLD must be ≥2 ASCII letters — rejects `x@y.z` and IP-literal hosts.
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/;
function isValidEmailFormat(email: string): boolean {
  return EMAIL_REGEX.test(email) && email.length <= 254;
}

// runWithConcurrency + BULK_ENRICH_CONCURRENCY moved to
// services/crmEnrichmentConcurrency.ts so non-route callers can share them.

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
 * Body: { autoDncOnFailure?: boolean }   — default true
 *   When true and the result is undeliverable/risky, the lead is also flipped
 *   to contactStatus='do-not-contact' (unless it was already DNC/unsubscribed,
 *   in which case the existing reason/note is preserved).
 * Returns: { status, confidence, isCatchAll, fromCache, checkedAt, dncApplied }
 */
router.post('/lists/:listId/leads/:leadId/validate-email', async (req: Request, res: Response) => {
  const { listId, leadId } = req.params;
  const userId = (req as AuthenticatedRequest).user?.userId;
  if (!userId) return res.status(401).json({ message: 'Unauthorized' });

  // Default true — UI checkbox is checked by default and the user must opt
  // out to disable it. Explicit `false` opts out; everything else (including
  // omitted / null / undefined) means "yes, auto-DNC".
  const autoDncOnFailure = req.body?.autoDncOnFailure !== false;

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

    // Auto-DNC: only when the user opted in AND the result is undeliverable AND
    // the lead isn't already DNC/unsubscribed (don't clobber a user-set reason).
    // Risky is intentionally excluded — many risky results are catch-all domains
    // that still deliver, so flipping them to DNC is too aggressive.
    let dncApplied = false;
    const isBadResult = result.status === 'undeliverable';
    const alreadySuppressed =
      lead.contactStatus === 'do-not-contact' || lead.contactStatus === 'unsubscribed';
    if (autoDncOnFailure && isBadResult && !alreadySuppressed) {
      try {
        await crmDb.updateLead(listId, leadId, {
          contactStatus: 'do-not-contact',
          contactStatusReason: 'bounced',
          contactStatusNote: `Email ${result.status}`,
          contactStatusUpdatedAt: now,
          contactStatusUpdatedBy: userId,
        } as any);
        dncApplied = true;
      } catch (err) {
        // Best-effort — validation result already persisted; surfacing a 500 here
        // would mislead the caller about whether validation succeeded.
        console.error('[CRM enrich.so] auto-DNC updateLead failed:', (err as Error).message);
      }
    }

    return res.json({
      success: true,
      status: result.status,
      confidence: result.confidence,
      isCatchAll: result.isCatchAll,
      fromCache: result.fromCache,
      checkedAt: result.checkedAt,
      dncApplied,
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
 * Body: { firstName?, lastName?, domain?, company?, linkedin? }
 * Returns: { found, email?, confidence?, fromCache, checkedAt }
 *
 * Same auth + format gates as lookup-by-email; shares the same daily lookup
 * quota counter so the user can't burn extra credits via this route.
 *
 * Precondition: ONE of (linkedin URL) OR (name + domain/company) must be
 * present. Linkedin alone is enough — Apollo's /people/match accepts it as
 * a primary match key, so a lead with only a LinkedIn URL still resolves.
 */
router.post('/leads/find-email', async (req: Request, res: Response) => {
  const userId = (req as AuthenticatedRequest).user?.userId;
  if (!userId) return res.status(401).json({ message: 'Unauthorized' });

  const firstName = (req.body?.firstName ?? '').toString().trim();
  const lastName = (req.body?.lastName ?? '').toString().trim();
  const domainRaw = (req.body?.domain ?? '').toString().trim().toLowerCase();
  const company = (req.body?.company ?? '').toString().trim();
  const linkedin = (req.body?.linkedin ?? '').toString().trim();

  const haveName = !!(firstName || lastName);
  const haveOrg = !!(domainRaw || company);
  const haveLinkedin = !!linkedin && /linkedin\.com\/in\//i.test(linkedin);

  if (!haveLinkedin && !(haveName && haveOrg)) {
    return res.status(400).json({
      message: 'Provide either a LinkedIn URL, OR a name plus a domain or company.',
    });
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

  // Optional: caller can pass persistToListId+persistToLeadId to have the
  // route apply applyApolloMatchToLead and persist directly. Lets the
  // LeadDetailPanel button reuse the same single-source-of-truth projection
  // helper instead of duplicating it in React. Quick-Add (no lead yet) calls
  // omit these and just consume the JSON response.
  const persistToListId = (req.body?.persistToListId ?? '').toString().trim();
  const persistToLeadId = (req.body?.persistToLeadId ?? '').toString().trim();

  try {
    // Waterfall: enrich.so first (cheap, doesn't need email as input), then
    // Apollo basic /people/match if enrich.so misses. Apollo finds many
    // emails enrich.so misses (verified, ~1 credit per call).
    const result = await waterfallFindEmail(
      {
        firstName,
        lastName,
        domain: domain || undefined,
        company: domain ? undefined : company,
        linkedin: linkedin || undefined,
      },
      { userId },
    );
    // C8: Only debit the user's lookup quota when the call actually went to a
    // provider. Cache hits don't consume credits, so charging the user against
    // their daily lookup cap for them is wrong (and especially noticeable now
    // that the layered Apollo+enrich.so waterfall produces many more cache hits
    // than the previous single-provider path).
    if (tracker && !result.fromCache) {
      try { await tracker.recordLookupByEmailUsage(userId); } catch (e) {
        console.error('[CRM enrich.so] recordLookupByEmail failed (find-email):', (e as Error).message);
      }
    }

    // If caller asked us to persist and we got a hit, project + write directly.
    let filledFields: string[] = [];
    if (result.found && result.email && persistToListId && persistToLeadId) {
      // Authorization: persistTo* lets the caller specify any (listId, leadId)
      // pair, so we MUST verify the auth'd user owns/can-access the target list
      // before writing — otherwise this is an IDOR.
      const persistList = await crmDb.getLeadListById(persistToListId);
      if (!persistList) {
        return res.status(404).json({ message: 'persistTo lead list not found' });
      }
      if (!(await canAccessCrmList(userId, persistList as any))) {
        return res.status(403).json({ message: 'Access denied' });
      }
      const lead = await crmDb.getLeadById(persistToListId, persistToLeadId).catch(() => null) as LeadRecord | null;
      if (lead) {
        if (result.apolloMatch) {
          // Apollo win: full projection (single source of truth lives here).
          const proj = applyApolloMatchToLead(lead, result.apolloMatch, { fillEmail: true });
          // Stamp Apollo email_status into sourceQuote when available.
          if (result.emailStatus && proj.enrichmentMetadata.email) {
            proj.enrichmentMetadata.email.sourceQuote = `Apollo (${result.emailStatus})`;
          }
          if (proj.changed.size > 0) {
            const payload: Parameters<typeof crmDb.updateLead>[2] = {
              ...proj.updates,
              enrichmentMetadata: proj.enrichmentMetadata,
            };
            if (Object.keys(proj.customFields).length > 0) {
              payload.customFields = { ...(lead.customFields ?? {}), ...proj.customFields };
            }
            if (!payload.email) payload.email = result.email;   // belt + suspenders
            await crmDb.updateLead(persistToListId, persistToLeadId, payload);
            filledFields = Array.from(proj.changed);
          }
        } else if (!lead.email) {
          // Non-Apollo hit (enrich.so / pattern). Only the email is meaningful.
          const newMeta: Record<string, any> = {
            ...((lead.enrichmentMetadata ?? {}) as Record<string, any>),
            email: {
              source: 'web_search',
              provider: result.provider ?? 'enrich.so',
              confidence: result.confidence ?? 'medium',
              enrichedAt: new Date().toISOString(),
              sourceQuote: result.pattern
                ? `Pattern: ${result.pattern}`
                : (result.emailStatus ? `${result.provider} (${result.emailStatus})` : undefined),
            },
          };
          await crmDb.updateLead(persistToListId, persistToLeadId, { email: result.email, enrichmentMetadata: newMeta });
          filledFields = ['email'];
        }
      }
    }

    return res.json({
      found: result.found,
      email: result.email,
      confidence: result.confidence,
      provider: result.provider,
      emailStatus: result.emailStatus,
      pattern: result.pattern,
      tier: result.tier,
      fromCache: result.fromCache,
      checkedAt: new Date().toISOString(),
      // When Apollo provided the match, expose the rich profile so the UI
      // can show / persist title, linkedin, employment history, tech stack,
      // funding, etc. — without making a second API call.
      apolloMatch: result.apolloMatch,
      // When persistTo was set, list of field names actually written to the
      // lead (so the UI can show "Filled X fields" without re-deriving).
      filledFields,
    });
  } catch (error: any) {
    if (error instanceof QuotaExceededError) {
      return res.status(429).json({ message: error.message, endpoint: error.endpoint, limit: error.limit });
    }
    console.error('[CRM find-email] error:', error);
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
// They return 202 with { queued, skipped, alreadyDone }.

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

// findEmailsForLeadsInBackground moved to services/crmFindEmailRunner.ts
// so non-route callers (Phase 1 auto-enrich glue) can invoke it without a
// service → route import smell.

/**
 * Background bulk reverse-lookup — for leads with email but missing one or
 * more profile fields (firstName/lastName/company/title/linkedin), fetch the
 * profile and fill ONLY the empty fields. Never overwrites user data.
 */
/** Format an extended-field value for storage in `customFields` (string only).
 * Returns null when the field has no usable value. */
function pickExtendedFieldValue(
  field: Exclude<keyof import('../services/enrichmentFieldConfig').EnrichmentFieldConfig,
    'firstName' | 'lastName' | 'company' | 'title' | 'linkedin'>,
  r: any,
): string | null {
  switch (field) {
    case 'summary':         return typeof r.summary === 'string' && r.summary.trim() ? r.summary : null;
    case 'location':        return typeof r.location === 'string' && r.location.trim() ? r.location : null;
    case 'headline':        return typeof r.headline === 'string' && r.headline.trim() ? r.headline : null;
    case 'connectionCount': return typeof r.connectionCount === 'number' ? String(r.connectionCount) : null;
    case 'skills':          return Array.isArray(r.skills) && r.skills.length ? r.skills.slice(0, 5).join(', ') : null;
    case 'pastCompanies':   return Array.isArray(r.pastCompanies) && r.pastCompanies.length ? r.pastCompanies.join('; ') : null;
    case 'education':       return Array.isArray(r.education) && r.education.length ? r.education.join('; ') : null;
  }
}

async function lookupProfilesForLeadsInBackground(
  listId: string,
  leads: any[],
  userId: string,
  config: import('../services/enrichmentFieldConfig').EnrichmentFieldConfig,
  jobId?: string,
): Promise<void> {
  let svc;
  try { svc = getEnrichSoService(); } catch {
    if (jobId) completeJob(jobId, 'enrich.so service not initialized');
    return;
  }
  const populatedFieldNames = new Set<string>();
  try {
    await runWithConcurrency(leads, BULK_ENRICH_CONCURRENCY, async (lead) => {
      const email = (lead.email ?? '').trim();
      if (!email) {
        if (jobId) recordResult(jobId, { found: false });
        return;
      }
      try {
        const r = await svc.reverseLookup(email, { userId });
        if (!r.found) {
          if (jobId) recordResult(jobId, { found: false });
          return;
        }

      // Standard fields → top-level lead columns. Each one is gated on the
      // per-list config and only written when the lead's column is empty
      // (never overwrites existing data).
      const topLevel: Record<string, string> = {};
      if (config.firstName && !lead.firstName && r.firstName) topLevel.firstName = r.firstName;
      if (config.lastName  && !lead.lastName  && r.lastName)  topLevel.lastName  = r.lastName;
      if (config.company   && !lead.company   && r.companyName) topLevel.company  = r.companyName;
      if (config.title     && !lead.title     && r.jobTitle)  topLevel.title     = r.jobTitle;
      if (config.linkedin  && !lead.linkedin  && r.profileUrl) topLevel.linkedin  = r.profileUrl;

      // Extended fields → customFields[<field>]. Same never-overwrite rule:
      // skip when the lead already has a value at that key.
      const existingCustom = (lead.customFields ?? {}) as Record<string, any>;
      const customFields: Record<string, string> = {};
      const EXTENDED = ['summary', 'skills', 'connectionCount', 'location', 'headline', 'pastCompanies', 'education'] as const;
      for (const f of EXTENDED) {
        if (!config[f]) continue;
        if (existingCustom[f]) continue;
        const v = pickExtendedFieldValue(f, r);
        if (v) customFields[f] = v;
      }

      const wroteAny = Object.keys(topLevel).length > 0 || Object.keys(customFields).length > 0;
      if (!wroteAny) {
        if (jobId) recordResult(jobId, { found: false });
        return;
      }

      const now = new Date().toISOString();
      const fieldMetaForProvider = {
        source: 'linkedin' as const,
        provider: 'enrich.so',
        confidence: 'high' as const,
        enrichedAt: now,
      };
      const enrichmentMetadata: Record<string, any> = {};
      for (const k of Object.keys(topLevel)) enrichmentMetadata[k] = fieldMetaForProvider;
      for (const k of Object.keys(customFields)) enrichmentMetadata[k] = fieldMetaForProvider;

      await crmDb.setLeadFields(listId, lead.leadId, { topLevel, enrichmentMetadata, customFields });

        for (const k of Object.keys(topLevel)) populatedFieldNames.add(k);
        for (const k of Object.keys(customFields)) populatedFieldNames.add(k);
        if (jobId) recordResult(jobId, { found: true });
      } catch (err) {
        console.error('[CRM enrich.so] bulk lookup failed for', lead.leadId, ':', (err as Error).message);
        if (jobId) recordResult(jobId, { found: false, error: true });
      }
    });
    try {
      await crmDb.mergeFieldNames(listId, populatedFieldNames);
    } catch (err) {
      console.error('[CRM enrich.so] bulk lookup: failed to update fieldNames:', (err as Error).message);
    }
    if (jobId) completeJob(jobId);
  } catch (err) {
    if (jobId) completeJob(jobId, (err as Error).message);
    throw err;
  }
}

function isApplicableForFindEmail(lead: any): boolean {
  if (lead.email) return false;
  // Apollo's /people/match accepts linkedin_url as a primary match key, so
  // a lead with ONLY a LinkedIn URL is still applicable.
  if (lead.linkedin) return true;
  return (!!lead.firstName || !!lead.lastName) && (!!lead.company || !!lead.website);
}

function isApplicableForLookup(
  lead: any,
  config?: import('../services/enrichmentFieldConfig').EnrichmentFieldConfig,
): boolean {
  if (!lead.email) return false;
  // No config → legacy semantics: missing one of the 5 standard fields.
  if (!config) {
    return !lead.firstName || !lead.lastName || !lead.company || !lead.title || !lead.linkedin;
  }
  // With config → applicable when ANY enabled field is empty on the lead.
  // Standard fields read from top-level columns; extended from customFields.
  const standard: Array<['firstName' | 'lastName' | 'company' | 'title' | 'linkedin', string]> = [
    ['firstName', 'firstName'], ['lastName', 'lastName'], ['company', 'company'],
    ['title', 'title'], ['linkedin', 'linkedin'],
  ];
  for (const [cfgKey, leadKey] of standard) {
    if (config[cfgKey] && !lead[leadKey]) return true;
  }
  const cf = (lead.customFields ?? {}) as Record<string, any>;
  const extended = ['summary', 'skills', 'connectionCount', 'location', 'headline', 'pastCompanies', 'education'] as const;
  for (const k of extended) {
    if (config[k] && !cf[k]) return true;
  }
  return false;
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
    // Lookup pending must respect the per-list config so the count matches what
    // the bulk job will actually queue.
    const lookupConfig = normalizeEnrichmentFieldConfig(
      (list as any).enrichmentFieldConfig as Partial<Record<string, unknown>> | null | undefined,
    );
    const lookupPending = leads.filter((l) => isApplicableForLookup(l, lookupConfig)).length;
    // "Already processed" for find = leads that NOW have email (we can't tell
    // if it was provider-found or user-typed, but for UX showing how many are
    // "complete" is what matters).
    const findAlreadyDone = withEmail;
    // For lookup: "already done" = had email but isn't applicable per config.
    const lookupAlreadyDone = withEmail - lookupPending;

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
 * Body: { leadIds?: string[] }   (omit → all leads in list; non-empty array → restrict to those)
 * Returns: 202 { queued, skipped, alreadyDone }
 */
router.post('/lists/:listId/leads/find-emails', async (req: Request, res: Response) => {
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
    let leads: any[];
    if (Array.isArray(leadIds)) {
      if (leadIds.length === 0) {
        return res.status(202).json({ queued: 0, skipped: 0, alreadyDone: 0 });
      }
      const fetched = await Promise.all(
        leadIds.map((id: string) => crmDb.getLeadById(listId, id).catch(() => null)),
      );
      leads = fetched.filter((l): l is any => !!l);
    } else {
      leads = await fetchAllLeads(listId);
    }
    const applicable = leads.filter(isApplicableForFindEmail);
    const alreadyDone = leads.filter((l: any) => !!l.email).length;
    const skipped = leads.length - applicable.length - alreadyDone;
    const job = startEmailJob({ kind: 'find', listId, userId, total: applicable.length });
    void findEmailsForLeadsInBackground(listId, applicable, userId, job.jobId);
    return res.status(202).json({ jobId: job.jobId, queued: applicable.length, skipped, alreadyDone });
  } catch (error: any) {
    console.error('[CRM enrich.so] bulk find-emails error:', error);
    return res.status(500).json({ message: error.message || 'Failed to queue email finder' });
  }
});

/**
 * POST /lists/:listId/leads/lookup-emails
 * Body: { leadIds?: string[] }   (omit → all leads in list; non-empty array → restrict)
 * Returns: 202 { queued, skipped, alreadyDone }
 */
router.post('/lists/:listId/leads/lookup-emails', async (req: Request, res: Response) => {
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
    // Load the per-list config so the background job knows which fields the
    // user actually wants populated. Defaults applied for any unset key.
    const config = normalizeEnrichmentFieldConfig(
      (list as any).enrichmentFieldConfig as Partial<Record<string, unknown>> | null | undefined,
    );
    let leads: any[];
    if (Array.isArray(leadIds)) {
      if (leadIds.length === 0) {
        return res.status(202).json({ queued: 0, skipped: 0, alreadyDone: 0 });
      }
      const fetched = await Promise.all(
        leadIds.map((id: string) => crmDb.getLeadById(listId, id).catch(() => null)),
      );
      leads = fetched.filter((l): l is any => !!l);
    } else {
      leads = await fetchAllLeads(listId);
    }
    const applicable = leads.filter((l) => isApplicableForLookup(l, config));
    const alreadyDone = leads.length - applicable.length - leads.filter((l: any) => !l.email).length;
    const skipped = leads.length - applicable.length - alreadyDone;
    const job = startEmailJob({ kind: 'lookup', listId, userId, total: applicable.length });
    void lookupProfilesForLeadsInBackground(listId, applicable, userId, config, job.jobId);
    return res.status(202).json({ jobId: job.jobId, queued: applicable.length, skipped, alreadyDone });
  } catch (error: any) {
    console.error('[CRM enrich.so] bulk lookup-emails error:', error);
    return res.status(500).json({ message: error.message || 'Failed to queue profile lookup' });
  }
});

/**
 * POST /lists/:listId/leads/validate-emails
 * Body: { leadIds?: string[] }  (omit → all leads in list)
 * Returns: 202 { queued: number, skipped: number, alreadyDone: number }
 *
 * Kicks off background validation. Pills update on individual leads as each
 * call completes.
 *   queued      = leads with email that will be (re-)validated
 *   skipped     = leads with no email
 *   alreadyDone = informational — leads with email that already carry an
 *                 email_validation entry (still queued; the cache layer
 *                 short-circuits to the cached result inside its TTL).
 */
router.post('/lists/:listId/leads/validate-emails', async (req: Request, res: Response) => {
  const { listId } = req.params;
  const userId = (req as AuthenticatedRequest).user?.userId;
  if (!userId) return res.status(401).json({ message: 'Unauthorized' });

  const { leadIds } = req.body ?? {};
  if (leadIds !== undefined && !Array.isArray(leadIds)) {
    return res.status(400).json({ message: 'leadIds must be an array when provided' });
  }
  // Mirrors the single-lead validate route: default true unless the client
  // explicitly opts out. The bulk dialog sends this from a checkbox the user
  // can untick before confirming.
  const autoDncOnFailure = req.body?.autoDncOnFailure !== false;

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
    let targetLeads: Array<{ leadId: string; email?: string; alreadyValidated: boolean }> = [];
    if (Array.isArray(leadIds)) {
      if (leadIds.length === 0) {
        return res.status(202).json({ queued: 0, skipped: 0, alreadyDone: 0 });
      }
      const fetched = await Promise.all(
        leadIds.map((id: string) => crmDb.getLeadById(listId, id).catch(() => null)),
      );
      targetLeads = fetched.filter(Boolean).map((l: any) => ({
        leadId: l.leadId,
        email: l.email,
        alreadyValidated: !!l.customFields?.email_validation,
      }));
    } else {
      let lastKey: any = undefined;
      do {
        const page = await crmDb.getLeadsByListId(listId, 100, lastKey);
        for (const l of page.items) {
          const lead = l as any;
          targetLeads.push({
            leadId: lead.leadId,
            email: lead.email,
            alreadyValidated: !!lead.customFields?.email_validation,
          });
        }
        lastKey = page.lastEvaluatedKey;
      } while (lastKey);
    }

    const validatable = targetLeads.filter((l) => l.email && l.email.trim());
    const skipped = targetLeads.length - validatable.length;
    const alreadyDone = validatable.filter((l) => l.alreadyValidated).length;

    // Fire and forget — pills update as each completes. Track progress so the
    // UI can show a live counter + final breakdown via /email-jobs/:jobId.
    const job = startEmailJob({ kind: 'validate', listId, userId, total: validatable.length });
    void validateLeadsInBackground(listId, validatable, userId, job.jobId, { autoDncOnFailure });

    return res.status(202).json({ jobId: job.jobId, queued: validatable.length, skipped, alreadyDone });
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

/**
 * GET /lists/:listId/enrichment-field-config
 * Returns the per-list enrich.so field config with defaults filled in for any
 * unset key. Standard fields default to true, extended fields default to false.
 */
router.get('/lists/:listId/enrichment-field-config', async (req: Request, res: Response) => {
  const { listId } = req.params;
  const userId = (req as AuthenticatedRequest).user?.userId;
  if (!userId) return res.status(401).json({ message: 'Unauthorized' });

  try {
    const list = await crmDb.getLeadListById(listId);
    if (!list) return res.status(404).json({ message: 'Lead list not found' });
    if (!(await canAccessCrmList(userId, list as any))) {
      return res.status(403).json({ message: 'Access denied' });
    }
    const config = normalizeEnrichmentFieldConfig(
      (list as any).enrichmentFieldConfig as Partial<Record<string, unknown>> | null | undefined,
    );
    return res.json({ config });
  } catch (error: any) {
    console.error('[CRM enrich.so] get enrichment-field-config error:', error);
    return res.status(500).json({ message: error.message || 'Failed to load enrichment field config' });
  }
});

/**
 * PATCH /lists/:listId/enrichment-field-config
 * Body: { config: Partial<EnrichmentFieldConfig> }
 *   — only known boolean keys are accepted; unknown keys are ignored.
 * Returns: { config } the merged & persisted config.
 */
router.patch('/lists/:listId/enrichment-field-config', async (req: Request, res: Response) => {
  const { listId } = req.params;
  const userId = (req as AuthenticatedRequest).user?.userId;
  if (!userId) return res.status(401).json({ message: 'Unauthorized' });

  const incoming = (req.body && typeof req.body === 'object') ? (req.body.config ?? req.body) : null;
  if (!incoming || typeof incoming !== 'object') {
    return res.status(400).json({ message: 'Body must include a `config` object' });
  }

  try {
    const list = await crmDb.getLeadListById(listId);
    if (!list) return res.status(404).json({ message: 'Lead list not found' });
    if (!(await canAccessCrmList(userId, list as any))) {
      return res.status(403).json({ message: 'Access denied' });
    }

    // Merge against existing config so a partial PATCH only updates the keys
    // the client sent. Unknown keys are dropped by normalize.
    const existing = normalizeEnrichmentFieldConfig(
      (list as any).enrichmentFieldConfig as Partial<Record<string, unknown>> | null | undefined,
    );
    const merged: EnrichmentFieldConfig = { ...existing };
    for (const f of ALL_ENRICHMENT_FIELDS) {
      if (typeof incoming[f] === 'boolean') merged[f] = incoming[f] as boolean;
    }

    await crmDb.updateLeadList(listId, { enrichmentFieldConfig: merged });
    return res.json({ config: merged });
  } catch (error: any) {
    console.error('[CRM enrich.so] patch enrichment-field-config error:', error);
    return res.status(500).json({ message: error.message || 'Failed to update enrichment field config' });
  }
});

/**
 * GET /lists/:listId/email-jobs/:jobId
 *
 * Polled by the frontend after a bulk find/validate/lookup is kicked off.
 * Returns the job's running counts (processed / found / notFound / errors)
 * plus the final status. Once `status === 'completed'` or `'error'`, the UI
 * can refetch the lead list to show the new pills/values.
 *
 * Returns 404 if the job doesn't exist (e.g., backend restart wiped the
 * in-memory tracker — the UI should surface "progress unknown" rather than
 * spin forever).
 */
router.get('/lists/:listId/email-jobs/:jobId', async (req: Request, res: Response) => {
  const userId = (req as AuthenticatedRequest).user?.userId;
  if (!userId) return res.status(401).json({ message: 'Unauthorized' });
  const { listId, jobId } = req.params;
  const job = getJob(jobId);
  if (!job) return res.status(404).json({ message: 'Job not found or expired' });
  if (job.userId !== userId || job.listId !== listId) {
    // Don't leak job state across users or lists.
    return res.status(404).json({ message: 'Job not found or expired' });
  }
  return res.json(job);
});

export default router;
