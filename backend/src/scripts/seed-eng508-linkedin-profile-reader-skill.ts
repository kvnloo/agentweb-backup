/**
 * Seed script (ENG-508 / ENG-867): the "LinkedIn Profile Reader" skill.
 *
 * WHY: the Founder LinkedIn Sales-Readiness Audit work plan read the founder's
 * headline/About from a you_search_web snippet (a search-engine cache that lags
 * real LinkedIn edits by 6-12+ months) because the authenticated Unipile path
 * (`linkedin_outreach` action=get-profile) was never in the session's tool set —
 * `linkedin_outreach` is not a foundation tool and none of the plan's skills
 * granted it. This skill is the minimal, focused grant that makes the
 * authenticated live read reachable, without dragging in the write/post tools
 * (or the outreach-flavoured prompt) of the broader "LinkedIn Outreach" skill.
 *
 * The plan Step 2 wiring (add this skill to skillIds, swap requiredFunctionCalls,
 * rewrite the extraction instructions) is a SEPARATE change — this script only
 * provisions the skill so it can be referenced by skillId.
 *
 * ENTITLEMENT (do not skip): publishing the skill is NOT enough. buildSkillContext
 * only unions a skill's toolNames into the session toolbox when the skill's ID is
 * in the user's subscription-allowed skills (agentModeService.ts — `isWildcard ||
 * allowedSkillSet.has(s.skillId)`). Every tier in this deployment uses an EXPLICIT
 * allowedSkills list (no wildcard), so a brand-new skillId is invisible to all of
 * them and its tool stays undiscoverable — exactly the warning in
 * skillController.entitlementWarnings. This script therefore also enrolls the
 * skillId into every non-wildcard tier, idempotently.
 *
 * The audit plan sets requireLogin=true, so the anonymous `public_allowed_skills`
 * list is NOT a gate here and is deliberately left untouched.
 *
 * Usage:
 *   NODE_ENV=development npx ts-node src/scripts/seed-eng508-linkedin-profile-reader-skill.ts
 *   NODE_ENV=production  npx ts-node src/scripts/seed-eng508-linkedin-profile-reader-skill.ts
 *   ... --dry-run   # preview every write (skill + tier enrollment) without applying
 *
 * Idempotent: if a skill with this exact name already exists, its skillId is
 * REUSED and the record is upserted in place (so the plan's skillIds reference
 * stays valid and prompt/tool edits re-apply cleanly on re-run). Tier enrollment
 * only appends where the ID is missing.
 */
import { v4 as uuidv4 } from 'uuid';
import type { Skill } from '../services/skillService';

export const PROFILE_READER_SKILL_NAME = 'LinkedIn Profile Reader';

const PROFILE_READER_PROMPT = `# LinkedIn Profile Reader

You read a LinkedIn profile's CURRENT identity fields — headline, About,
experience, location — for analysis (e.g. a sales-readiness or positioning
audit). Accuracy of the *current* value is the whole job.

## HOW TO READ A PROFILE (authoritative source only)
- Call \`linkedin_outreach\` with \`action="get-profile"\`, the person's
  \`profile_url\` (or \`provider_id\`), and \`force_refresh=true\`. This reads the
  profile LIVE from the connected / platform-wide LinkedIn account and bypasses
  the profile cache. It is the ONLY authoritative source for a current headline,
  About, or experience.
- Take headline / About / experience / location straight from the returned
  profile object.

## NEVER DO THIS
- Never take a headline, About, or any profile-identity field from
  \`you_search_web\`, a Google result, or a page scrape. Those are search-engine
  caches that lag real LinkedIn edits by many months — presenting one as current
  is the exact failure this skill exists to prevent.

## IF THE LIVE READ IS UNAVAILABLE (fail closed)
- If \`get-profile\` returns a connect-LinkedIn error (no account resolvable),
  STOP and ask the user to connect LinkedIn in Settings → Connected Accounts.
- Do NOT substitute cached search snippets, screenshots, or guessed values for
  these fields. An explicit "connect your account" is the correct outcome, not a
  stale or fabricated headline.`;

export function buildProfileReaderSkill(skillId: string): Skill {
  const timestamp = new Date().toISOString();
  return {
    skillId,
    name: PROFILE_READER_SKILL_NAME,
    description:
      "Reads a LinkedIn profile's current identity fields (headline, About, experience) live from the connected LinkedIn account via authenticated get-profile — never from a stale search-engine cache. Fails closed with a connect-LinkedIn prompt when no account is available.",
    toolNames: ['linkedin_outreach'],
    systemPrompt: PROFILE_READER_PROMPT,
    isPublished: true,
    createdAt: timestamp,
    updatedAt: timestamp,
    category: 'tool_bundle',
    triggerMode: 'install_only',
    isBuiltIn: true,
    visibility: 'public',
  };
}

/**
 * Enroll the skillId into every subscription tier that uses an explicit
 * allowedSkills list. Without this the skill is published but unreachable.
 * Idempotent: only appends where the ID is missing; wildcard tiers are left alone.
 */
/**
 * Does this tier already grant every skill? Mirrors getAllowedSkills — the RUNTIME
 * authority — which returns ['*'] when allowedSkills is absent, EMPTY, or contains
 * '*'. Note findTiersAllowingSkill (used by the admin entitlement warning) differs:
 * it does `tier.allowedSkills || ['*']`, and since `[]` is truthy in JS an empty list
 * there reads as "allows nothing". Enrollment must follow the runtime rule, because
 * appending a skillId to an EMPTY list would flip that tier from "all skills allowed"
 * to "only this one skill allowed" — a severe entitlement regression.
 */
export function tierIsWildcard(tier: any): boolean {
  const allowed: string[] | undefined = tier?.allowedSkills;
  return !allowed || allowed.length === 0 || allowed.includes('*');
}

/** Runtime-accurate reachability for a single tier. */
export function tierAllowsSkill(tier: any, skillId: string): boolean {
  return tierIsWildcard(tier) || (tier.allowedSkills as string[]).includes(skillId);
}

export async function enrollSkillInTiers(
  skillId: string,
  dryRun: boolean
): Promise<{ changed: string[]; alreadyAllowed: string[]; reachable: boolean }> {
  const { settingsService } = await import('../services/settingsService');
  const setting = await settingsService.getSetting('subscription_types');
  if (!setting) {
    console.log('No subscription_types setting — every tier is implicitly wildcard, nothing to enroll.');
    return { changed: [], alreadyAllowed: [], reachable: true };
  }

  const tiers: any[] = JSON.parse(setting.settingValue);
  const changed: string[] = [];
  const alreadyAllowed: string[] = [];

  for (const tier of tiers) {
    if (tierIsWildcard(tier)) {
      alreadyAllowed.push(`${tier.name} (wildcard)`);
      continue;
    }
    const allowed: string[] = tier.allowedSkills;
    if (allowed.includes(skillId)) {
      alreadyAllowed.push(tier.name);
      continue;
    }
    allowed.push(skillId);
    changed.push(tier.name);
  }

  if (changed.length && !dryRun) {
    await settingsService.setSetting(
      'subscription_types',
      JSON.stringify(tiers),
      'Subscription type configurations',
      'eng-508-profile-reader-seed'
    );
  }

  // Reachability judged by the SAME rule used to enroll, so the two can never
  // disagree. A dry run reports the post-apply state (nothing was written yet).
  const reachable = tiers.length === 0 || tiers.some((t) => tierAllowsSkill(t, skillId));
  return { changed, alreadyAllowed, reachable };
}

/**
 * Main entry point — provisions the skill AND makes it reachable. Idempotent:
 * reuses the existing skillId (by name) so the plan reference stays valid.
 */
async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const env = process.env.NODE_ENV || '(unset→prod)';
  if (dryRun) console.log('=== DRY RUN — no writes will be applied ===');

  const { SkillService } = await import('../services/skillService');
  const skillService = new SkillService();

  const existing = await skillService.getAllSkills();
  const already = existing.find((s) => s.name === PROFILE_READER_SKILL_NAME);

  const skillId = already?.skillId ?? uuidv4();
  const skill = buildProfileReaderSkill(skillId);
  if (already) {
    // Preserve the original createdAt when updating in place.
    skill.createdAt = already.createdAt ?? skill.createdAt;
  }

  if (!dryRun) await skillService.updateSkill(skill);
  console.log(
    `${dryRun ? '[would ' + (already ? 'update' : 'seed') + ']' : already ? 'Updated' : 'Seeded'} ` +
      `skill "${skill.name}" (id: ${skill.skillId}) with toolNames=[${skill.toolNames.join(', ')}] (NODE_ENV=${env})`
  );

  // Entitlement — without this the skill is published but its tool is undiscoverable.
  const { changed, alreadyAllowed, reachable } = await enrollSkillInTiers(skill.skillId, dryRun);
  console.log(
    `Tier enrollment: ${dryRun ? '[would add to]' : 'added to'} [${changed.join(', ') || 'none'}]; ` +
      `already allowed: [${alreadyAllowed.join(', ') || 'none'}]`
  );
  console.log(`Reachable (runtime semantics): ${reachable}`);
  if (!reachable) throw new Error('Skill is still not reachable from any subscription tier');

  // Cross-check against findTiersAllowingSkill — the helper behind the admin
  // entitlement warning. It reads an EMPTY allowedSkills list as "allows nothing"
  // while the runtime treats it as wildcard, so the two can legitimately disagree
  // for empty-list tiers. Report that divergence instead of failing on it: the
  // runtime result above is authoritative for whether the tool is discoverable.
  if (!dryRun) {
    const { findTiersAllowingSkill } = await import('../services/subscriptionService');
    const { reachable: warnReachable, allowingTiers, totalTiers } = await findTiersAllowingSkill(skill.skillId);
    console.log(`Admin-warning view: reachable=${warnReachable} (${allowingTiers.length}/${totalTiers}: ${allowingTiers.join(', ') || 'none'})`);
    if (!warnReachable) {
      console.warn(
        'NOTE: the admin entitlement warning will still flag this skill. That happens when every ' +
          'tier stores an EMPTY allowedSkills list — allowed at runtime, but not counted by that helper.'
      );
    }
  }

  console.log(`SKILL_ID=${skill.skillId}`);
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Seed failed:', err);
      process.exit(1);
    });
}
