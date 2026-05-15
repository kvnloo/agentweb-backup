/**
 * Emma tool: find_or_lookup_email
 *
 * One tool, three input shapes (per user request):
 *   1. email               → reverse lookup (returns profile)
 *   2. firstName/lastName  → email finder (returns email)
 *   3. leadId (+ listId)   → resolves the lead, then picks one of (1)/(2)
 *
 * Plus `bulk: [...]` for batch processing (Promise.allSettled — one failure
 * doesn't kill the rest). Returns structured data only — does NOT auto-update
 * leads. Emma is expected to summarise / patch leads via other tools.
 *
 * Quota: counts against the same per-user lookup quota as the UI routes.
 */

import { emmaToolRegistry } from './registry';
import { getEnrichSoService } from '../services/enrichSoService';
import { LookupByEmailQuotaExceededError } from '../services/enrichSoQuota';
import { waterfallFindEmail } from '../services/enrichmentWaterfall';
import { crmDb } from '../services/db';

interface SingleInput {
  email?: string;
  firstName?: string;
  lastName?: string;
  company?: string;
  domain?: string;
  /** LinkedIn URL — Apollo's strongest match key. Linkedin alone is enough
   *  to find an email through Tier 2 of the waterfall. */
  linkedin?: string;
  leadId?: string;
  listId?: string;
}

interface ResolvedProfile {
  found: boolean;
  email?: string;
  firstName?: string;
  lastName?: string;
  displayName?: string;
  company?: string;
  title?: string;
  linkedin?: string;
  location?: string;
  headline?: string;
  confidence?: 'high' | 'medium' | 'low';
  fromCache?: boolean;
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function resolveSingle(input: SingleInput, userId: string): Promise<{ input: SingleInput } & ResolvedProfile> {
  const svc = getEnrichSoService();

  // Materialise inputs from leadId if provided (lookup wins over name+company).
  if (input.leadId && input.listId) {
    const lead: any = await crmDb.getLeadById(input.listId, input.leadId).catch(() => null);
    if (lead) {
      // Inline the lead's fields so the rest of the resolver can use the same
      // logic regardless of how the input arrived. Includes linkedin so a lead
      // with only a LinkedIn URL still routes through Tier 2 of the waterfall.
      input = {
        ...input,
        email: input.email || lead.email,
        firstName: input.firstName || lead.firstName,
        lastName: input.lastName || lead.lastName,
        company: input.company || lead.company,
        linkedin: input.linkedin || lead.linkedin,
      };
    }
  }

  const email = (input.email ?? '').trim().toLowerCase();

  // Path 1: email present → reverse lookup
  if (email) {
    if (!EMAIL_REGEX.test(email) || email.length > 254) {
      return { input, found: false };
    }
    const r = await svc.reverseLookup(email, { userId });
    return {
      input,
      found: r.found,
      email,
      firstName: r.firstName,
      lastName: r.lastName,
      displayName: r.displayName,
      company: r.companyName,
      title: r.jobTitle,
      linkedin: r.profileUrl,
      location: r.location,
      headline: r.headline,
      fromCache: r.fromCache,
    };
  }

  // Path 2: linkedin URL OR (name + (company || domain)) → email finder.
  // Routes through the cross-provider waterfall:
  //   Tier 1 enrich.so → Tier 2 Apollo (linkedin or name+org) →
  //   Tier 3 Apollo waterfall → Tier 4 patterns + enrich.so validation.
  // Linkedin alone is enough — Apollo's matchPerson resolves identity from it.
  const firstName = (input.firstName ?? '').trim();
  const lastName = (input.lastName ?? '').trim();
  const domain = (input.domain ?? '').trim().toLowerCase();
  const company = (input.company ?? '').trim();
  const linkedin = (input.linkedin ?? '').trim();
  const haveName = !!(firstName || lastName);
  const haveOrg = !!(domain || company);
  if (!linkedin && !(haveName && haveOrg)) {
    return { input, found: false };
  }
  const r = await waterfallFindEmail(
    {
      firstName,
      lastName,
      domain: domain || undefined,
      company: domain ? undefined : company,
      linkedin: linkedin || undefined,
    },
    { userId },
  );
  return {
    input,
    found: r.found,
    email: r.email,
    firstName,
    lastName,
    company: company || undefined,
    confidence: r.confidence,
    fromCache: r.fromCache,
  };
}

emmaToolRegistry.register({
  name: 'find_or_lookup_email',
  definition: {
    name: 'find_or_lookup_email',
    description:
      'Find a professional email or look up a profile by email. ' +
      'Pass any one of: (a) `email` to reverse-lookup, (b) `linkedin` URL to find an email via Apollo (linkedin alone is enough), ' +
      '(c) `firstName`+`lastName`+(`company` or `domain`) to find an email through the full waterfall, ' +
      'or (d) `leadId`+`listId` to resolve from a CRM lead automatically (pulls linkedin/name/company off the lead). ' +
      'Use `bulk` for batch operations. Returns structured data — does NOT modify the CRM lead.',
    inputSchema: {
      type: 'object',
      properties: {
        // Single-input fields
        email: { type: 'string', description: 'Email to reverse-lookup' },
        firstName: { type: 'string' },
        lastName: { type: 'string' },
        company: { type: 'string', description: 'Company name (used when domain is unknown)' },
        domain: { type: 'string', description: 'Company domain like acme.com (preferred over company name)' },
        linkedin: { type: 'string', description: 'LinkedIn profile URL — alone is enough to find an email via Apollo' },
        leadId: { type: 'string', description: 'CRM lead ID — resolves email/name/company/linkedin from the lead automatically' },
        listId: { type: 'string', description: 'CRM list ID (required when leadId is provided)' },

        // Bulk
        bulk: {
          type: 'array',
          description: 'Array of input objects (each with the same fields as above) for batch processing',
          items: {
            type: 'object',
            properties: {
              email: { type: 'string' },
              firstName: { type: 'string' },
              lastName: { type: 'string' },
              company: { type: 'string' },
              domain: { type: 'string' },
              linkedin: { type: 'string' },
              leadId: { type: 'string' },
              listId: { type: 'string' },
            },
          },
        },
      },
    },
  },
  execute: async (args: any, context: any) => {
    const userId = context?.userId || context?.agentUserId;
    if (!userId) {
      throw new Error('Authentication required: no user context');
    }

    const inputs: SingleInput[] = Array.isArray(args?.bulk) && args.bulk.length > 0
      ? args.bulk
      : [args ?? {}];

    if (inputs.length === 0) {
      return { results: [], message: 'No inputs provided.' };
    }

    // Cap bulk size so a stray Emma call can't burn the user's whole daily
    // quota in one tool invocation. 25 is small enough to stay well under the
    // 50/day route cap and large enough to be useful.
    const MAX_BULK = 25;
    const trimmed = inputs.slice(0, MAX_BULK);
    const truncated = inputs.length > MAX_BULK;

    const settled = await Promise.allSettled(
      trimmed.map((input) => resolveSingle(input, userId)),
    );

    let quotaHit = false;
    const results = settled.map((s, i) => {
      if (s.status === 'fulfilled') return s.value;
      const err = s.reason as any;
      if (err instanceof LookupByEmailQuotaExceededError) quotaHit = true;
      return {
        input: trimmed[i],
        found: false,
        error: err?.message ?? String(err),
      };
    });

    return {
      results,
      total: inputs.length,
      processed: trimmed.length,
      truncated: truncated ? `Bulk capped at ${MAX_BULK} — ${inputs.length - MAX_BULK} skipped` : undefined,
      quotaExceeded: quotaHit ? 'Daily lookup quota reached — some lookups were not performed' : undefined,
    };
  },
});
