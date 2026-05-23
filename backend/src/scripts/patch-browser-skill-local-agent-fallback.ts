/**
 * Migration script: Add run_local_agent_task and check_local_agent_status to the
 * Browser Automation skill's toolNames so the tools are automatically available
 * when the skill is installed.
 *
 * Also strips any previously applied systemPrompt guidance about the fallback
 * (no longer needed — the tool description itself handles it).
 *
 * Usage:
 *   NODE_ENV=development npx ts-node src/scripts/patch-browser-skill-local-agent-fallback.ts
 *   NODE_ENV=production  npx ts-node src/scripts/patch-browser-skill-local-agent-fallback.ts
 *
 * Idempotent: skips if toolNames already includes run_local_agent_task.
 */

import { BROWSER_SKILL_ID } from './patch-browser-skill-429-guidance';

const LOCAL_AGENT_TOOLS = ['run_local_agent_task', 'check_local_agent_status'];

async function main() {
  const { SkillService } = await import('../services/skillService');
  const skillService = new SkillService();

  const skill = await skillService.getSkill(BROWSER_SKILL_ID);
  if (!skill) {
    console.error(`Skill ${BROWSER_SKILL_ID} not found.`);
    process.exit(1);
  }

  const currentTools: string[] = skill.toolNames ?? [];
  const alreadyAdded = LOCAL_AGENT_TOOLS.every(t => currentTools.includes(t));

  // Strip any previously applied systemPrompt guidance (superseded by toolNames approach)
  const strippedPrompt = (skill.systemPrompt ?? '')
    .split('\n\n## Headless Browser Failures')[0];

  if (alreadyAdded && strippedPrompt === skill.systemPrompt) {
    console.log('Already up to date — skipping.');
    return;
  }

  skill.toolNames = [...new Set([...currentTools, ...LOCAL_AGENT_TOOLS])];
  skill.systemPrompt = strippedPrompt;
  await skillService.updateSkill(skill);
  console.log(`Patched Browser Automation skill (${BROWSER_SKILL_ID}): added ${LOCAL_AGENT_TOOLS.join(', ')} to toolNames.`);
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Patch failed:', err);
      process.exit(1);
    });
}
