// Tests verifying that the system prompt contains regeneration instructions
// that allow the LLM to re-call content creation tools when the user explicitly requests it.
//
// Background: Bug where the LLM failed to call create_social_media_posts again when
// asked to regenerate, instead repeating the analysis text. Root cause: the production
// system prompt's Anti-Loop Rule ("NEVER call the same tool twice") was too broad and
// blocked the tool re-call. Fix: add explicit regeneration exception to the prompt.

import { AgentModeService } from '../services/agentModeService';

jest.mock('../services/db', () => ({
  userDb: { getUserById: jest.fn() },
  accountMemoryDb: { getRecentMemories: jest.fn().mockResolvedValue([]) },
}));
jest.mock('../services/chatbotService');
jest.mock('../utils/secretsManager');
jest.mock('../services/settingsService', () => ({
  settingsService: {
    getSetting: jest.fn().mockResolvedValue(null),
    getJsonArraySetting: jest.fn().mockResolvedValue([]),
  },
}));

describe('AgentModeService - System Prompt Regeneration Rule', () => {
  let agentModeService: AgentModeService;

  beforeEach(() => {
    jest.clearAllMocks();
    agentModeService = new AgentModeService();
  });

  // getMarketingSystemPrompt() now returns AGENT_MODE_SYSTEM_PROMPT from agentModeSystemPrompt.ts
  // directly — no DB lookup. These tests verify the code-committed prompt contains the fix.
  describe('System prompt regeneration instruction', () => {
    it('should contain a regeneration rule for content creation tools', async () => {
      const systemPrompt = await agentModeService.getMarketingSystemPrompt();
      expect(systemPrompt).toContain('Regenerating Content');
    });

    it('should instruct LLM to call create_social_media_posts again on regeneration', async () => {
      const systemPrompt = await agentModeService.getMarketingSystemPrompt();
      expect(systemPrompt).toContain('create_social_media_posts');
      // The regeneration rule should reference the content creation tools
      const regenerateIdx = systemPrompt.indexOf('Regenerating Content');
      expect(regenerateIdx).toBeGreaterThanOrEqual(0);
      const regenerateSection = systemPrompt.slice(regenerateIdx, regenerateIdx + 500);
      expect(regenerateSection).toContain('create_social_media_posts');
    });

    it('should explicitly tell LLM not to repeat analysis text on regeneration requests', async () => {
      const systemPrompt = await agentModeService.getMarketingSystemPrompt();
      const regenerateIdx = systemPrompt.indexOf('Regenerating Content');
      expect(regenerateIdx).toBeGreaterThanOrEqual(0);
      const regenerateSection = systemPrompt.slice(regenerateIdx, regenerateIdx + 600);
      // Must instruct the LLM to call the tool, not just output text
      expect(regenerateSection.toLowerCase()).toMatch(/call.*tool|tool.*again|must call/i);
    });

    it('should name common regeneration trigger phrases', async () => {
      const systemPrompt = await agentModeService.getMarketingSystemPrompt();
      const regenerateIdx = systemPrompt.indexOf('Regenerating Content');
      expect(regenerateIdx).toBeGreaterThanOrEqual(0);
      const regenerateSection = systemPrompt.slice(regenerateIdx, regenerateIdx + 600);
      // Should mention common user phrases that trigger regeneration
      expect(regenerateSection.toLowerCase()).toMatch(/again|redo|regenerate/i);
    });
  });
});
