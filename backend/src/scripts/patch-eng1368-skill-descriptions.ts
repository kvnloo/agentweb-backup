/**
 * Migration script (ENG-1368): rewrite the `description` field on the 5
 * remaining skills from Manan's ENG-1123 audit (Argusoft, 2026-08-11).
 *
 * ENG-1123 also proposed flipping these skills' `triggerMode`, but Manan
 * traced the code and found triggerMode has zero functional effect — every
 * published skill's name+description is shown to the LLM as an
 * install-candidate on every turn regardless of triggerMode. That flip was
 * correctly never applied. The description text itself IS the live matching
 * surface, so the rewrites still stand on their own — this script updates
 * ONLY `description`, leaving `triggerMode` and every other field untouched.
 * (The 6th rewrite, Pre-Flight Health Gate, already shipped as ENG-1179.)
 *
 * Usage:
 *   NODE_ENV=development npx ts-node src/scripts/patch-eng1368-skill-descriptions.ts
 *   NODE_ENV=production  npx ts-node src/scripts/patch-eng1368-skill-descriptions.ts
 *
 * Idempotent: a skill whose description already matches the target is skipped.
 */

export const SKILL_DESCRIPTION_UPDATES: Record<string, string> = {
  '1ad6f950-edc7-4aec-93cf-d52b834439f8':
    "Google Ads conversion tracking audit — also covers Meta Ads pixel/CAPI and LinkedIn Insight Tag. Verifies conversion actions are firing, checks enhanced conversions enablement, flags counting-setting mismatches (every vs. one), validates GA4 import linkage, and compares cross-platform conversion counts to surface discrepancies. Use this when campaigns show zero or suspicious conversions, when conversion numbers don't match CRM, or before scaling spend. Read-only diagnostic; never modifies tracking configuration.",
  'f36b423e-e2c0-4e3f-859e-69156188dfe5':
    "Google Ads landing page audit — also covers Meta and LinkedIn ad destinations. Maps every active ad to its final URL, then audits each page carrying real spend: load speed, mobile-friendliness, message match between ad copy and page headline, form field count and friction, above-the-fold CTA presence, and broken/redirect URLs. Ranks pages by dollar exposure and flags Quality Score \"Landing Page Experience: below average\" keywords. Use when ad performance is poor, bounce rates are high, or after launching new landing pages. Read-only diagnostic.",
  'ca99eb0c-5d69-41d4-8997-516b5bb2d228':
    "Cross-channel paid media budget optimizer — compares ROAS and performance across Google Ads, Meta Ads, and LinkedIn Ads, then recommends where the next dollar should go. Uses marginal-return-aware reallocation math to shift budget from diminishing-return campaigns to high-return ones. Use when asked \"where should I spend more\", \"which channel is working\", \"reallocate my budget\", or for monthly/quarterly budget reviews. Recommendation-only: never auto-executes budget changes.",
  '6abd9a7f-55b0-428c-8b7f-aa107829407d':
    "Weekly executive paid media report — one-page stakeholder summary across Google Ads, Meta Ads, and LinkedIn Ads. Key metrics with week-over-week comparison, top wins, top concerns with dollar impact, and 5 owner-assignable action items. Written for CEO/CMO readers, ready to paste into email or Slack. Use when asked for a weekly report, executive summary, Monday morning brief, or cross-platform ads overview.",
  '834e5e76-4f98-4065-9d79-2c56aa1a135f':
    "LinkedIn Ads performance audit and monthly report — generates a polished, brand-styled HTML report for any brand with a connected LinkedIn Ads account. Seven sections: Executive Summary, Campaign Performance, Ad Set Breakdown, Audience Insights, Trend & Benchmark Comparison, Optimization Recommendations, and Next Steps. Use when asked \"how are my LinkedIn ads doing\", \"LinkedIn ads audit\", \"LinkedIn performance report\", or for scheduled monthly reviews.",
};

export type PatchOutcome = 'patched' | 'skipped' | 'not_found';

/**
 * Patches a single skill's description and verifies the persisted result via
 * a read-back — a successful updateSkill() call alone doesn't prove the write
 * landed as expected (ENG-1368 AC1 requires read-back verification).
 */
export async function patchSkillDescription(
  skillService: import('../services/skillService').SkillService,
  skillId: string,
  newDescription: string
): Promise<PatchOutcome> {
  const skill = await skillService.getSkill(skillId);
  if (!skill) {
    console.warn(`Skill ${skillId} not found — skipping.`);
    return 'not_found';
  }

  if (skill.description === newDescription) {
    console.log(`Skill ${skillId} ("${skill.name}") already has the target description — skipping.`);
    return 'skipped';
  }

  const previousTriggerMode = skill.triggerMode;
  skill.description = newDescription;
  await skillService.updateSkill(skill);

  const verified = await skillService.getSkill(skillId);
  if (!verified || verified.description !== newDescription || verified.triggerMode !== previousTriggerMode) {
    throw new Error(
      `Read-back verification failed for skill ${skillId} ("${skill.name}"): ` +
      `expected description="${newDescription}" triggerMode=${previousTriggerMode}, ` +
      `got description="${verified?.description}" triggerMode=${verified?.triggerMode}.`
    );
  }

  console.log(
    `Patched skill ${skillId} ("${skill.name}"): description updated and verified ` +
    `(triggerMode unchanged: ${previousTriggerMode}).`
  );
  return 'patched';
}

export async function main() {
  const { SkillService } = await import('../services/skillService');
  const skillService = new SkillService();

  let patched = 0;
  let skipped = 0;

  for (const [skillId, newDescription] of Object.entries(SKILL_DESCRIPTION_UPDATES)) {
    const outcome = await patchSkillDescription(skillService, skillId, newDescription);
    if (outcome === 'patched') patched++;
    if (outcome === 'skipped') skipped++;
  }

  console.log(
    `Done: patched ${patched}, skipped ${skipped} of ${Object.keys(SKILL_DESCRIPTION_UPDATES).length} skill(s).`
  );
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Patch failed:', err);
      process.exit(1);
    });
}
