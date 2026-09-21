/**
 * Tests for patch-eng1368-skill-descriptions.ts (ENG-1368).
 */
import { describe, it, expect, jest } from '@jest/globals';

import { SKILL_DESCRIPTION_UPDATES, patchSkillDescription } from '../scripts/patch-eng1368-skill-descriptions';
import { Skill, SkillService } from '../services/skillService';

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
      "Cross-channel paid media budget optimizer — compares ROAS and performance across Google Ads, Meta Ads, and LinkedIn Ads, then recommends where the next dollar should go. Uses marginal-return-aware reallocation math to shift budget from diminishing-return campaigns to high-return ones. Use when asked \"where should I spend more\", \"which channel is working\", \"reallocate my budget\", or for monthly/quarterly budget reviews. Recommendation-only; never auto-executes budget changes."
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

describe('patchSkillDescription', () => {
  const skillId = '1ad6f950-edc7-4aec-93cf-d52b834439f8';
  const newDescription = SKILL_DESCRIPTION_UPDATES[skillId];

  function makeFixture(): Skill {
    return {
      skillId,
      name: 'Conversion Tracking Validator',
      description: 'stale description',
      toolNames: ['get_google_ads_conversions', 'get_meta_pixel_events'],
      isPublished: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      triggerMode: 'install_only' as Skill['triggerMode'],
    };
  }

  function makeMockService(fixture: Skill, afterUpdate: Skill) {
    const getSkill = jest.fn<SkillService['getSkill']>();
    getSkill.mockResolvedValueOnce(fixture).mockResolvedValueOnce(afterUpdate);
    const updateSkill = jest.fn<SkillService['updateSkill']>().mockResolvedValue(fixture.updatedAt);
    return { getSkill, updateSkill } as unknown as SkillService;
  }

  it('passes updateSkill an object that changes only description, preserving every other field', async () => {
    const fixture = makeFixture();
    const afterUpdate = { ...fixture, description: newDescription };
    const service = makeMockService(fixture, afterUpdate);

    const outcome = await patchSkillDescription(service, skillId, newDescription);

    expect(outcome).toBe('patched');
    expect(service.updateSkill).toHaveBeenCalledTimes(1);
    const updatedArg = (service.updateSkill as jest.Mock).mock.calls[0][0] as Skill;
    expect(updatedArg).toEqual({ ...fixture, description: newDescription });
    // AC2/AC3: triggerMode and every other field must be byte-identical to the fixture.
    expect(updatedArg.triggerMode).toBe(fixture.triggerMode);
    expect(updatedArg.name).toBe(fixture.name);
    expect(updatedArg.isPublished).toBe(fixture.isPublished);
    expect(updatedArg.toolNames).toEqual(fixture.toolNames);
    expect(updatedArg.skillId).toBe(fixture.skillId);
  });

  it('throws when the read-back does not confirm the persisted description', async () => {
    const fixture = makeFixture();
    // Simulate a write that silently didn't persist.
    const afterUpdate = { ...fixture, description: 'stale description' };
    const service = makeMockService(fixture, afterUpdate);

    await expect(patchSkillDescription(service, skillId, newDescription)).rejects.toThrow(
      /Read-back verification failed/
    );
  });

  it('throws when the read-back shows triggerMode drifted from its prior value', async () => {
    const fixture = makeFixture();
    // Simulate a write that unexpectedly mutated triggerMode.
    const afterUpdate: Skill = { ...fixture, description: newDescription, triggerMode: 'on_demand' as Skill['triggerMode'] };
    const service = makeMockService(fixture, afterUpdate);

    await expect(patchSkillDescription(service, skillId, newDescription)).rejects.toThrow(
      /Read-back verification failed/
    );
  });

  it('skips skills that already have the target description without calling updateSkill', async () => {
    const fixture = { ...makeFixture(), description: newDescription };
    const getSkill = jest.fn<SkillService['getSkill']>().mockResolvedValue(fixture);
    const updateSkill = jest.fn<SkillService['updateSkill']>();
    const service = { getSkill, updateSkill } as unknown as SkillService;

    const outcome = await patchSkillDescription(service, skillId, newDescription);

    expect(outcome).toBe('skipped');
    expect(updateSkill).not.toHaveBeenCalled();
  });
});
