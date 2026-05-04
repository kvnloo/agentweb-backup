/**
 * Reverse-lookup specialists (enrich.so).
 *
 * Five specialists share a single reverseLookup call per (lead.email):
 *   firstName, lastName, company, title, linkedin
 *
 * The runSpecialists pipeline runs them in parallel via Promise.all, so without
 * dedup we'd issue N concurrent identical lookups. The in-flight promise cache
 * collapses parallel calls to one; once the first resolves, the EnrichSoService
 * memory LRU + DDB cache handle the rest.
 *
 * Scope: cache holds *in-flight* promises only. The service handles longer-term
 * caching. Entries are removed when the promise settles — this map never grows
 * beyond the number of distinct emails currently being looked up at once.
 */

import type { FieldSpecialist, SpecialistResult } from '../enrichmentSpecialists';
import { getEnrichSoService, type ReverseResult } from '../enrichSoService';

const inflight = new Map<string, Promise<ReverseResult | null>>();

/** Test-only: clear the in-flight map between tests. */
export function __resetReverseLookupDedupForTesting(): void {
  inflight.clear();
}

async function getReverseLookupForLead(lead: any, ctx: { userId: string }): Promise<ReverseResult | null> {
  const email = (lead.email ?? '').trim().toLowerCase();
  if (!email) return null;

  // Dedup key includes userId so two users hitting the same email in parallel
  // each get their own quota counted, but a single user's parallel specialists
  // collapse to one call.
  const dedupKey = `${ctx.userId}:${email}`;
  const existing = inflight.get(dedupKey);
  if (existing) return existing;

  let svc;
  try {
    svc = getEnrichSoService();
  } catch {
    return null;
  }

  const p = svc.reverseLookup(email, { userId: ctx.userId }).catch(() => null);
  inflight.set(dedupKey, p);
  try {
    return await p;
  } finally {
    inflight.delete(dedupKey);
  }
}

function buildSpec(
  fieldName: string,
  pick: (r: ReverseResult) => string | undefined,
): FieldSpecialist {
  return {
    fieldName,
    label: 'enrichso-reverse-lookup',
    resolve: async (lead, ctx) => {
      const r = await getReverseLookupForLead(lead, ctx);
      if (!r || !r.found) return null;
      const value = pick(r);
      if (!value) return null;
      return {
        value,
        confidence: 'high',
        source: 'linkedin',
        provider: 'enrich.so',
      } satisfies SpecialistResult;
    },
  };
}

export const enrichSoReverseLookupSpecialists: FieldSpecialist[] = [
  buildSpec('firstName', r => r.firstName),
  buildSpec('lastName', r => r.lastName),
  buildSpec('company', r => r.companyName),
  buildSpec('title', r => r.jobTitle),
  buildSpec('linkedin', r => r.profileUrl),
];
