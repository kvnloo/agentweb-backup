/**
 * Provider-aware enrichment waterfall.
 *
 * Replaces the standalone enrich.so specialists with composite specialists
 * that try Apollo first (when the lead has a LinkedIn URL — Apollo's strongest
 * match key) and fall back to enrich.so. Email-only leads route to enrich.so
 * first since Apollo gains no advantage there.
 *
 * Each lead gets at most one Apollo match call AND one enrich.so reverse call
 * per enrichment job, regardless of how many fields are resolved — both
 * providers' results are deduped via per-(userId, key) in-flight promise maps.
 */

import type { FieldSpecialist, SpecialistResult } from './enrichmentSpecialists';
import type { EnrichmentFieldName } from './enrichmentFieldConfig';
import { normalizeEnrichmentFieldConfig } from './enrichmentFieldConfig';
import {
  getApolloService,
  isApolloServiceReady,
  type MatchResult as ApolloMatchResult,
} from './apolloService';
import type { MappedPerson, MappedMatch } from './apolloFieldMapper';
import { getEnrichSoService, type ReverseResult, type EnrichSoConfidence } from './enrichSoService';
import { findEmailViaPatterns } from './emailPatternFinder';
import { apolloAsyncRequestCacheKey, APOLLO_SCHEMA_VERSION } from './apolloCacheKeys';
import { normalizeLinkedInUrl } from './enrichmentGroups';
import { crmDb } from './db';
import { getFieldConfidence } from './fieldConfidenceRegistry';

type ProviderSource = 'apollo' | 'enrich.so';

export interface WaterfallContext {
  userId: string;
  enrichmentFieldConfig?: any;
}

/** In-flight dedup for Apollo match calls. Key: `${userId}:${cacheToken}`. */
const apolloInflight = new Map<string, Promise<ApolloMatchResult | null>>();
/** In-flight dedup for enrich.so reverse-lookup calls. Key: `${userId}:${email}`. */
const enrichSoInflight = new Map<string, Promise<ReverseResult | null>>();

/** Test-only: clear both in-flight maps. */
export function __resetWaterfallDedupForTesting(): void {
  apolloInflight.clear();
  enrichSoInflight.clear();
}

function apolloDedupToken(lead: any): string | null {
  // S1: reuse the canonical LinkedIn URL normalizer so /in/x and /in/x/?utm_*
  // dedup to the same token (same as apolloCacheKeys' canonical form).
  if (lead.linkedin) {
    const norm = normalizeLinkedInUrl(lead.linkedin);
    if (norm) return `li:${norm}`;
  }
  if (lead.email) return `em:${String(lead.email).trim().toLowerCase()}`;
  return null;
}

async function getApolloMatchForLead(lead: any, ctx: WaterfallContext): Promise<ApolloMatchResult | null> {
  if (!isApolloServiceReady()) return null;
  const token = apolloDedupToken(lead);
  if (!token) return null;

  const dedupKey = `${ctx.userId}:${token}`;
  const existing = apolloInflight.get(dedupKey);
  if (existing) return existing;

  const svc = getApolloService();
  const p = svc
    .matchPerson(
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
      { userId: ctx.userId },
    )
    .catch(() => null);

  apolloInflight.set(dedupKey, p);
  try {
    return await p;
  } finally {
    apolloInflight.delete(dedupKey);
  }
}

async function getEnrichSoReverseForLead(lead: any, ctx: WaterfallContext): Promise<ReverseResult | null> {
  const email = (lead.email ?? '').trim().toLowerCase();
  if (!email) return null;

  const dedupKey = `${ctx.userId}:${email}`;
  const existing = enrichSoInflight.get(dedupKey);
  if (existing) return existing;

  let svc;
  try { svc = getEnrichSoService(); } catch { return null; }

  const p = svc.reverseLookup(email, { userId: ctx.userId }).catch(() => null);
  enrichSoInflight.set(dedupKey, p);
  try {
    return await p;
  } finally {
    enrichSoInflight.delete(dedupKey);
  }
}

// ─── Field projection ────────────────────────────────────────────────────────

interface ProjectedFromApollo {
  value: string | null;
  /** Confidence honored by Apollo's mapper. */
  confidence: EnrichSoConfidence;
}

/**
 * Field projector for Apollo /people/match results.
 *
 * Apollo's match payload is rich on identity (name, email, title, linkedin,
 * employment history) but sparse or absent on:
 *   - `summary` (long bio)            — not returned reliably
 *   - `connectionCount`               — not in the response at all
 *   - `skills`                        — not in the response at all
 *   - `education`                     — present but sparse / unstructured
 *
 * For email-keyed leads these still resolve via enrich.so's reverse-lookup
 * (which carries them). For LinkedIn-only leads — where enrich.so can't help
 * because reverse-lookup keys on email — these four fields stay empty until
 * the lead acquires an email. Documented limitation, not a bug.
 */
function pickFromApolloMatch(
  field: EnrichmentFieldName,
  match: { person: MappedPerson; organization?: { name?: string } },
): ProjectedFromApollo | null {
  const person = match.person;
  switch (field) {
    case 'firstName':       return person.firstName       ? { value: person.firstName,        confidence: person.fieldConfidence.firstName ?? 'medium' } : null;
    case 'lastName':        return person.lastName        ? { value: person.lastName,         confidence: person.fieldConfidence.lastName ?? 'medium' } : null;
    case 'title':           return person.title           ? { value: person.title,            confidence: person.fieldConfidence.title ?? 'medium' } : null;
    case 'linkedin':        return person.linkedin        ? { value: person.linkedin,         confidence: person.fieldConfidence.linkedin ?? 'medium' } : null;
    case 'headline':        return person.headline        ? { value: person.headline,         confidence: person.fieldConfidence.headline ?? 'medium' } : null;
    case 'summary':         return null;                   // Apollo doesn't reliably return a long bio — defer to enrich.so
    case 'connectionCount': return null;                   // Not in Apollo response
    case 'skills':          return null;                   // Not in Apollo response
    case 'company':         return match.organization?.name ? { value: match.organization.name, confidence: 'medium' } : null;
    case 'location': {
      const parts = [person.city, person.state, person.country].filter(Boolean);
      return parts.length ? { value: parts.join(', '), confidence: person.fieldConfidence.city ?? 'medium' } : null;
    }
    case 'pastCompanies': {
      if (!person.employmentHistory || !person.employmentHistory.length) return null;
      const past = person.employmentHistory
        .filter((e) => !e.current)
        .map((e) => e.organizationName)
        .filter((n): n is string => !!n);
      return past.length ? { value: past.join('; '), confidence: 'medium' } : null;
    }
    case 'education':       return null;                   // Apollo's education is sparse — defer to enrich.so
  }
}

function pickFromEnrichSoReverse(
  field: EnrichmentFieldName,
  r: ReverseResult,
): { value: string; confidence: EnrichSoConfidence } | null {
  // Confidence is sourced from the central registry (provider × field) so a
  // single edit in fieldConfidenceRegistry.ts updates every code path that
  // consumes enrich.so reverse-lookup results. The 'email' signal reflects
  // that reverse lookup is keyed on email — registry can later upgrade
  // confidence for stronger signals (e.g. linkedin) if needed.
  const conf = (f: string): EnrichSoConfidence =>
    getFieldConfidence('enrich.so', f, 'email') as EnrichSoConfidence;
  switch (field) {
    case 'firstName':       return r.firstName        ? { value: r.firstName,        confidence: conf('firstName') } : null;
    case 'lastName':        return r.lastName         ? { value: r.lastName,         confidence: conf('lastName') } : null;
    case 'company':         return r.companyName      ? { value: r.companyName,      confidence: conf('company') } : null;
    case 'title':           return r.jobTitle         ? { value: r.jobTitle,         confidence: conf('title') } : null;
    case 'linkedin':        return r.profileUrl       ? { value: r.profileUrl,       confidence: conf('linkedin') } : null;
    case 'summary':         return r.summary          ? { value: r.summary,          confidence: conf('summary') } : null;
    case 'location':        return r.location         ? { value: r.location,         confidence: conf('location') } : null;
    case 'headline':        return r.headline         ? { value: r.headline,         confidence: conf('headline') } : null;
    case 'connectionCount': return typeof r.connectionCount === 'number' ? { value: String(r.connectionCount), confidence: conf('connectionCount') } : null;
    case 'skills':          return r.skills && r.skills.length ? { value: r.skills.slice(0, 5).join(', '), confidence: conf('skills') } : null;
    case 'pastCompanies':   return r.pastCompanies && r.pastCompanies.length ? { value: r.pastCompanies.join('; '), confidence: conf('pastCompanies') } : null;
    case 'education':       return r.education && r.education.length ? { value: r.education.join('; '), confidence: conf('education') } : null;
  }
}

/**
 * Provider order for **reverse-lookup fields** (firstName / lastName / title /
 * company / linkedin / headline / summary / skills / connectionCount / location /
 * pastCompanies / education).
 *
 * Rule: prefer enrich.so when it CAN answer — its reverse-lookup is keyed by
 * email, so if the lead has an email we route there first regardless of
 * whether a LinkedIn URL is also present. enrich.so is cheaper and already
 * validated, so paying for it first is the right default. Apollo is the
 * fallback when (a) the lead has no email so enrich.so can't reverse-lookup,
 * or (b) enrich.so returned a result that didn't include the specific field.
 */
function ordersForReverseLookup(lead: any): ProviderSource[] {
  return lead.email ? ['enrich.so', 'apollo'] : ['apollo', 'enrich.so'];
}

/**
 * Provider order for the **email finder** field.
 *
 * enrich.so's email finder is name + domain/company → email. It doesn't need
 * the lead's email at all (that's the output), so we always prefer enrich.so
 * first when it can be called. Apollo is the fallback (and Apollo's fallback
 * leg in turn enables `run_waterfall_email=true` to fan out through Apollo's
 * third-party broker chain — see resolveEmailWithWaterfall).
 */
function ordersForEmailFinder(): ProviderSource[] {
  return ['enrich.so', 'apollo'];
}

async function resolveFieldWithWaterfall(
  field: EnrichmentFieldName,
  lead: any,
  ctx: WaterfallContext,
): Promise<SpecialistResult | null> {
  for (const provider of ordersForReverseLookup(lead)) {
    // C10: pick the source label by the input signal that triggered the
    // lookup, not by which provider answered. Apollo and enrich.so are
    // web-aggregator services regardless; only mark `source: 'linkedin'`
    // when the lead's LinkedIn URL was the lookup key. The `provider`
    // field carries the granular label for UI/audit consumers.
    const inputSignalSource: SpecialistResult['source'] = lead.linkedin ? 'linkedin' : 'web_search';

    if (provider === 'apollo') {
      const m = await getApolloMatchForLead(lead, ctx);
      if (m?.found && m.match) {
        const picked = pickFromApolloMatch(field, m.match);
        if (picked && picked.value) {
          return {
            value: picked.value,
            confidence: picked.confidence,
            source: inputSignalSource,
            provider: 'apollo',
          };
        }
      }
    } else {
      const r = await getEnrichSoReverseForLead(lead, ctx);
      if (r?.found) {
        const picked = pickFromEnrichSoReverse(field, r);
        if (picked) {
          return {
            value: picked.value,
            confidence: picked.confidence,
            source: inputSignalSource,
            provider: 'enrich.so',
          };
        }
      }
    }
  }
  return null;
}

function buildWaterfallReverseSpec(field: EnrichmentFieldName): FieldSpecialist {
  return {
    fieldName: field,
    label: 'waterfall-reverse-lookup',
    resolve: async (lead, ctx) => {
      const cfg = normalizeEnrichmentFieldConfig(ctx.enrichmentFieldConfig);
      if (!cfg[field]) return null;
      return resolveFieldWithWaterfall(field, lead, { userId: ctx.userId, enrichmentFieldConfig: ctx.enrichmentFieldConfig });
    },
  };
}

/** 12 specialists, one per reverse-lookup field. */
export const waterfallReverseLookupSpecialists: FieldSpecialist[] = [
  buildWaterfallReverseSpec('firstName'),
  buildWaterfallReverseSpec('lastName'),
  buildWaterfallReverseSpec('company'),
  buildWaterfallReverseSpec('title'),
  buildWaterfallReverseSpec('linkedin'),
  buildWaterfallReverseSpec('summary'),
  buildWaterfallReverseSpec('skills'),
  buildWaterfallReverseSpec('connectionCount'),
  buildWaterfallReverseSpec('location'),
  buildWaterfallReverseSpec('headline'),
  buildWaterfallReverseSpec('pastCompanies'),
  buildWaterfallReverseSpec('education'),
];

// ─── Email finder waterfall ──────────────────────────────────────────────────

function extractDomainFromUrl(url: string): string | null {
  try {
    const withProtocol = /^https?:\/\//.test(url) ? url : `https://${url}`;
    const u = new URL(withProtocol);
    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    return host.includes('.') ? host : null;
  } catch {
    return null;
  }
}

/**
 * Public input shape for the email-finder waterfall. Used by Emma's
 * find_or_lookup_email tool, the CRM /leads/find-email route, and the bulk
 * find-emails background job. The specialist registry calls a thin adapter
 * over this same function below.
 */
export interface WaterfallFindEmailInput {
  firstName?: string;
  lastName?: string;
  domain?: string;
  company?: string;
  /** Optional. Helps Apollo's match call when present. */
  linkedin?: string;
  /** Optional. Helps Apollo cache cross-keying when known. */
  email?: string;
  /** Optional. Used to extract a domain when `domain` is absent. */
  website?: string;
  /** Tier 3 only. When set, the route will issue Apollo's run_waterfall_email
   *  call and stamp a placeholder cache row so the webhook can later land
   *  the email on this lead. Without this, Tier 3 is skipped (we have no
   *  lead to write to when the broker chain returns minutes later). */
  leadHint?: { listId: string; leadId: string };
}

export interface WaterfallFindEmailResult {
  found: boolean;
  email?: string;
  confidence?: EnrichSoConfidence;
  provider?: 'enrich.so' | 'apollo' | 'pattern';
  /** Apollo-specific email_status (verified / unverified / guessed / extrapolated). */
  emailStatus?: string;
  /** For pattern-based hits: which pattern matched (e.g. "f.l@domain"). */
  pattern?: string;
  /** Free-text from the underlying provider; useful for surfacing in UI tooltips. */
  message?: string;
  /** True when the answer came from cache (either provider). */
  fromCache?: boolean;
  /** Diagnostic: which tier resolved (1=enrich.so, 2=apollo basic, 3=apollo waterfall, 4=pattern). */
  tier?: 1 | 2 | 3 | 4;
  /**
   * Full Apollo /people/match payload, populated when Apollo's matchPerson
   * was the source of the email (Tier 2 first leg). Lets callers fill
   * adjacent missing fields — title, linkedin, employment history, company
   * tech stack, headcount growth, funding — without making a second API call.
   * Undefined for enrich.so / pattern / Apollo findEmail-only hits.
   */
  apolloMatch?: MappedMatch;
}

/**
 * Cross-provider email finder. Tries enrich.so first; if it misses, calls
 * Apollo (basic /people/match). Apollo's match accepts the lead's LinkedIn
 * URL as its strongest signal — so a lead with ONLY a LinkedIn URL still
 * resolves through Tier 2 even when name+domain aren't available.
 *
 * Each tier has its own preconditions; tiers whose preconditions aren't
 * met are silently skipped (e.g. Tier 1 needs name+domain/company; Tier 2
 * needs linkedin OR name+domain; Tier 4 needs name+domain).
 */
export async function waterfallFindEmail(
  input: WaterfallFindEmailInput,
  ctx: WaterfallContext,
): Promise<WaterfallFindEmailResult> {
  const firstName = (input.firstName ?? '').trim();
  const lastName = (input.lastName ?? '').trim();
  const domainFromInput = (input.domain ?? '').trim().toLowerCase();
  const domain = domainFromInput || (input.website ? extractDomainFromUrl(input.website) ?? '' : '');
  const company = (input.company ?? '').trim();
  const linkedin = (input.linkedin ?? '').trim();

  // Per-tier preconditions:
  //   Tier 1 (enrich.so finder): name + (domain || company)
  //   Tier 2 (Apollo match):     linkedin OR email OR (name + (domain || company))
  //   Tier 3 (Apollo waterfall): same as Tier 2 second leg + leadHint
  //   Tier 4 (pattern + valid):  name + domain (catchall-aware)
  // Bail completely only when no tier could possibly fire.
  const haveName = !!(firstName || lastName);
  const haveOrg = !!(domain || company);
  const tier1Possible = haveName && haveOrg;
  const tier2Possible = !!linkedin || !!input.email || (haveName && haveOrg);
  const tier4Possible = haveName && !!domain;
  if (!tier1Possible && !tier2Possible && !tier4Possible) {
    return { found: false };
  }

  const lead: any = {
    firstName, lastName,
    website: input.website,
    company: company || undefined,
    linkedin: linkedin || undefined,
    email: input.email || undefined,
  };

  for (const provider of ordersForEmailFinder()) {
    if (provider === 'enrich.so') {
      // ─── Tier 1: enrich.so email finder (needs name + domain/company) ───
      if (!tier1Possible) continue;
      let svc;
      try { svc = getEnrichSoService(); } catch { continue; }
      try {
        const r = await svc.findEmail(
          { firstName, lastName, domain: domain || undefined, company: domain ? undefined : company },
          { userId: ctx.userId },
        );
        if (r.found && r.email) {
          return {
            found: true,
            email: r.email,
            confidence: r.confidence ?? 'medium',
            provider: 'enrich.so',
            message: r.message,
            fromCache: r.fromCache,
            tier: 1,
          };
        }
      } catch { /* fall through */ }
    } else {
      // ─── Tier 2: Apollo basic /people/match ─────────────────────────────
      // First leg: shared matchPerson, which accepts linkedin_url as its
      // strongest match key. Fires whenever the lead has linkedin OR email
      // OR name+org — so linkedin-only leads still resolve here.
      if (tier2Possible) {
        const m = await getApolloMatchForLead(lead, ctx);
        if (m?.found && m.match?.person.email) {
          return {
            found: true,
            email: m.match.person.email,
            confidence: m.match.person.fieldConfidence.email ?? 'medium',
            emailStatus: m.match.person.emailStatus,
            provider: 'apollo',
            fromCache: m.fromCache,
            tier: 2,
            apolloMatch: m.match,   // ← full payload (person + organization)
          };
        }
      }
      // Second leg: Apollo's name+domain finder. Apollo's /people/match also
      // accepts linkedin_url, so when the lead has one we send it as an
      // additional match signal. Cache key stays name+domain (see
      // apolloCacheKeys.ts FindInput.linkedinUrl), so a future lookup with
      // a slightly different linkedin URL still hits the same find row.
      if (isApolloServiceReady() && haveName && (domain || company)) {
        try {
          const apolloSvc = getApolloService();
          const f = await apolloSvc.findEmail(
            {
              firstName,
              lastName,
              domain: domain || undefined,
              company: domain ? undefined : company,
              linkedinUrl: linkedin || undefined,
              linkedToEmail: input.email || undefined,
            },
            { userId: ctx.userId },
          );
          if (f.found && f.email) {
            const status = (f.emailStatus ?? '').toLowerCase();
            const confidence: EnrichSoConfidence =
              status === 'verified' ? 'high' :
              status === 'guessed' ? 'low' :
              'medium';
            return {
              found: true,
              email: f.email,
              confidence,
              emailStatus: f.emailStatus,
              provider: 'apollo',
              fromCache: f.fromCache,
              tier: 2,
            };
          }
        } catch { /* fall through */ }
      }
    }
  }

  // ─── Tier 3: Apollo /people/match with run_waterfall_email=true ─────────
  // Fires the broker chain. Same input requirements as Tier 2's second leg
  // (name + domain/company) plus leadHint — without a persisted lead to
  // attribute the async webhook result to, Tier 3 has no value.
  if (input.leadHint && isApolloServiceReady() && haveName && (domain || company)) {
    try {
      const apolloSvc = getApolloService();
      const f = await apolloSvc.findEmail(
        {
          firstName,
          lastName,
          domain: domain || undefined,
          company: domain ? undefined : company,
          linkedinUrl: linkedin || undefined,
          linkedToEmail: input.email || undefined,
        },
        { userId: ctx.userId, runWaterfall: true, leadHint: input.leadHint },
      );
      if (f.found && f.email) {
        // Sync hit (Apollo first-party).
        const status = (f.emailStatus ?? '').toLowerCase();
        const confidence: EnrichSoConfidence =
          status === 'verified' ? 'high' :
          status === 'guessed' ? 'low' :
          'medium';
        return {
          found: true,
          email: f.email,
          confidence,
          emailStatus: f.emailStatus,
          provider: 'apollo',
          fromCache: false,
          tier: 3,
        };
      }
      if (f.asyncPending && f.asyncRequestId) {
        // Apollo accepted the request and will POST the result later. Stamp
        // a placeholder cache row keyed by request_id so the webhook handler
        // can attribute the result to this lead. Continue to Tier 4 — the
        // sync response should still be a useful answer if Tier 4 hits.
        const key = apolloAsyncRequestCacheKey({ requestId: f.asyncRequestId });
        if (key) {
          // S13: Apollo's broker chain typically lands within minutes; the
          // placeholder only needs to survive that window plus a generous
          // buffer for retries / stuck queues. 7 days is plenty.
          const ttl = 7 * 86400;
          await crmDb.putEnrichmentCacheItem({
            canonicalId: key.canonicalId,
            fieldGroup: key.sk,
            canonicalKey: key.canonicalKey,
            entityKey: key.entityKey,
            entityType: 'apollo',
            rawData: {
              listId: input.leadHint.listId,
              leadId: input.leadHint.leadId,
              userId: ctx.userId,           // C1: webhook re-verifies ownership against the list owner
              status: 'pending',
              firstName, lastName, domain: domain || null,
            },
            queryUsed: '',
            sourcesUsed: ['apollo'],
            resultCount: 0,
            schemaVersion: APOLLO_SCHEMA_VERSION,
            fetchedAt: new Date().toISOString(),
            expiresAt: Math.floor(Date.now() / 1000) + ttl,
            cacheType: 'apollo',
          }).catch((err) => {
            // C9: surface placeholder write failures. Without the placeholder,
            // the eventual webhook arrival has no way to attribute the result
            // to a lead — the email is silently lost. Log loudly so this is
            // visible in dashboards/alerts.
            console.error(
              '[waterfall] Tier 3 placeholder write failed for request_id',
              f.asyncRequestId,
              '— webhook will not be attributable:',
              (err as Error).message,
            );
          });
        }
        // Don't return — fall through to Tier 4 so we still have a sync answer.
      }
    } catch { /* fall through */ }
  }

  // ─── Tier 4: Pattern generator + enrich.so validation ───────────────────
  // Last-resort. Generates ~10 common email patterns and validates each via
  // enrich.so until one comes back deliverable. Bails on catchall domains.
  // Requires both name and domain — patterns can't be generated without them.
  if (tier4Possible) {
    const pat = await findEmailViaPatterns(firstName, lastName, domain, { userId: ctx.userId });
    if (pat.found && pat.email) {
      return {
        found: true,
        email: pat.email,
        confidence: pat.status === 'deliverable' ? 'medium' : 'low',
        provider: 'pattern',
        pattern: pat.pattern,
        message: `Pattern guess validated as ${pat.status} after ${pat.attempts} attempts`,
        tier: 4,
      };
    }
  }

  return { found: false };
}

export const waterfallEmailFinderSpecialist: FieldSpecialist = {
  fieldName: 'email',
  label: 'waterfall-email-finder',
  resolve: async (lead, ctx): Promise<SpecialistResult | null> => {
    const r = await waterfallFindEmail(
      {
        firstName: lead.firstName,
        lastName: lead.lastName,
        domain: undefined,
        company: lead.company,
        linkedin: lead.linkedin,
        email: lead.email,
        website: lead.website,
      },
      { userId: ctx.userId, enrichmentFieldConfig: ctx.enrichmentFieldConfig },
    );
    if (!r.found || !r.email) return null;
    return {
      value: r.email,
      confidence: r.confidence ?? 'medium',
      source: 'web_search',
      provider: r.provider,
      sourceQuote: r.message
        ?? (r.emailStatus ? `Apollo (${r.emailStatus})` : undefined),
    };
  },
};

// Helpers used by Apollo-only specialists to share the same in-flight promise.
export async function waterfallApolloMatch(lead: any, ctx: WaterfallContext): Promise<ApolloMatchResult | null> {
  return getApolloMatchForLead(lead, ctx);
}
