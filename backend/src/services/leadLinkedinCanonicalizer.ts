import { normalizeLinkedInUrl } from './enrichmentGroups';

/**
 * One-time data repair for legacy `lead.linkedin` values (ENG-787).
 *
 * `batchCreateLeads` (CSV import) has always canonicalized the URL, but
 * `createLead`/`updateLead` stored it trim-only until ENG-787. Leads added one at a
 * time — through the CRM UI or the API — therefore sit in the exact-match
 * `LinkedinLookupIndex` under whatever the user pasted: mixed case, `http://`, no
 * `www.`, a trailing slash, tracking query params. A canonical lookup cannot find
 * them, so the invite reconciliation would miss the row that already represents a
 * person and create a duplicate lead.
 */

export interface NormalizeListResult {
  /** Leads scanned. */
  total: number;
  /** Leads carrying a non-empty `linkedin` value. */
  withLinkedin: number;
  /** Already canonical — untouched. */
  alreadyCanonical: number;
  /** Rewritten to canonical form (or that would be, under `dryRun`). */
  normalized: number;
  /** Not a personal /in/ profile — left untouched, needs a human. */
  unsupported: number;
  /** Canonical URLs that more than one lead in this list resolves to. */
  collisions: number;
  /** leadIds grouped under each colliding canonical URL, for the operator to merge. */
  collisionGroups: Array<{ canonical: string; leadIds: string[] }>;
}

export interface NormalizeListOptions {
  /** Resolve every rewrite and collision but write nothing. */
  dryRun?: boolean;
  /** Per-line reporting; defaults to console. */
  logger?: { log: (msg: string) => void; warn: (msg: string) => void };
}

/**
 * Rewrite every lead's `linkedin` in one list to its canonical form.
 *
 * Two cases are reported but deliberately NEVER written, because both need a human:
 *   • unsupported — the value is not a personal /in/ profile (company page, search
 *     URL, free text). It is left exactly as-is.
 *   • collisions — two leads canonicalize to the SAME URL, i.e. they are duplicates
 *     of one person. Normalizing surfaces the duplicate rather than hiding it;
 *     merging them is a CRM decision, not this function's.
 *
 * BULK MUTATION: rewrites a GSI key across a customer's leads. Data-plane.
 */
export async function normalizeListLinkedinUrls(
  listId: string,
  options: NormalizeListOptions = {},
): Promise<NormalizeListResult> {
  const dryRun = options.dryRun === true;
  const logger = options.logger ?? {
    log: (m: string) => console.log(m),
    warn: (m: string) => console.warn(m),
  };
  const result: NormalizeListResult = {
    total: 0,
    withLinkedin: 0,
    alreadyCanonical: 0,
    normalized: 0,
    unsupported: 0,
    collisions: 0,
    collisionGroups: [],
  };
  if (!listId) return result;

  const { crmDb } = await import('./db');

  // canonical URL -> leadIds that resolve to it, for duplicate detection.
  const canonicalOwners = new Map<string, string[]>();

  let lastKey: any = undefined;
  do {
    const page = await crmDb.getLeadsByListId(listId, 100, lastKey);
    for (const lead of (page.items ?? []) as any[]) {
      result.total++;
      const raw = typeof lead.linkedin === 'string' ? lead.linkedin.trim() : '';
      if (!raw) continue;
      result.withLinkedin++;

      // normalizeLinkedInUrl returns '' for a company/school URL, but passes free
      // text through (lowercased) — so require a personal /in/ profile before
      // touching anything. A note like "ask sales for Jane's profile" is data, not
      // a URL to canonicalize.
      const canonicalCandidate = normalizeLinkedInUrl(raw);
      const canonical = canonicalCandidate.includes('/in/') ? canonicalCandidate : '';
      if (!canonical) {
        // Not a personal profile. Writing the normalized (empty) value would strip
        // the field — never silently drop customer data; surface it and move on.
        result.unsupported++;
        logger.warn(`  [unsupported] ${lead.leadId}: ${JSON.stringify(raw)} — not a personal /in/ URL, left unchanged`);
        continue;
      }

      const owners = canonicalOwners.get(canonical) ?? [];
      owners.push(lead.leadId);
      canonicalOwners.set(canonical, owners);

      if (canonical === raw) {
        result.alreadyCanonical++;
        continue;
      }

      logger.log(`  [normalize] ${lead.leadId}: ${raw} -> ${canonical}`);
      if (!dryRun) {
        await crmDb.updateLead(listId, lead.leadId, { linkedin: canonical });
      }
      result.normalized++;
    }
    lastKey = page.lastEvaluatedKey;
  } while (lastKey);

  for (const [canonical, leadIds] of canonicalOwners) {
    if (leadIds.length > 1) {
      result.collisions++;
      result.collisionGroups.push({ canonical, leadIds });
      logger.warn(`  [duplicate] ${canonical} is held by ${leadIds.length} leads: ${leadIds.join(', ')} — merge manually`);
    }
  }

  return result;
}
