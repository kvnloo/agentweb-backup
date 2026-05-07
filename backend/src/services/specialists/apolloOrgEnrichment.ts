/**
 * Apollo-only specialists that produce company-level firmographic fields.
 *
 * Source: the `organization` block returned alongside /people/match. This
 * means we only get firmographics when an Apollo match also returns a
 * person — that's intentional, since most CRM use cases enrich a person
 * and want the company context as a side benefit, not standalone.
 *
 * For domain-only enrichment (no person), use the `apolloOrgService.matchOrg()`
 * directly via a dedicated route; that path is not part of the field-specialist
 * pipeline because the pipeline is keyed on a Lead, not a Domain.
 *
 * Output fields (all stored in customFields):
 *   - companyTechStack          (semicolon-joined)
 *   - companyHeadcountGrowth6mo / 12mo / 24mo  (string of percentage)
 *   - companyFundingTotal        (number string)
 *   - companyFundingStage        (e.g. "Series B")
 *   - companyFundingLastRoundDate (ISO date)
 *   - companyAnnualRevenue       (number string)
 *   - companyDepartmentHeadcount (JSON string)
 */

import type { FieldSpecialist, SpecialistResult } from '../enrichmentSpecialists';
import { waterfallApolloMatch } from '../enrichmentWaterfall';
import type { MappedOrganization } from '../apolloFieldMapper';

type OrgFieldName =
  | 'companyTechStack'
  | 'companyHeadcountGrowth6mo'
  | 'companyHeadcountGrowth12mo'
  | 'companyHeadcountGrowth24mo'
  | 'companyFundingTotal'
  | 'companyFundingStage'
  | 'companyFundingLastRoundDate'
  | 'companyAnnualRevenue'
  | 'companyDepartmentHeadcount';

function pickOrgValue(field: OrgFieldName, org: MappedOrganization): string | null {
  switch (field) {
    case 'companyTechStack':
      return org.techStack && org.techStack.length ? org.techStack.join('; ') : null;
    case 'companyHeadcountGrowth6mo':
      return typeof org.headcountGrowth6mo === 'number' ? String(org.headcountGrowth6mo) : null;
    case 'companyHeadcountGrowth12mo':
      return typeof org.headcountGrowth12mo === 'number' ? String(org.headcountGrowth12mo) : null;
    case 'companyHeadcountGrowth24mo':
      return typeof org.headcountGrowth24mo === 'number' ? String(org.headcountGrowth24mo) : null;
    case 'companyFundingTotal':
      return typeof org.totalFunding === 'number' ? String(org.totalFunding) : null;
    case 'companyFundingStage':
      return org.latestFundingStage ?? null;
    case 'companyFundingLastRoundDate':
      return org.latestFundingRoundDate ?? null;
    case 'companyAnnualRevenue':
      return typeof org.annualRevenue === 'number'
        ? String(org.annualRevenue)
        : (org.annualRevenuePrinted ?? null);
    case 'companyDepartmentHeadcount':
      return org.departmentHeadcount && Object.keys(org.departmentHeadcount).length
        ? JSON.stringify(org.departmentHeadcount)
        : null;
  }
}

/**
 * Per-field confidence for Apollo org data. Apollo doesn't return field-level
 * confidence on /organizations/enrich, so we infer:
 *   - 'high'   for factual public-record fields (funding rounds, dates)
 *   - 'medium' for current-state fields refreshed weekly (tech stack, growth)
 *   - 'low'    for estimates Apollo synthesizes (annual revenue, dept headcount)
 */
const ORG_FIELD_CONFIDENCE: Record<OrgFieldName, SpecialistResult['confidence']> = {
  companyTechStack: 'medium',
  companyHeadcountGrowth6mo: 'medium',
  companyHeadcountGrowth12mo: 'medium',
  companyHeadcountGrowth24mo: 'medium',
  companyFundingTotal: 'high',
  companyFundingStage: 'high',
  companyFundingLastRoundDate: 'high',
  companyAnnualRevenue: 'low',           // estimate
  companyDepartmentHeadcount: 'low',     // estimate
};

function buildSpec(field: OrgFieldName): FieldSpecialist {
  return {
    fieldName: field,
    label: 'apollo-org-enrichment',
    resolve: async (lead, ctx): Promise<SpecialistResult | null> => {
      const m = await waterfallApolloMatch(lead, { userId: ctx.userId, enrichmentFieldConfig: ctx.enrichmentFieldConfig });
      if (!m?.found || !m.match?.organization) return null;
      const value = pickOrgValue(field, m.match.organization);
      if (!value) return null;
      return {
        value,
        confidence: ORG_FIELD_CONFIDENCE[field],
        source: 'web_search',
        provider: 'apollo',
      };
    },
  };
}

export const apolloOrgEnrichmentSpecialists: FieldSpecialist[] = [
  buildSpec('companyTechStack'),
  buildSpec('companyHeadcountGrowth6mo'),
  buildSpec('companyHeadcountGrowth12mo'),
  buildSpec('companyHeadcountGrowth24mo'),
  buildSpec('companyFundingTotal'),
  buildSpec('companyFundingStage'),
  buildSpec('companyFundingLastRoundDate'),
  buildSpec('companyAnnualRevenue'),
  buildSpec('companyDepartmentHeadcount'),
];
