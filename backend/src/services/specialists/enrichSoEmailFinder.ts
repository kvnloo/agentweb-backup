/**
 * Email finder specialist (enrich.so).
 *
 * Provides the `email` field for leads with firstName + lastName + (website or
 * company). Runs before the LLM-extraction step. If enrich.so cannot find an
 * email, returns null so the LLM-extraction path can attempt a guess.
 *
 * Service errors are swallowed (return null) so an outage doesn't break the
 * enrichment pipeline — the LLM fallback continues to run.
 */

import type { FieldSpecialist, SpecialistResult } from '../enrichmentSpecialists';
import { getEnrichSoService } from '../enrichSoService';

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

async function resolveEmail(lead: any, ctx: { userId: string }): Promise<SpecialistResult | null> {
  const firstName = (lead.firstName ?? '').trim();
  const lastName = (lead.lastName ?? '').trim();
  if (!firstName && !lastName) return null;

  const domain = lead.website ? extractDomainFromUrl(lead.website) : null;
  const company = (lead.company ?? '').trim();
  if (!domain && !company) return null;

  let svc;
  try {
    svc = getEnrichSoService();
  } catch {
    return null;  // service not initialized — let LLM fallback handle it
  }

  try {
    const r = await svc.findEmail(
      {
        firstName,
        lastName,
        domain: domain ?? undefined,
        company: domain ? undefined : company,
      },
      { userId: ctx.userId },
    );
    if (!r.found || !r.email) return null;
    return {
      value: r.email,
      confidence: r.confidence ?? 'medium',
      source: 'web_search',
      sourceQuote: r.message,
    };
  } catch {
    return null;
  }
}

export const enrichSoEmailFinderSpecialist: FieldSpecialist = {
  fieldName: 'email',
  label: 'enrichso-email-finder',
  resolve: resolveEmail,
};
