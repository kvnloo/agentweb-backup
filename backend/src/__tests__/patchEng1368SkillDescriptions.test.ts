/**
 * Tests for patch-eng1368-skill-descriptions.ts (ENG-1368).
 * Pure data checks only — no DynamoDB-dependent main().
 */
import { describe, it, expect } from '@jest/globals';

import { SKILL_DESCRIPTION_UPDATES } from '../scripts/patch-eng1368-skill-descriptions';

describe('patch-eng1368-skill-descriptions', () => {
  it('targets exactly the 5 skill IDs named in ENG-1368', () => {
    expect(Object.keys(SKILL_DESCRIPTION_UPDATES).sort()).toEqual(
      [
        '1ad6f950-edc7-4aec-93cf-d52b834439f8',
        '6abd9a7f-55b0-428c-8b7f-aa107829407d',
        '834e5e76-4f98-4065-9d79-2c56aa1a135f',
        'ca99eb0c-5d69-41d4-8997-516b5bb2d228',
        'f36b423e-e2c0-4e3f-859e-69156188dfe5',
      ].sort()
    );
  });

  it('Conversion Tracking Validator description matches ENG-1368 verbatim', () => {
    expect(SKILL_DESCRIPTION_UPDATES['1ad6f950-edc7-4aec-93cf-d52b834439f8']).toBe(
      "Google Ads conversion tracking audit — also covers Meta Ads pixel/CAPI and LinkedIn Insight Tag. Verifies conversion actions are firing, checks enhanced conversions enablement, flags counting-setting mismatches (every vs. one), validates GA4 import linkage, and compares cross-platform conversion counts to surface discrepancies. Use this when campaigns show zero or suspicious conversions, when conversion numbers don't match CRM, or before scaling spend. Read-only diagnostic; never modifies tracking configuration."
    );
  });

  it('Landing Page Checker (Ads) description matches ENG-1368 verbatim', () => {
    expect(SKILL_DESCRIPTION_UPDATES['f36b423e-e2c0-4e3f-859e-69156188dfe5']).toBe(
      "Google Ads landing page audit — also covers Meta and LinkedIn ad destinations. Maps every active ad to its final URL, then audits each page carrying real spend: load speed, mobile-friendliness, message match between ad copy and page headline, form field count and friction, above-the-fold CTA presence, and broken/redirect URLs. Ranks pages by dollar exposure and flags Quality Score \"Landing Page Experience: below average\" keywords. Use when ad performance is poor, bounce rates are high, or after launching new landing pages. Read-only diagnostic."
    );
  });

  it('Cross-Channel Budget Engine description matches ENG-1368 verbatim', () => {
    expect(SKILL_DESCRIPTION_UPDATES['ca99eb0c-5d69-41d4-8997-516b5bb2d228']).toBe(
      "Cross-channel paid media budget optimizer — compares ROAS and performance across Google Ads, Meta Ads, and LinkedIn Ads, then recommends where the next dollar should go. Uses marginal-return-aware reallocation math to shift budget from diminishing-return campaigns to high-return ones. Use when asked \"where should I spend more\", \"which channel is working\", \"reallocate my budget\", or for monthly/quarterly budget reviews. Recommendation-only: never auto-executes budget changes."
    );
  });

  it('Weekly Executive Ads Report (Cross-Platform) description matches ENG-1368 verbatim', () => {
    expect(SKILL_DESCRIPTION_UPDATES['6abd9a7f-55b0-428c-8b7f-aa107829407d']).toBe(
      "Weekly executive paid media report — one-page stakeholder summary across Google Ads, Meta Ads, and LinkedIn Ads. Key metrics with week-over-week comparison, top wins, top concerns with dollar impact, and 5 owner-assignable action items. Written for CEO/CMO readers, ready to paste into email or Slack. Use when asked for a weekly report, executive summary, Monday morning brief, or cross-platform ads overview."
    );
  });

  it('LinkedIn Ads Performance Audit Report description matches ENG-1368 verbatim', () => {
    expect(SKILL_DESCRIPTION_UPDATES['834e5e76-4f98-4065-9d79-2c56aa1a135f']).toBe(
      "LinkedIn Ads performance audit and monthly report — generates a polished, brand-styled HTML report for any brand with a connected LinkedIn Ads account. Seven sections: Executive Summary, Campaign Performance, Ad Set Breakdown, Audience Insights, Trend & Benchmark Comparison, Optimization Recommendations, and Next Steps. Use when asked \"how are my LinkedIn ads doing\", \"LinkedIn ads audit\", \"LinkedIn performance report\", or for scheduled monthly reviews."
    );
  });
});
