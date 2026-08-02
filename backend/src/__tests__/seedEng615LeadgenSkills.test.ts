/**
 * Tests for seed-eng615-leadgen-skills.ts (ENG-204 Part 2 — ENG-615).
 * Pure build functions only — no DynamoDB-dependent main().
 */
import { describe, it, expect } from '@jest/globals';

import {
  buildIcpScoringSkill,
  buildSpeedToLeadSkill,
  ICP_SCORING_SKILL_NAME,
  SPEED_TO_LEAD_SKILL_NAME,
} from '../scripts/seed-eng615-leadgen-skills';

// Every tool a prompt names must be declared in toolNames (Blindspot 5 lint).
// We scan the prompt for known tool tokens rather than re-implementing the
// full lint here; this catches the common regression (a block references a
// tool the skill was not granted).
function assertPromptToolsAreDeclared(systemPrompt: string, toolNames: string[]) {
  const CANDIDATE_TOOLS = [
    'read_market_strategy',
    'read_brand_guidelines',
    'analyze_crm_data',
    'get_hot_leads',
    'enrich_leads_execute',
    'save_memory',
    'manage_scheduled_chat',
    'list_connected_accounts',
    'send_email_to_lead',
    'add_lead_engagement',
  ];
  const declared = new Set(toolNames);
  for (const tool of CANDIDATE_TOOLS) {
    // word-boundary match so we don't hit hyphenated action names
    const referenced = new RegExp(`\\b${tool}\\b`).test(systemPrompt);
    if (referenced) {
      expect(declared.has(tool)).toBe(true);
    }
  }
}

describe('seed-eng615-leadgen-skills', () => {
  describe('buildIcpScoringSkill (#2)', () => {
    it('creates a valid public analysis skill', () => {
      const skill = buildIcpScoringSkill();
      expect(skill.name).toBe(ICP_SCORING_SKILL_NAME);
      expect(skill.isPublished).toBe(true);
      expect(skill.visibility).toBe('public');
      expect(skill.isBuiltIn).toBe(true);
      expect(skill.category).toBe('analysis');
      expect(skill.triggerMode).toBe('on_demand');
    });

    it('declares the scoring tools and save_memory (for LEARN)', () => {
      const skill = buildIcpScoringSkill();
      expect(skill.toolNames).toEqual(
        expect.arrayContaining([
          'read_market_strategy',
          'read_brand_guidelines',
          'analyze_crm_data',
          'get_hot_leads',
          'enrich_leads_execute',
          'save_memory',
        ])
      );
    });

    it('is read/score only — no send or delete tools', () => {
      const skill = buildIcpScoringSkill();
      expect(skill.toolNames).not.toContain('send_email_to_lead');
      expect(skill.toolNames).not.toContain('list_connected_accounts');
      expect(skill.toolNames.some((t) => t.startsWith('delete_'))).toBe(false);
    });

    it('carries FAILURE HANDLING and LEARN but not the send-caps SAFETY block', () => {
      const skill = buildIcpScoringSkill();
      expect(skill.systemPrompt).toContain('## FAILURE HANDLING');
      expect(skill.systemPrompt).toContain('## LEARN FROM OUTCOMES');
      expect(skill.systemPrompt).not.toContain('## SAFETY & VOLUME LIMITS');
    });

    it('every tool named in the prompt is declared in toolNames', () => {
      const skill = buildIcpScoringSkill();
      assertPromptToolsAreDeclared(skill.systemPrompt!, skill.toolNames);
    });
  });

  describe('buildSpeedToLeadSkill (#6)', () => {
    it('creates a valid public action skill that runs unattended', () => {
      const skill = buildSpeedToLeadSkill();
      expect(skill.name).toBe(SPEED_TO_LEAD_SKILL_NAME);
      expect(skill.isPublished).toBe(true);
      expect(skill.visibility).toBe('public');
      expect(skill.isBuiltIn).toBe(true);
      expect(skill.category).toBe('action');
      expect(skill.triggerMode).toBe('both');
    });

    it('declares the full enrich-route-reply tool chain', () => {
      const skill = buildSpeedToLeadSkill();
      expect(skill.toolNames).toEqual(
        expect.arrayContaining([
          'manage_scheduled_chat',
          'enrich_leads_execute',
          'read_market_strategy',
          'read_brand_guidelines',
          'list_connected_accounts',
          'send_email_to_lead',
          'add_lead_engagement',
          'save_memory',
        ])
      );
    });

    it('carries all five hardening blocks (sends + unattended)', () => {
      const skill = buildSpeedToLeadSkill();
      for (const block of [
        '## CONTEXT FRESHNESS',
        '## SAFETY & VOLUME LIMITS',
        '## FAILURE HANDLING',
        '## LEARN FROM OUTCOMES',
        '## COMPLIANCE',
      ]) {
        expect(skill.systemPrompt).toContain(block);
      }
    });

    it('keeps the absolute unattended send cap and zero-deletions rule', () => {
      const skill = buildSpeedToLeadSkill();
      expect(skill.systemPrompt).toContain('25 emails');
      expect(skill.systemPrompt).toContain('0 deletions');
      expect(skill.systemPrompt).toContain('these caps are absolute');
    });

    it('every tool named in the prompt is declared in toolNames', () => {
      const skill = buildSpeedToLeadSkill();
      assertPromptToolsAreDeclared(skill.systemPrompt!, skill.toolNames);
    });
  });

  it('gives each build call a unique skillId', () => {
    expect(buildIcpScoringSkill().skillId).not.toBe(buildIcpScoringSkill().skillId);
    expect(buildSpeedToLeadSkill().skillId).not.toBe(buildSpeedToLeadSkill().skillId);
  });
});
