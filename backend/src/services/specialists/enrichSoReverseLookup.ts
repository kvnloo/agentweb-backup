/**
 * Reverse-lookup specialists (enrich.so).
 *
 * Specialists share a single reverseLookup call per (lead.email):
 *   firstName, lastName, company, title, linkedin   ← standard (default ON)
 *   summary, skills, connectionCount, location,
 *   headline, pastCompanies, education              ← extended (default OFF)
 *
 * Each specialist consults `ctx.enrichmentFieldConfig` to decide whether to
 * write to the lead. The underlying API call is unaffected — every reverse
 * lookup still fetches and caches the full profile, so toggling a field ON
 * later is a free (cache-hit) operation.
 *
 * runSpecialists runs them in parallel via Promise.all, so without dedup we'd
 * issue N concurrent identical lookups. The in-flight promise cache collapses
 * parallel calls to one; once the first resolves, the EnrichSoService memory
 * LRU + DDB cache handle the rest.
 */

import type { FieldSpecialist, SpecialistResult } from '../enrichmentSpecialists';
import { getEnrichSoService, type ReverseResult } from '../enrichSoService';
import {
  type EnrichmentFieldName,
  normalizeEnrichmentFieldConfig,
} from '../enrichmentFieldConfig';
import { getFieldConfidence } from '../fieldConfidenceRegistry';

const inflight = new Map<string, Promise<ReverseResult | null>>();

/** Test-only: clear the in-flight map between tests. */
export function __resetReverseLookupDedupForTesting(): void {
  inflight.clear();
}

async function getReverseLookupForLead(lead: any, ctx: { userId: string }): Promise<ReverseResult | null> {
  const email = (lead.email ?? '').trim().toLowerCase();
  if (!email) return null;

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

/** Pick a string from the reverse result for a given field. Returns null when
 * the field can't be derived from the response. Arrays are joined with the
 * convention documented for each field. */
function pickFieldValue(r: ReverseResult, field: EnrichmentFieldName): string | null {
  switch (field) {
    case 'firstName':       return r.firstName ?? null;
    case 'lastName':        return r.lastName ?? null;
    case 'company':         return r.companyName ?? null;
    case 'title':           return r.jobTitle ?? null;
    case 'linkedin':        return r.profileUrl ?? null;
    case 'summary':         return r.summary ?? null;
    case 'location':        return r.location ?? null;
    case 'headline':        return r.headline ?? null;
    case 'connectionCount': return typeof r.connectionCount === 'number' ? String(r.connectionCount) : null;
    case 'skills':          return r.skills && r.skills.length ? r.skills.slice(0, 5).join(', ') : null;
    case 'pastCompanies':   return r.pastCompanies && r.pastCompanies.length ? r.pastCompanies.join('; ') : null;
    case 'education':       return r.education && r.education.length ? r.education.join('; ') : null;
  }
}

function buildSpec(field: EnrichmentFieldName): FieldSpecialist {
  return {
    fieldName: field,
    label: 'enrichso-reverse-lookup',
    resolve: async (lead, ctx) => {
      // Gate on per-list config: defaults applied for missing keys (standard
      // fields ON, extended OFF). When ctx has no config at all (legacy
      // callers), the same defaults apply.
      const cfg = normalizeEnrichmentFieldConfig(ctx.enrichmentFieldConfig);
      if (!cfg[field]) return null;

      const r = await getReverseLookupForLead(lead, ctx);
      if (!r || !r.found) return null;

      const value = pickFieldValue(r, field);
      if (!value) return null;

      return {
        value,
        // Confidence is sourced from the central registry so identity fields
        // stay 'high' while drift-prone (title/company) and historical
        // (pastCompanies, skills, education, summary) fields land at 'medium'.
        confidence: getFieldConfidence('enrich.so', field, 'email'),
        source: 'linkedin',
        provider: 'enrich.so',
      } satisfies SpecialistResult;
    },
  };
}

export const enrichSoReverseLookupSpecialists: FieldSpecialist[] = [
  buildSpec('firstName'),
  buildSpec('lastName'),
  buildSpec('company'),
  buildSpec('title'),
  buildSpec('linkedin'),
  buildSpec('summary'),
  buildSpec('skills'),
  buildSpec('connectionCount'),
  buildSpec('location'),
  buildSpec('headline'),
  buildSpec('pastCompanies'),
  buildSpec('education'),
];
