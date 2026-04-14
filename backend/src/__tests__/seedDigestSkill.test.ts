/**
 * Tests for seed-digest-skill.ts and migrate-workplans-to-skills.ts logic
 */
import { describe, it, expect } from '@jest/globals';

// Import the pure logic functions (not the DynamoDB-dependent main())
import {
  buildDigestSkill,
  DIGEST_SKILL_NAME,
} from '../scripts/seed-digest-skill';

import {
  shouldMigrateToSkill,
  buildSkillFromPlan,
} from '../scripts/migrate-workplans-to-skills';

describe('seed-digest-skill', () => {
  describe('buildDigestSkill', () => {
    it('creates a valid skill with all required fields', () => {
      const skill = buildDigestSkill();
      expect(skill.name).toBe('Daily Account Digest');
      expect(skill.isBuiltIn).toBe(true);
      expect(skill.visibility).toBe('system');
      expect(skill.triggerMode).toBe('scheduled');
      expect(skill.category).toBe('digest');
      expect(skill.isPublished).toBe(true);
    });

    it('includes required tool names', () => {
      const skill = buildDigestSkill();
      expect(skill.toolNames).toContain('get_meta_ads_metrics');
      expect(skill.toolNames).toContain('get_task_subscriber_metrics');
    });

    it('has a schedule with daily frequency', () => {
      const skill = buildDigestSkill();
      expect(skill.schedule).toBeDefined();
      expect(skill.schedule!.frequency).toBe('daily');
      expect(skill.schedule!.preferredTime).toBe('09:00');
      expect(skill.schedule!.deliveryChannels).toContain('email');
    });

    it('has a non-empty system prompt', () => {
      const skill = buildDigestSkill();
      expect(skill.systemPrompt).toBeDefined();
      expect(skill.systemPrompt!.length).toBeGreaterThan(50);
    });

    it('generates a unique skillId', () => {
      const skill1 = buildDigestSkill();
      const skill2 = buildDigestSkill();
      expect(skill1.skillId).not.toBe(skill2.skillId);
    });
  });

  it('exports the correct skill name constant', () => {
    expect(DIGEST_SKILL_NAME).toBe('Daily Account Digest');
  });
});

describe('migrate-workplans-to-skills', () => {
  describe('shouldMigrateToSkill', () => {
    it('returns true for 1-step plans', () => {
      const plan = {
        id: 'plan-1',
        title: 'Quick Research',
        steps: [{ stepCount: 1, title: 'Research' }],
      };
      expect(shouldMigrateToSkill(plan)).toBe(true);
    });

    it('returns false for multi-step plans', () => {
      const plan = {
        id: 'plan-2',
        title: 'Full Campaign',
        steps: [
          { stepCount: 1, title: 'Research' },
          { stepCount: 2, title: 'Execute' },
        ],
      };
      expect(shouldMigrateToSkill(plan)).toBe(false);
    });

    it('returns false for plans with no steps', () => {
      const plan = { id: 'plan-3', title: 'Empty', steps: [] };
      expect(shouldMigrateToSkill(plan)).toBe(false);
    });
  });

  describe('buildSkillFromPlan', () => {
    it('creates a skill with correct name and description', () => {
      const plan = {
        id: 'plan-1',
        title: 'Quick Research',
        description: 'Research a topic quickly',
        steps: [{ stepCount: 1, title: 'Research', requiredFunctionCalls: ['perform_deep_research'] }],
      };
      const skill = buildSkillFromPlan(plan);
      expect(skill.name).toBe('Quick Research');
      expect(skill.description).toBe('Research a topic quickly');
      expect(skill.isBuiltIn).toBe(true);
      expect(skill.triggerMode).toBe('on_demand');
      expect(skill.isPublished).toBe(true);
    });

    it('copies requiredFunctionCalls to toolNames', () => {
      const plan = {
        id: 'plan-1',
        title: 'Test Plan',
        steps: [{ stepCount: 1, title: 'Step 1', requiredFunctionCalls: ['tool_a', 'tool_b'] }],
      };
      const skill = buildSkillFromPlan(plan);
      expect(skill.toolNames).toEqual(['tool_a', 'tool_b']);
    });

    it('defaults to empty toolNames when no requiredFunctionCalls', () => {
      const plan = {
        id: 'plan-1',
        title: 'No Tools',
        steps: [{ stepCount: 1, title: 'Step 1' }],
      };
      const skill = buildSkillFromPlan(plan);
      expect(skill.toolNames).toEqual([]);
    });

    it('uses step title as system prompt when no plan description', () => {
      const plan = {
        id: 'plan-1',
        title: 'Quick Task',
        steps: [{ stepCount: 1, title: 'Do the thing', description: 'Execute the task' }],
      };
      const skill = buildSkillFromPlan(plan);
      expect(skill.systemPrompt).toContain('Do the thing');
    });

    it('preserves plan welcome message', () => {
      const plan = {
        id: 'plan-1',
        title: 'Greeted Plan',
        welcomeMessage: 'Hello, let me help you!',
        steps: [{ stepCount: 1, title: 'Go' }],
      };
      const skill = buildSkillFromPlan(plan);
      expect(skill.welcomeMessage).toBe('Hello, let me help you!');
    });
  });
});
