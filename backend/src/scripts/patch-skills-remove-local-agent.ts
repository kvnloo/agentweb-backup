/**
 * Migration script (ENG-383): Strip the deprecated local agent relay tools
 * (run_local_agent_task, check_local_agent_status) from EVERY skill's toolNames.
 *
 * The local agent relay was retired in July 2026 (ngrok account suspended,
 * ERR_NGROK_6008 — see ENG-381/ENG-383). The tools remain registered as
 * fail-fast deprecation stubs (src/emma/localAgentTools.ts), but no skill
 * should advertise them anymore.
 *
 * Known carriers at time of writing (the scan covers ALL skills regardless):
 *   - Browser Automation            1ae6104b-eb2d-4297-adc2-1b6f3b177497
 *   - Screenshot Social Media Posts 9088ced1-6400-453a-a65d-411bced16c2d
 *
 * Usage (NODE_ENV drives the Dev-/prod AW-Skills table prefix, exactly like
 * the other patch scripts):
 *   NODE_ENV=development npx ts-node src/scripts/patch-skills-remove-local-agent.ts
 *   NODE_ENV=production  npx ts-node src/scripts/patch-skills-remove-local-agent.ts
 *
 * Idempotent: skills without either tool are untouched; safe to re-run.
 */

const LOCAL_AGENT_TOOLS = new Set(['run_local_agent_task', 'check_local_agent_status']);

async function main() {
  const { SkillService } = await import('../services/skillService');
  const skillService = new SkillService();

  const skills = await skillService.getAllSkills();
  let patched = 0;

  for (const skill of skills) {
    const currentTools: string[] = skill.toolNames ?? [];
    const strippedTools = currentTools.filter(t => !LOCAL_AGENT_TOOLS.has(t));
    if (strippedTools.length === currentTools.length) continue;

    skill.toolNames = strippedTools;
    await skillService.updateSkill(skill);
    patched++;
    console.log(
      `Patched skill ${skill.skillId} ("${skill.name}"): removed ` +
      `${currentTools.length - strippedTools.length} local-agent tool(s) from toolNames.`
    );
  }

  if (patched === 0) {
    console.log(`No skills carry the local agent tools (${skills.length} scanned) — nothing to patch.`);
  } else {
    console.log(`Done: patched ${patched} of ${skills.length} skill(s).`);
  }
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Patch failed:', err);
      process.exit(1);
    });
}
