/**
 * Tests for seed-eng616-leadgen-skills.ts (ENG-204 Part 2 — ENG-616).
 * Pure build functions only — no DynamoDB-dependent main().
 */
import { describe, it, expect } from '@jest/globals';

import {
  buildIntentProspectingSkill,
  buildEmailNurtureSkill,
  INTENT_PROSPECTING_SKILL_NAME,
  EMAIL_NURTURE_SKILL_NAME,
} from '../scripts/seed-eng616-leadgen-skills';

// Every tool a prompt names must be declared in toolNames (Blindspot 5 lint).
function assertPromptToolsAreDeclared(systemPrompt: string, toolNames: string[]) {
  const CANDIDATE_TOOLS = [
    'you_search_web',
    'find_or_lookup_email',
    'import_leads_from_search',
    'enrich_leads_execute',
    'analyze_crm_data',
    'search_leads',
    'get_leads_needing_followup',
    'get_lead_engagements',
    'update_email_draft_for_lead',
    'send_email_to_lead',
    'add_lead_engagement',
    'manage_scheduled_chat',
    'list_connected_accounts',
    'read_market_strategy',
    'read_brand_guidelines',
    'save_memory',
  ];
  const declared = new Set(toolNames);
  for (const tool of CANDIDATE_TOOLS) {
    const referenced = new RegExp(`\\b${tool}\\b`).test(systemPrompt);
    if (referenced) {
      expect(declared.has(tool)).toBe(true);
    }
  }
}

describe('seed-eng616-leadgen-skills', () => {
  describe('buildIntentProspectingSkill (#1)', () => {
    it('creates a valid public action skill that runs unattended', () => {
      const skill = buildIntentProspectingSkill();
      expect(skill.name).toBe(INTENT_PROSPECTING_SKILL_NAME);
      expect(skill.isPublished).toBe(true);
      expect(skill.visibility).toBe('public');
      expect(skill.isBuiltIn).toBe(true);
      expect(skill.category).toBe('action');
      expect(skill.triggerMode).toBe('both');
    });

    it('declares the prospect->resolve->import->enrich tool chain', () => {
      const skill = buildIntentProspectingSkill();
      expect(skill.toolNames).toEqual(
        expect.arrayContaining([
          'you_search_web',
          'find_or_lookup_email',
          'import_leads_from_search',
          'enrich_leads_execute',
          'analyze_crm_data',
          'add_lead_engagement',
          'save_memory',
        ])
      );
    });

    it('does NOT send email and carries no send-oriented tools', () => {
      const skill = buildIntentProspectingSkill();
      expect(skill.toolNames).not.toContain('send_email_to_lead');
      expect(skill.toolNames.some((t) => t.startsWith('delete_'))).toBe(false);
    });

    it('carries adapted hardening blocks with import caps and no CAN-SPAM email clause', () => {
      const skill = buildIntentProspectingSkill();
      expect(skill.systemPrompt).toContain('## SAFETY & VOLUME LIMITS');
      expect(skill.systemPrompt).toContain('50 new leads imported');
      expect(skill.systemPrompt).toContain('0 deletions');
      expect(skill.systemPrompt).toContain('these caps are absolute');
      expect(skill.systemPrompt).toContain('## FAILURE HANDLING');
      // does not send email -> no CAN-SPAM unsubscribe clause
      expect(skill.systemPrompt).not.toContain('unsubscribe handling');
    });

    it('every tool named in the prompt is declared in toolNames', () => {
      const skill = buildIntentProspectingSkill();
      assertPromptToolsAreDeclared(skill.systemPrompt!, skill.toolNames);
    });
  });

  describe('buildEmailNurtureSkill (#3)', () => {
    it('creates a valid public action skill that runs unattended', () => {
      const skill = buildEmailNurtureSkill();
      expect(skill.name).toBe(EMAIL_NURTURE_SKILL_NAME);
      expect(skill.isPublished).toBe(true);
      expect(skill.visibility).toBe('public');
      expect(skill.isBuiltIn).toBe(true);
      expect(skill.category).toBe('action');
      expect(skill.triggerMode).toBe('both');
    });

    it('declares the full cadence tool chain', () => {
      const skill = buildEmailNurtureSkill();
      expect(skill.toolNames).toEqual(
        expect.arrayContaining([
          'manage_scheduled_chat',
          'get_leads_needing_followup',
          'get_lead_engagements',
          'update_email_draft_for_lead',
          'send_email_to_lead',
          'list_connected_accounts',
          'add_lead_engagement',
          'save_memory',
        ])
      );
    });

    it('carries all five verbatim hardening blocks (sends + unattended)', () => {
      const skill = buildEmailNurtureSkill();
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

    it('keeps the absolute unattended email cap, zero-deletions, and CAN-SPAM', () => {
      const skill = buildEmailNurtureSkill();
      expect(skill.systemPrompt).toContain('25 emails');
      expect(skill.systemPrompt).toContain('0 deletions');
      expect(skill.systemPrompt).toContain('these caps are absolute');
      expect(skill.systemPrompt).toContain('unsubscribe handling');
    });

    it('stops the cadence on reply/booking (no double-send)', () => {
      const skill = buildEmailNurtureSkill();
      expect(skill.systemPrompt).toContain('Never restart a sequence or double-send');
    });

    it('every tool named in the prompt is declared in toolNames', () => {
      const skill = buildEmailNurtureSkill();
      assertPromptToolsAreDeclared(skill.systemPrompt!, skill.toolNames);
    });
  });

  it('gives each build call a unique skillId', () => {
    expect(buildIntentProspectingSkill().skillId).not.toBe(
      buildIntentProspectingSkill().skillId
    );
    expect(buildEmailNurtureSkill().skillId).not.toBe(buildEmailNurtureSkill().skillId);
  });
});
