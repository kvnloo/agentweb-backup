/**
 * Seed script: Create the built-in Daily Account Digest skill.
 *
 * Usage:
 *   NODE_ENV=development npx ts-node src/scripts/seed-digest-skill.ts
 *   NODE_ENV=production  npx ts-node src/scripts/seed-digest-skill.ts
 *
 * Idempotent: skips if a skill with the same name already exists.
 */
import { v4 as uuidv4 } from 'uuid';
import type { Skill, SkillSchedule } from '../services/skillService';

export const DIGEST_SKILL_NAME = 'Daily Account Digest';

/**
 * Build the Daily Account Digest skill object.
 * Pure function — no DB calls. Exported for testing.
 */
export function buildDigestSkill(): Skill {
  const timestamp = new Date().toISOString();
  const schedule: SkillSchedule = {
    frequency: 'daily',
    preferredTime: '09:00',
    deliveryChannels: ['email', 'slack'],
  };

  return {
    skillId: uuidv4(),
    name: DIGEST_SKILL_NAME,
    description:
      'A daily summary of your account activity: ad spend, task completions, subscriber metrics, and key alerts.',
    toolNames: [
      'get_meta_ads_metrics',
      'get_task_subscriber_metrics',
      'get_task_subscriber_engagement_events',
      'account_summary',
      'get_seo_metrics',
      'get_website_analytics',
    ],
    systemPrompt: `You are the Daily Account Digest assistant. Each morning, compile a concise summary for the user covering:

1. **Ad Performance** — Yesterday's spend, impressions, clicks, and CTR across Meta/LinkedIn campaigns. Flag any campaigns with CTR < 0.5% or spend anomalies.
2. **Task Activity** — Tasks completed, in progress, and newly created. Highlight overdue tasks.
3. **Subscriber Metrics** — New subscribers, unsubscribes, engagement rate trends.
4. **Website Analytics** — Sessions, page views, bounce rate, top pages.
5. **Alerts** — Anything unusual: budget pacing issues, campaign errors, sudden traffic drops.

Format the digest in clear sections with bullet points. Keep it scannable in under 60 seconds. End with 1-2 recommended actions based on the data.`,
    isPublished: true,
    createdAt: timestamp,
    updatedAt: timestamp,
    category: 'digest',
    triggerMode: 'scheduled',
    schedule,
    isBuiltIn: true,
    visibility: 'system',
  };
}

/**
 * Main entry point — seeds the skill into DynamoDB.
 * Only runs when executed directly (not when imported for tests).
 */
async function main() {
  // Dynamic import to avoid loading AWS SDK during tests
  const { SkillService } = await import('../services/skillService');
  const skillService = new SkillService();

  // Idempotency: check if skill already exists
  const existing = await skillService.getAllSkills();
  const alreadyExists = existing.find((s) => s.name === DIGEST_SKILL_NAME);
  if (alreadyExists) {
    console.log(`Skill "${DIGEST_SKILL_NAME}" already exists (id: ${alreadyExists.skillId}). Skipping.`);
    return;
  }

  const skill = buildDigestSkill();

  // Use updateSkill (put) to write the full skill object with extended fields
  await skillService.updateSkill(skill);
  console.log(`Seeded skill "${DIGEST_SKILL_NAME}" with id: ${skill.skillId}`);
}

// Only run main when executed directly
if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Seed failed:', err);
      process.exit(1);
    });
}
