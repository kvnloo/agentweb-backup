/**
 * Migration script: Add clip sequencing checklist to the Video Production skill's systemPrompt.
 *
 * Fixes the root cause of incoherent clip sequences: when clips are generated individually
 * in non-sequential order, the agent was copying URLs in context/generation order instead
 * of shot order when calling compose_video.
 *
 * Usage:
 *   NODE_ENV=development npx ts-node src/scripts/patch-video-production-clip-ordering.ts
 *   NODE_ENV=production  npx ts-node src/scripts/patch-video-production-clip-ordering.ts
 *
 * Idempotent: skips if the section is already present.
 */

export const VIDEO_PRODUCTION_SKILL_ID = '8714d8c5-ab54-4b7e-baf9-23679464381e';

export const ORDERING_MARKER = '## CLIP SEQUENCING — MANDATORY PRE-COMPOSE CHECKLIST';

export const ADDITIONAL_PROMPT = `

---

## CLIP SEQUENCING — MANDATORY PRE-COMPOSE CHECKLIST

**The single most common production failure:** clips generated non-sequentially get passed to compose_video in context/generation order instead of shot order, producing a video where shots appear out of narrative sequence.

### Before calling compose_video — ALWAYS do this:

1. **Build an explicit ordered manifest** matching each URL to its shot number from the storyboard:
   - S1: <url>
   - S2: <url>
   - S3: <url>
   - ...
   Sort by shot number, regardless of what order clips were generated or appear in context.

2. **Verify ascending order** — no gaps, no swaps (S1, S2, S3... not S1, S2, S4, S3...).

3. **Pass clip_urls in manifest order** — array must be [S1_url, S2_url, S3_url, ...].

### When generating clips individually:
- Name each clip with its shot number: brand_s1_hook.mp4, brand_s3_reveal.mp4, etc.
- After all clips finish generating, sort by shot number before building clip_urls.
- If a clip was regenerated, update its URL in the manifest — do not append to the end.

### Red flag: if you scroll back through the conversation copying URLs as you encounter them — STOP. That is context order, not shot order. Sort by shot number first.`;

async function main() {
  const { SkillService } = await import('../services/skillService');
  const skillService = new SkillService();

  const skill = await skillService.getSkill(VIDEO_PRODUCTION_SKILL_ID);
  if (!skill) {
    console.error(`Skill ${VIDEO_PRODUCTION_SKILL_ID} not found.`);
    process.exit(1);
  }

  if (skill.systemPrompt?.includes(ORDERING_MARKER)) {
    console.log('Clip ordering section already present — skipping.');
    return;
  }

  skill.systemPrompt = (skill.systemPrompt ?? '') + ADDITIONAL_PROMPT;
  await skillService.updateSkill(skill);
  console.log(`Patched Video Production skill (${VIDEO_PRODUCTION_SKILL_ID}) with clip sequencing checklist.`);
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Patch failed:', err);
      process.exit(1);
    });
}
