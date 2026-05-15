/**
 * Apollo-only specialist that produces the `employmentHistory` field
 * (stored on `customFields.employmentHistory` as a JSON string).
 *
 * Only Apollo returns this — no waterfall fallback. Reuses the in-flight
 * Apollo match cache shared by the rest of the waterfall, so it doesn't
 * trigger a second API call for leads that already had reverse-lookup run.
 */

import type { FieldSpecialist, SpecialistResult } from '../enrichmentSpecialists';
import { waterfallApolloMatch } from '../enrichmentWaterfall';

export const apolloEmploymentHistorySpecialist: FieldSpecialist = {
  fieldName: 'employmentHistory',
  label: 'apollo-employment-history',
  resolve: async (lead, ctx): Promise<SpecialistResult | null> => {
    const m = await waterfallApolloMatch(lead, { userId: ctx.userId, enrichmentFieldConfig: ctx.enrichmentFieldConfig });
    if (!m?.found || !m.match) return null;
    const history = m.match.person.employmentHistory;
    if (!history || history.length === 0) return null;

    // Stored as JSON in customFields so the existing string-typed customFields
    // bag accepts it. UI reads + parses for the timeline component.
    const value = JSON.stringify(history);
    return {
      value,
      confidence: m.match.person.fieldConfidence.employmentHistory ?? 'medium',
      source: 'linkedin',
      provider: 'apollo',
    };
  },
};
