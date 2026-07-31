/**
 * Tests for seed-eng617-leadgen-skills.ts (ENG-204 Part 2 — ENG-617).
 * Pure build functions only — no DynamoDB-dependent main().
 */
import { describe, it, expect } from '@jest/globals';

import {
  buildAeoSkill,
  buildCrossChannelSkill,
  AEO_SKILL_NAME,
  CROSS_CHANNEL_SKILL_NAME,
} from '../scripts/seed-eng617-leadgen-skills';

function assertPromptToolsAreDeclared(systemPrompt: string, toolNames: string[]) {
  const CANDIDATE_TOOLS = [
    'perform_deep_research',
    'you_search_web',
    'get_seo_metrics',
    'get_website_analytics',
    'create_blog_article',
    'publish_blog_article',
    'linkedin_outreach',
    'generate_video',
    'send_email_to_lead',
    'update_email_draft_for_lead',
    'get_leads_needing_followup',
    'get_lead_engagements',
    'analyze_crm_data',
    'search_leads',
    'manage_scheduled_chat',
    'list_connected_accounts',
    'add_lead_engagement',
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

describe('seed-eng617-leadgen-skills', () => {
  describe('buildAeoSkill (#4)', () => {
    it('creates a valid public content skill, on-demand', () => {
      const skill = buildAeoSkill();
      expect(skill.name).toBe(AEO_SKILL_NAME);
      expect(skill.isPublished).toBe(true);
      expect(skill.visibility).toBe('public');
      expect(skill.isBuiltIn).toBe(true);
      expect(skill.category).toBe('action');
      expect(skill.triggerMode).toBe('on_demand');
    });

    it('declares research + blog publish tools', () => {
      const skill = buildAeoSkill();
      expect(skill.toolNames).toEqual(
        expect.arrayContaining([
          'perform_deep_research',
          'you_search_web',
          'create_blog_article',
          'publish_blog_article',
          'get_seo_metrics',
          'save_memory',
        ])
      );
    });

    it('carries the absolute PUBLISH GATE and never publishes unattended', () => {
      const skill = buildAeoSkill();
      expect(skill.systemPrompt).toContain('## PUBLISH GATE (ABSOLUTE');
      expect(skill.systemPrompt).toContain('save as a draft and notify; never publish');
      expect(skill.systemPrompt).toContain('## FAILURE HANDLING');
    });

    it('does not carry email send tools or the CAN-SPAM/email SAFETY block', () => {
      const skill = buildAeoSkill();
      expect(skill.toolNames).not.toContain('send_email_to_lead');
      expect(skill.systemPrompt).not.toContain('## SAFETY & VOLUME LIMITS');
    });

    it('every tool named in the prompt is declared in toolNames', () => {
      const skill = buildAeoSkill();
      assertPromptToolsAreDeclared(skill.systemPrompt!, skill.toolNames);
    });
  });

  describe('buildCrossChannelSkill (#5)', () => {
    it('creates a valid public action skill that runs unattended', () => {
      const skill = buildCrossChannelSkill();
      expect(skill.name).toBe(CROSS_CHANNEL_SKILL_NAME);
      expect(skill.isPublished).toBe(true);
      expect(skill.visibility).toBe('public');
      expect(skill.isBuiltIn).toBe(true);
      expect(skill.category).toBe('action');
      expect(skill.triggerMode).toBe('both');
    });

    it('declares the multi-channel tool chain (LinkedIn + email + video)', () => {
      const skill = buildCrossChannelSkill();
      expect(skill.toolNames).toEqual(
        expect.arrayContaining([
          'linkedin_outreach',
          'send_email_to_lead',
          'update_email_draft_for_lead',
          'generate_video',
          'list_connected_accounts',
          'get_leads_needing_followup',
          'manage_scheduled_chat',
          'add_lead_engagement',
          'save_memory',
        ])
      );
    });

    it('carries all five verbatim hardening blocks with caps spanning all channels', () => {
      const skill = buildCrossChannelSkill();
      for (const block of [
        '## CONTEXT FRESHNESS',
        '## SAFETY & VOLUME LIMITS',
        '## FAILURE HANDLING',
        '## LEARN FROM OUTCOMES',
        '## COMPLIANCE',
      ]) {
        expect(skill.systemPrompt).toContain(block);
      }
      expect(skill.systemPrompt).toContain('5 LinkedIn invites');
      expect(skill.systemPrompt).toContain('25 emails');
      expect(skill.systemPrompt).toContain('across ALL channels combined');
    });

    it('stops the sequence on reply/booking and never double-sends', () => {
      const skill = buildCrossChannelSkill();
      expect(skill.systemPrompt).toContain('Never double-send a step or restart a sequence');
    });

    it('every tool named in the prompt is declared in toolNames', () => {
      const skill = buildCrossChannelSkill();
      assertPromptToolsAreDeclared(skill.systemPrompt!, skill.toolNames);
    });
  });

  it('gives each build call a unique skillId', () => {
    expect(buildAeoSkill().skillId).not.toBe(buildAeoSkill().skillId);
    expect(buildCrossChannelSkill().skillId).not.toBe(buildCrossChannelSkill().skillId);
  });
});
