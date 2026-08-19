/**
 * Tests for seed-eng618-leadgen-skills.ts (ENG-204 Part 2 — ENG-618).
 * Pure build functions only — no DynamoDB-dependent main().
 * (#7 Visitor de-anon is blocked on ENG-625 and intentionally not seeded.)
 */
import { describe, it, expect } from '@jest/globals';

import {
  buildXEngineSkill,
  buildOutboundVideoSkill,
  buildRedditMiningSkill,
  X_ENGINE_SKILL_NAME,
  OUTBOUND_VIDEO_SKILL_NAME,
  REDDIT_MINING_SKILL_NAME,
} from '../scripts/seed-eng618-leadgen-skills';

function assertPromptToolsAreDeclared(systemPrompt: string, toolNames: string[]) {
  const CANDIDATE_TOOLS = [
    'twitter_manage_post',
    'twitter_outreach',
    'create_social_media_posts',
    'you_search_web',
    'perform_deep_research',
    'generate_video',
    'compose_video',
    'mux_video_with_audio',
    'import_leads_from_search',
    'find_or_lookup_email',
    'get_leads',
    'search_leads',
    'update_email_draft_for_lead',
    'add_lead_engagement',
    'list_connected_accounts',
    'read_market_strategy',
    'read_brand_guidelines',
    'save_memory',
  ];
  const declared = new Set(toolNames);
  for (const tool of CANDIDATE_TOOLS) {
    if (new RegExp(`\\b${tool}\\b`).test(systemPrompt)) {
      expect(declared.has(tool)).toBe(true);
    }
  }
}

describe('seed-eng618-leadgen-skills', () => {
  describe('buildXEngineSkill (#8)', () => {
    it('creates a valid public action skill, on-demand founder posting', () => {
      const skill = buildXEngineSkill();
      expect(skill.name).toBe(X_ENGINE_SKILL_NAME);
      expect(skill.isPublished).toBe(true);
      expect(skill.visibility).toBe('public');
      expect(skill.isBuiltIn).toBe(true);
      expect(skill.category).toBe('action');
      expect(skill.triggerMode).toBe('on_demand');
    });

    it('declares X post/reply + research tools', () => {
      const skill = buildXEngineSkill();
      expect(skill.toolNames).toEqual(
        expect.arrayContaining([
          'twitter_manage_post',
          'twitter_outreach',
          'create_social_media_posts',
          'list_connected_accounts',
          'save_memory',
        ])
      );
    });

    it('carries the PUBLISH GATE, deferring the unattended call to the run', () => {
      // ENG-947: this used to assert "never publish" unattended. That blanket
      // refusal outranked the run's PUBLISH AUTHORIZATION block and deadlocked
      // authorized schedules, so the gate now defers rather than decides.
      // ENG-1311: the block's heading changed from "(ABSOLUTE — overrides
      // every other instruction in this prompt)" to "(scoped — governs ONLY
      // the moment ... about to call a tool that posts/publishes/...)" so it
      // no longer colours the whole session — see applyHardening.ts.
      const skill = buildXEngineSkill();
      expect(skill.systemPrompt).toContain('## PUBLISH GATE (scoped');
      expect(skill.systemPrompt).not.toContain('save as a draft and notify; never publish');
      expect(skill.systemPrompt!.replace(/\s+/g, ' ')).toContain('PUBLISH AUTHORIZATION');
    });

    it('every tool named in the prompt is declared in toolNames', () => {
      const skill = buildXEngineSkill();
      assertPromptToolsAreDeclared(skill.systemPrompt!, skill.toolNames);
    });
  });

  describe('buildOutboundVideoSkill (#9)', () => {
    it('creates a valid public action skill', () => {
      const skill = buildOutboundVideoSkill();
      expect(skill.name).toBe(OUTBOUND_VIDEO_SKILL_NAME);
      expect(skill.category).toBe('action');
      expect(skill.triggerMode).toBe('both');
      expect(skill.visibility).toBe('public');
    });

    it('declares the video production stack and never sends', () => {
      const skill = buildOutboundVideoSkill();
      expect(skill.toolNames).toEqual(
        expect.arrayContaining(['generate_video', 'compose_video', 'mux_video_with_audio'])
      );
      expect(skill.toolNames).not.toContain('send_email_to_lead');
    });

    it('caps video generation and forbids self-sending in SAFETY block', () => {
      const skill = buildOutboundVideoSkill();
      expect(skill.systemPrompt).toContain('## SAFETY & VOLUME LIMITS');
      expect(skill.systemPrompt).toContain('25 personalized videos');
      expect(skill.systemPrompt).toContain('does NOT send outreach');
    });

    it('every tool named in the prompt is declared in toolNames', () => {
      const skill = buildOutboundVideoSkill();
      assertPromptToolsAreDeclared(skill.systemPrompt!, skill.toolNames);
    });
  });

  describe('buildRedditMiningSkill (#10)', () => {
    it('creates a valid public action skill', () => {
      const skill = buildRedditMiningSkill();
      expect(skill.name).toBe(REDDIT_MINING_SKILL_NAME);
      expect(skill.category).toBe('action');
      expect(skill.triggerMode).toBe('both');
      expect(skill.visibility).toBe('public');
    });

    it('declares mining + import tools but NOT any community-posting tool', () => {
      const skill = buildRedditMiningSkill();
      expect(skill.toolNames).toEqual(
        expect.arrayContaining([
          'you_search_web',
          'perform_deep_research',
          'import_leads_from_search',
          'find_or_lookup_email',
        ])
      );
      expect(skill.toolNames).not.toContain('post_on_connected_account');
      expect(skill.toolNames).not.toContain('twitter_manage_post');
    });

    it('forbids auto-posting to communities and enforces import caps + GDPR', () => {
      const skill = buildRedditMiningSkill();
      expect(skill.systemPrompt).toContain('NEVER auto-post');
      expect(skill.systemPrompt).toContain('50 new leads imported');
      expect(skill.systemPrompt).toContain('## COMPLIANCE');
      expect(skill.systemPrompt).toContain('GDPR/CCPA');
    });

    it('every tool named in the prompt is declared in toolNames', () => {
      const skill = buildRedditMiningSkill();
      assertPromptToolsAreDeclared(skill.systemPrompt!, skill.toolNames);
    });
  });

  it('gives each build call a unique skillId', () => {
    expect(buildXEngineSkill().skillId).not.toBe(buildXEngineSkill().skillId);
    expect(buildOutboundVideoSkill().skillId).not.toBe(buildOutboundVideoSkill().skillId);
    expect(buildRedditMiningSkill().skillId).not.toBe(buildRedditMiningSkill().skillId);
  });
});
