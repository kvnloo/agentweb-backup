/**
 * Project an Apollo /people/match payload onto a Lead's missing fields.
 *
 * Used in two places:
 *   1. Bulk Find emails — when waterfall hits via Apollo, fill adjacent
 *      missing fields (title, linkedin, company, employment history, tech
 *      stack, etc.) so the user gets the full benefit of the API call.
 *   2. Bulk Enrich with Apollo — same projection, just driven by a
 *      different entry point.
 *
 * Behavior:
 *   - **Never overwrites** existing values. If a field has any truthy value
 *     on the lead, the helper skips it. Protects user edits and prior
 *     enrichment runs.
 *   - Returns a `{ updates, customFields, enrichmentMetadata, changed }`
 *     bundle. The caller decides whether to apply via crmDb.updateLead.
 *   - The `changed` set names every field the helper actually wants to
 *     write, so callers can short-circuit when nothing changed.
 */

import type { MappedMatch } from './apolloFieldMapper';
import { getFieldConfidence } from './fieldConfidenceRegistry';
import { isValidFieldValue } from './fieldValueValidator';

interface ApplyResult {
  updates: Record<string, any>;
  customFields: Record<string, any>;
  enrichmentMetadata: Record<string, any>;
  /** Set of field names this projection wants to write. Empty when no-op. */
  changed: Set<string>;
}

interface InputLead {
  firstName?: string;
  lastName?: string;
  email?: string;
  title?: string;
  linkedin?: string;
  company?: string;
  companyLinkedin?: string;
  customFields?: Record<string, any>;
  enrichmentMetadata?: Record<string, any>;
}

interface Options {
  /** When true, also fills the email field. Bulk find-emails sets this true
   *  (the email is the whole point of the call); enrich-with-apollo passes
   *  it true too. */
  fillEmail?: boolean;
  /** Toggle for the BulkEnrichmentDialog "Apollo" mode — defaults true. When
   *  false, skips all person-level fields (name, email, linkedin, title,
   *  seniority, employment history). */
  includePerson?: boolean;
  /** Toggle for the BulkEnrichmentDialog "Apollo" mode — defaults true. When
   *  false, skips company name, tech stack, headcount growth, funding, etc. */
  includeOrg?: boolean;
  /** When true, restrict the projection to a small "identity" set:
   *  email, firstName, lastName, title, company, linkedin, companyLinkedin,
   *  location. Skips seniority, apolloPersonId, employment history, tech
   *  stack, headcount growth, funding, revenue. Used by find-email +
   *  bulk-enrich flows where users only want core profile fields auto-filled. */
  minimalFields?: boolean;
}

export function applyApolloMatchToLead(
  lead: InputLead,
  match: MappedMatch,
  opts: Options = {},
): ApplyResult {
  const updates: Record<string, any> = {};
  const customFields: Record<string, any> = {};
  const newMeta: Record<string, any> = { ...((lead.enrichmentMetadata ?? {}) as Record<string, any>) };
  const changed = new Set<string>();
  const now = new Date().toISOString();

  const tag = (
    confidence: 'high' | 'medium' | 'low' = 'medium',
    source: 'linkedin' | 'web_search' = 'linkedin',
  ) => ({ source, provider: 'apollo' as const, confidence, enrichedAt: now });

  const p = match.person;
  const o = match.organization;
  const includePerson = opts.includePerson !== false;
  const includeOrg = opts.includeOrg !== false;
  const minimal = opts.minimalFields === true;
  const existingCustom = (lead.customFields ?? {}) as Record<string, any>;

  // Person fields — only written when missing AND person-projection enabled.
  if (includePerson) {
    if (opts.fillEmail !== false && !lead.email && p.email) {
      updates.email = p.email;
      newMeta.email = tag(p.fieldConfidence.email, 'web_search');
      changed.add('email');
    }
    if (!lead.firstName && p.firstName) {
      updates.firstName = p.firstName;
      newMeta.firstName = tag(p.fieldConfidence.firstName);
      changed.add('firstName');
    }
    if (!lead.lastName && p.lastName) {
      updates.lastName = p.lastName;
      newMeta.lastName = tag(p.fieldConfidence.lastName);
      changed.add('lastName');
    }
    if (!lead.title && p.title) {
      updates.title = p.title;
      newMeta.title = tag(p.fieldConfidence.title);
      changed.add('title');
    }
    if (!lead.linkedin && p.linkedin && isValidFieldValue('linkedin', p.linkedin)) {
      updates.linkedin = p.linkedin;
      newMeta.linkedin = tag(p.fieldConfidence.linkedin);
      changed.add('linkedin');
    }
    if (minimal) {
      // Join whichever of city/state/country are present into a single
      // `location` custom-field string — same key the enrich.so reverse
      // lookup writes, so downstream UI/views render it consistently.
      const loc = [p.city, p.state, p.country].filter(Boolean).join(', ');
      if (loc && !existingCustom.location) {
        customFields.location = loc;
        changed.add('location');
      }
    } else {
      // apolloPersonId is always recorded for follow-up actions (phone reveals etc.).
      if (p.apolloPersonId && existingCustom.apolloPersonId !== p.apolloPersonId) {
        customFields.apolloPersonId = p.apolloPersonId;
        changed.add('apolloPersonId');
      }
      if (p.title && !existingCustom.apolloTitle) {
        customFields.apolloTitle = p.title;
        changed.add('apolloTitle');
      }
      if (p.seniority && !existingCustom.apolloSeniority) {
        customFields.apolloSeniority = p.seniority;
        changed.add('apolloSeniority');
      }
      if (p.employmentHistory && p.employmentHistory.length && !existingCustom.employmentHistory) {
        customFields.employmentHistory = JSON.stringify(p.employmentHistory);
        // Source-of-truth for confidence is the central registry — no behavior
        // change for this field today, but new fields land here automatically.
        newMeta.employmentHistory = tag(getFieldConfidence('apollo', 'employmentHistory'));
        changed.add('employmentHistory');
      }
    }
  }

  // Organization fields — only written when org block returned AND org-projection enabled.
  if (includeOrg && o) {
    if (!lead.company && o.name) {
      updates.company = o.name;
      newMeta.company = tag('medium');
      changed.add('company');
    }
    if (!lead.companyLinkedin && o.linkedinUrl && isValidFieldValue('companyLinkedin', o.linkedinUrl)) {
      updates.companyLinkedin = o.linkedinUrl;
      newMeta.companyLinkedin = tag('medium');
      changed.add('companyLinkedin');
    }
    if (!minimal) {
      if (o.techStack && o.techStack.length && !existingCustom.companyTechStack) {
        customFields.companyTechStack = o.techStack.join('; ');
        newMeta.companyTechStack = tag(getFieldConfidence('apollo', 'companyTechStack'), 'web_search');
        changed.add('companyTechStack');
      }
      const orgFields: Array<[string, string | number | undefined]> = [
        ['companyHeadcountGrowth6mo',  o.headcountGrowth6mo],
        ['companyHeadcountGrowth12mo', o.headcountGrowth12mo],
        ['companyHeadcountGrowth24mo', o.headcountGrowth24mo],
        ['companyFundingTotal',        o.totalFunding],
        ['companyFundingStage',        o.latestFundingStage],
        ['companyFundingLastRoundDate', o.latestFundingRoundDate],
        ['companyAnnualRevenue',        o.annualRevenue ?? o.annualRevenuePrinted],
      ];
      for (const [k, v] of orgFields) {
        if (v != null && v !== '' && !existingCustom[k]) {
          customFields[k] = typeof v === 'number' ? String(v) : v;
          changed.add(k);
        }
      }
    }
  }

  return {
    updates,
    customFields,
    enrichmentMetadata: newMeta,
    changed,
  };
}
