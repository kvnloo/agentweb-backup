/**
 * CRM routes for Apollo:
 *
 *   POST /leads/lookup-by-linkedin
 *     Match a Lead profile by LinkedIn URL. Returns a draft lead suitable for
 *     pre-filling a "Quick Add" dialog. No persistence.
 *
 *   POST /lists/:listId/leads/enrich-with-apollo
 *     Bulk Apollo enrichment for a list. Background-processes each lead with
 *     concurrency cap; returns 202 with queued/skipped counts.
 *
 * Phone reveals (which require an async webhook callback) are intentionally
 * out of scope for v1. All Apollo data we currently consume is returned
 * synchronously by /people/match.
 *
 * Mounted into the parent /api/crm router from crm.ts (alongside crmEnrichSo).
 */

import express, { Request, Response, Router } from 'express';
import { AuthenticatedRequest } from '../middleware/auth';
import { crmDb } from '../services/db';
import { canDestructiveCrmList, CRM_EDITOR_REQUIRED_MESSAGE } from '../services/crmAccessControl';
import { getApolloService, isApolloServiceReady } from '../services/apolloService';
import { ApolloQuotaExceededError } from '../services/apolloQuota';
import { applyApolloMatchToLead } from '../services/applyApolloMatchToLead';

const BULK_ENRICH_CONCURRENCY = 8;

async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  const cap = Math.max(1, limit);
  let i = 0;
  const runners = Array.from({ length: Math.min(cap, items.length) }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      try {
        await worker(items[idx]);
      } catch (err) {
        // Belt-and-suspenders. The worker (enrichLeadsWithApolloInBackground)
        // wraps its own try/catch and logs per-item errors at the call site —
        // this outer catch is here so a synchronous throw in the worker fn
        // (or in any future change to it) doesn't kill the runner. Log here
        // too so a future bug doesn't go entirely silent.
        console.error('[CRM apollo] runWithConcurrency outer worker error:', (err as Error).message);
      }
    }
  });
  await Promise.all(runners);
}

const router: Router = express.Router();

/**
 * In-memory lock for in-flight bulk enrich jobs, keyed by `${userId}:${listId}`.
 * Prevents replays of the 202-then-background-work endpoint from spawning
 * N×8 parallel Apollo workers when the user double-clicks or a flaky client
 * retries. Cleared in `finally` after the background fan-out resolves.
 *
 * Process-local — if a backend restart happens mid-job, the lock dies with
 * the process and the user can retry. Acceptable for v1.
 */
const bulkEnrichInFlight = new Set<string>();
function bulkLockKey(userId: string, listId: string): string { return `${userId}:${listId}`; }
export function __resetBulkEnrichLockForTesting(): void { bulkEnrichInFlight.clear(); }

function ensureApolloReadyOr503(res: Response): boolean {
  if (!isApolloServiceReady()) {
    res.status(503).json({ message: 'Apollo service not initialized — check API key configuration' });
    return false;
  }
  return true;
}

// ─── lookup-by-linkedin ──────────────────────────────────────────────────────

/**
 * POST /leads/lookup-by-linkedin
 * Body: { linkedinUrl: string }
 * Returns: { found, draft: { firstName, lastName, company, title, linkedin, location, headline, employmentHistory? }, fromCache, checkedAt }
 *
 * No persistence — used for pre-filling a Quick Add dialog.
 */
router.post('/leads/lookup-by-linkedin', async (req: Request, res: Response) => {
  const userId = (req as AuthenticatedRequest).user?.userId;
  if (!userId) return res.status(401).json({ message: 'Unauthorized' });
  if (!ensureApolloReadyOr503(res)) return;

  const linkedinUrl = (req.body?.linkedinUrl ?? '').toString().trim();
  if (!linkedinUrl || !/linkedin\.com\/in\//i.test(linkedinUrl)) {
    return res.status(400).json({ message: 'valid linkedinUrl is required' });
  }

  try {
    const result = await getApolloService().matchPerson({ linkedinUrl }, { userId });
    if (!result.found || !result.match) {
      return res.json({ found: false, fromCache: result.fromCache, checkedAt: result.checkedAt });
    }
    const p = result.match.person;
    const o = result.match.organization;
    const locationParts = [p.city, p.state, p.country].filter(Boolean);
    return res.json({
      found: true,
      draft: {
        firstName: p.firstName,
        lastName: p.lastName,
        email: p.email,
        title: p.title,
        company: o?.name,
        domain: o?.domain,
        linkedin: p.linkedin,
        location: locationParts.length ? locationParts.join(', ') : undefined,
        headline: p.headline,
        seniority: p.seniority,
        employmentHistory: p.employmentHistory,
        techStack: o?.techStack,
      },
      fromCache: result.fromCache,
      checkedAt: result.checkedAt,
    });
  } catch (err: any) {
    if (err instanceof ApolloQuotaExceededError) {
      return res.status(429).json({ message: err.message, endpoint: err.endpoint, limit: err.limit });
    }
    console.error('[CRM apollo] lookup-by-linkedin error:', err);
    return res.status(500).json({ message: err.message || 'Failed to look up profile' });
  }
});

// ─── bulk enrich ─────────────────────────────────────────────────────────────

interface ApolloBulkOptions {
  enrichPerson?: boolean;
  enrichOrg?: boolean;
}

interface BulkLead {
  leadId: string;
  email?: string;
  linkedin?: string;
  firstName?: string;
  lastName?: string;
  company?: string;
  website?: string;
  customFields?: Record<string, any>;
  enrichmentMetadata?: Record<string, any>;
}

function leadHasIdentifier(lead: BulkLead): boolean {
  if (lead.linkedin) return true;
  if (lead.email) return true;
  if ((lead.firstName || lead.lastName) && (lead.company || lead.website)) return true;
  return false;
}

async function fetchAllLeads(listId: string): Promise<BulkLead[]> {
  const out: BulkLead[] = [];
  let lastKey: any = undefined;
  do {
    const page = await crmDb.getLeadsByListId(listId, 100, lastKey);
    out.push(...(page.items as BulkLead[]));
    lastKey = page.lastEvaluatedKey;
  } while (lastKey);
  return out;
}

/** Background bulk Apollo enrichment for a list. Never overwrites populated fields. */
async function enrichLeadsWithApolloInBackground(
  listId: string,
  leads: BulkLead[],
  userId: string,
  opts: ApolloBulkOptions,
): Promise<void> {
  if (!isApolloServiceReady()) return;
  const svc = getApolloService();
  await runWithConcurrency(leads, BULK_ENRICH_CONCURRENCY, async (lead) => {
    if (!leadHasIdentifier(lead)) return;
    try {
      const r = await svc.matchPerson(
        {
          linkedinUrl: lead.linkedin || undefined,
          email: lead.email || undefined,
          firstName: lead.firstName || undefined,
          lastName: lead.lastName || undefined,
          organizationName: lead.company || undefined,
          domain: lead.website
            ? String(lead.website).replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0]
            : undefined,
          linkedToEmail: lead.email || undefined,
        },
        { userId },
      );
      if (!r.found || !r.match) return;

      // Single source of truth: applyApolloMatchToLead computes the never-overwrite
      // projection (person + org fields, plus apolloPersonId/employmentHistory/etc).
      // Same helper used by bulk find-emails and the per-lead Find email button —
      // changes there flow through to every Apollo write path automatically.
      const proj = applyApolloMatchToLead(lead, r.match, {
        fillEmail: true,
        includePerson: opts.enrichPerson !== false,
        includeOrg: opts.enrichOrg !== false,
        minimalFields: true,
      });
      if (proj.changed.size === 0) return;

      // Use targeted document-path SETs via setLeadFields — never spread
      // lead.customFields (a stale snapshot) back into an updateLead call.
      // Two concurrent workers on the same list would otherwise clobber each
      // other's customFields/enrichmentMetadata maps. Matches the converted
      // enrich.so + crmEnrichmentService write paths.
      const topLevel: Record<string, string> = {};
      for (const [k, v] of Object.entries(proj.updates)) {
        if (v !== undefined && v !== null && v !== '') topLevel[k] = String(v);
      }
      await crmDb.setLeadFields(listId, lead.leadId, {
        topLevel,
        enrichmentMetadata: proj.enrichmentMetadata,
        customFields: proj.customFields,
      });
    } catch (err) {
      console.error('[CRM apollo] bulk enrich failed for', lead.leadId, ':', (err as Error).message);
    }
  });
}

/**
 * POST /lists/:listId/leads/enrich-with-apollo
 * Body: { enrichPerson?: boolean (default true), enrichOrg?: boolean (default true), leadIds?: string[] }
 * Returns: 202 { queued, skipped }
 */
router.post('/lists/:listId/leads/enrich-with-apollo', async (req: Request, res: Response) => {
  const userId = (req as AuthenticatedRequest).user?.userId;
  if (!userId) return res.status(401).json({ message: 'Unauthorized' });
  if (!ensureApolloReadyOr503(res)) return;

  const { listId } = req.params;
  const lockKey = bulkLockKey(userId, listId);

  // C6: per-(user, list) lock. Reject replays while a previous bulk job is
  // still fanning out — otherwise N retries spawn N×concurrency workers.
  // Acquired *before* the slow fetchAllLeads pass so concurrent replays land
  // on the lock check, not on a fresh leads scan that races to completion.
  if (bulkEnrichInFlight.has(lockKey)) {
    return res.status(409).json({ message: 'Bulk Apollo enrichment is already running for this list' });
  }
  bulkEnrichInFlight.add(lockKey);

  try {
    const list = await crmDb.getLeadListById(listId);
    if (!list) {
      bulkEnrichInFlight.delete(lockKey);
      return res.status(404).json({ message: 'Lead list not found' });
    }
    if (!(await canDestructiveCrmList(userId, list as any))) {
      bulkEnrichInFlight.delete(lockKey);
      return res.status(403).json({ message: CRM_EDITOR_REQUIRED_MESSAGE });
    }

    const opts: ApolloBulkOptions = {
      enrichPerson: req.body?.enrichPerson !== false,
      enrichOrg: req.body?.enrichOrg !== false,
    };
    const explicitIds = Array.isArray(req.body?.leadIds) ? new Set<string>(req.body.leadIds.map(String)) : null;

    const allLeads = await fetchAllLeads(listId);
    const filtered = explicitIds
      ? allLeads.filter((l) => explicitIds.has(l.leadId))
      : allLeads;
    const applicable = filtered.filter(leadHasIdentifier);
    const skipped = filtered.length - applicable.length;

    res.status(202).json({ queued: applicable.length, skipped });

    enrichLeadsWithApolloInBackground(listId, applicable, userId, opts)
      .catch((err) => {
        console.error('[CRM apollo] bulk enrich background error:', err);
      })
      .finally(() => {
        bulkEnrichInFlight.delete(lockKey);
      });
  } catch (err: any) {
    bulkEnrichInFlight.delete(lockKey);
    console.error('[CRM apollo] enrich-with-apollo error:', err);
    return res.status(500).json({ message: err.message || 'Failed to start Apollo enrichment' });
  }
});

// NOTE: The /webhooks/apollo handler is intentionally NOT mounted here —
// it lives in routes/apolloWebhook.ts and is mounted directly on app.ts
// before the auth-protected crmRoutes, because Apollo doesn't send a JWT
// when calling our webhook URL.

export default router;
