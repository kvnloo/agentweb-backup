/**
 * Migration script: Convert 1-step predefined work plans to Skills.
 *
 * Usage:
 *   NODE_ENV=development npx ts-node src/scripts/migrate-workplans-to-skills.ts
 *   NODE_ENV=production  npx ts-node src/scripts/migrate-workplans-to-skills.ts
 *
 * Only migrates plans with exactly 1 step. Multi-step plans stay as-is.
 * Idempotent: skips plans whose title already exists as a skill.
 */
import { v4 as uuidv4 } from 'uuid';
import type { Skill } from '../services/skillService';

interface WorkPlanStep {
  stepCount: number;
  title: string;
  description?: string;
  requiredFunctionCalls?: string[];
  skillIds?: string[];
}

interface PredefinedPlan {
  id: string;
  title: string;
  description?: string;
  welcomeMessage?: string;
  autocomplete?: boolean;
  requireLogin?: boolean;
  showLoginSignup?: string;
  showInAgentMode?: boolean;
  defaultModel?: string;
  steps: WorkPlanStep[];
}

/**
 * Determine if a work plan should be migrated to a skill.
 * Only 1-step plans qualify.
 */
export function shouldMigrateToSkill(plan: PredefinedPlan): boolean {
  return Array.isArray(plan.steps) && plan.steps.length === 1;
}

/**
 * Convert a 1-step work plan into a Skill object.
 * Pure function — no DB calls. Exported for testing.
 */
export function buildSkillFromPlan(plan: PredefinedPlan): Skill {
  const step = plan.steps[0];
  const timestamp = new Date().toISOString();

  // Build system prompt from step description/title
  const promptParts: string[] = [];
  if (plan.description) {
    promptParts.push(plan.description);
  }
  if (step.title) {
    promptParts.push(`Task: ${step.title}`);
  }
  if (step.description) {
    promptParts.push(step.description);
  }

  return {
    skillId: uuidv4(),
    name: plan.title,
    description: plan.description || step.title || plan.title,
    toolNames: step.requiredFunctionCalls || [],
    systemPrompt: promptParts.join('\n\n') || undefined,
    isPublished: true,
    createdAt: timestamp,
    updatedAt: timestamp,
    category: 'action',
    triggerMode: 'on_demand',
    isBuiltIn: true,
    visibility: 'public',
    welcomeMessage: plan.welcomeMessage,
    llmModel: plan.defaultModel,
  };
}

/**
 * Main entry point — reads work plans from settings and migrates 1-step ones.
 */
async function main() {
  const { SkillService } = await import('../services/skillService');
  const { SettingsService } = await import('../services/settingsService');

  const skillService = new SkillService();
  const settingsService = new SettingsService();

  // Read work plans from AW-Settings
  const setting = await settingsService.getSetting('agent-mode-predefined-workplans');
  if (!setting || !setting.settingValue) {
    console.log('No predefined work plans found in settings. Nothing to migrate.');
    return;
  }

  let plans: PredefinedPlan[];
  try {
    plans = JSON.parse(setting.settingValue);
  } catch (err) {
    console.error('Failed to parse work plans JSON:', err);
    return;
  }

  // Get existing skills for idempotency check
  const existingSkills = await skillService.getAllSkills();
  const existingNames = new Set(existingSkills.map((s) => s.name));

  let migrated = 0;
  let skipped = 0;
  let multiStep = 0;

  for (const plan of plans) {
    if (!shouldMigrateToSkill(plan)) {
      multiStep++;
      console.log(`  SKIP (multi-step): "${plan.title}" (${plan.steps.length} steps)`);
      continue;
    }

    if (existingNames.has(plan.title)) {
      skipped++;
      console.log(`  SKIP (already exists): "${plan.title}"`);
      continue;
    }

    const skill = buildSkillFromPlan(plan);
    await skillService.updateSkill(skill);
    migrated++;
    console.log(`  MIGRATED: "${plan.title}" -> skill ${skill.skillId}`);
  }

  console.log(`\nDone. Migrated: ${migrated}, Skipped (existing): ${skipped}, Multi-step (untouched): ${multiStep}`);
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Migration failed:', err);
      process.exit(1);
    });
}
