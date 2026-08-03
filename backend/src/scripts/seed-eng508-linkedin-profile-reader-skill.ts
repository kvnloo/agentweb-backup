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
 * Usage:
 *   NODE_ENV=development npx ts-node src/scripts/seed-eng508-linkedin-profile-reader-skill.ts
 *   NODE_ENV=production  npx ts-node src/scripts/seed-eng508-linkedin-profile-reader-skill.ts
 *
 * Idempotent: if a skill with this exact name already exists, its skillId is
 * REUSED and the record is upserted in place (so the plan's skillIds reference
 * stays valid and prompt/tool edits re-apply cleanly on re-run).
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
 * Main entry point — provisions the skill into DynamoDB. Idempotent: reuses the
 * existing skillId (by name) so the plan reference stays valid across re-runs.
 */
async function main() {
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

  await skillService.updateSkill(skill);
  console.log(
    `${already ? 'Updated' : 'Seeded'} skill "${skill.name}" (id: ${skill.skillId}) ` +
      `with toolNames=[${skill.toolNames.join(', ')}] in table for NODE_ENV=${process.env.NODE_ENV || '(unset→prod)'}`
  );
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
