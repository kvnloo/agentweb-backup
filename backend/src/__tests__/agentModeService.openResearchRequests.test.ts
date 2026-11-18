// Unit tests for the open-research-request tracker (ENG-738).
//
// The primary ENG-738 session showed a distinct failure mode from the
// timeout-resilience bug: perform_deep_research genuinely timed out (the
// assistant told the user so), the user's very next message pivoted to an
// unrelated ask, and the assistant fully executed the new request and never
// returned to the original one — later misremembering, ~200 messages on,
// that it had "never called the research tool" at all. Nothing in the
// codebase tracks an unresolved research/lookup request across separate user
// turns (workPlan only exists for explicit multi-step flows; the completion
// gate is scheduled-run-only). These tests cover the new mechanism that
// closes that gap: detect a timed-out RESEARCH_LOOKUP_TOOLS call, persist it,
// and re-surface it as an authoritative reminder on later turns.

import { AgentModeService } from '../services/agentModeService';
import { chatbotDb } from '../services/chatbotService';

jest.mock('openai');
jest.mock('../services/settingsService');
jest.mock('../services/db');
jest.mock('../utils/secretsManager');
jest.mock('../services/tokenUsageService', () => ({
}));

jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    getChatSession: jest.fn(),
    addMessageToSession: jest.fn().mockResolvedValue({}),
    addMessagesToSession: jest.fn().mockResolvedValue(undefined),
    incrementCalledFunctions: jest.fn().mockResolvedValue({}),
    incrementFailedFunctions: jest.fn().mockResolvedValue({}),
    recordOpenResearchRequests: jest.fn().mockResolvedValue(undefined),
    updateSessionResultEndpointMetadata: jest.fn().mockResolvedValue({}),
  },
  searchPlatformKnowledgeBase: jest.fn().mockResolvedValue([]),
}));

jest.mock('../services/skillService', () => ({
  skillService: {
    getPublishedSkills: jest.fn().mockResolvedValue([]),
    getSkillsByIds: jest.fn().mockResolvedValue([]),
    getSkillsAvailableToUser: jest.fn().mockResolvedValue([]),
    getSkillsByOwner: jest.fn().mockResolvedValue([]),
  },
}));

jest.mock('../services/subscriptionService', () => ({
  getAllowedSkills: jest.fn().mockResolvedValue(['*']),
  getPublicAllowedSkills: jest.fn().mockResolvedValue([]),
  resolveSkillsToToolNames: jest.fn().mockResolvedValue(['*']),
  filterFunctionCalls: jest.fn().mockImplementation((tools: any) => tools),
}));

jest.mock('../mcp/client/mcpClientService', () => ({
  McpClientService: jest.fn().mockImplementation(() => ({
    initialize: jest.fn(),
    getTools: jest.fn().mockReturnValue([]),
    listTools: jest.fn().mockResolvedValue([]),
    callTool: jest.fn().mockResolvedValue({}),
  })),
}));

jest.mock('../mcp/client/toolRegistry', () => ({
  ToolRegistry: jest.fn().mockImplementation(() => ({
    register: jest.fn(),
    unregister: jest.fn(),
    getAllTools: jest.fn().mockReturnValue([]),
    getTool: jest.fn(),
    getToolDefinitions: jest.fn().mockReturnValue([]),
  })),
}));

describe('AgentModeService - open research request tracking (ENG-738)', () => {
  describe('detectOpenResearchRequestChanges', () => {
    const FIXED_NOW = '2026-07-27T18:57:00.000Z';

    it('adds an open request for a perform_deep_research soft-failure classified as timeout', () => {
      const entries = [
        {
          name: 'perform_deep_research',
          arguments: { topic: 'Semiconductor architecture and Apple silicon moat' },
          result: {
            success: false,
            partial: true,
            error: 'Deep research timed out. Please try again with a more specific topic.',
          },
        },
      ];

      const { additions, resolvedTools } = (AgentModeService as any).detectOpenResearchRequestChanges(entries, FIXED_NOW);

      expect(resolvedTools).toEqual([]);
      expect(additions).toEqual([
        {
          tool: 'perform_deep_research',
          topic: 'Semiconductor architecture and Apple silicon moat',
          failedAt: FIXED_NOW,
          errorSummary: 'Deep research timed out. Please try again with a more specific topic.',
        },
      ]);
    });

    it('resolves (clears) an open request when the same tool succeeds', () => {
      const entries = [
        {
          name: 'perform_deep_research',
          arguments: { topic: 'Semiconductor architecture' },
          result: { success: true, research_url: 'https://s3.example.com/r.md' },
        },
      ];

      const { additions, resolvedTools } = (AgentModeService as any).detectOpenResearchRequestChanges(entries, FIXED_NOW);

      expect(additions).toEqual([]);
      expect(resolvedTools).toEqual(['perform_deep_research']);
    });

    it('adds an open request for a THROWN (not soft-failure) timeout from a research-lookup tool', () => {
      const entries = [
        {
          name: 'you_search_web',
          arguments: { query: 'best LinkedIn posts 2026' },
          error: 'Request timed out after 30000ms',
        },
      ];

      const { additions } = (AgentModeService as any).detectOpenResearchRequestChanges(entries, FIXED_NOW);

      expect(additions).toEqual([
        {
          tool: 'you_search_web',
          topic: 'best LinkedIn posts 2026',
          failedAt: FIXED_NOW,
          errorSummary: 'Request timed out after 30000ms',
        },
      ]);
    });

    it('does not add or resolve on a non-timeout failure — leaves any existing open entry untouched', () => {
      const entries = [
        {
          name: 'perform_deep_research',
          arguments: { topic: 'Topic X' },
          result: { success: false, error: 'Deep Research service is not available. Please check API key configuration.' },
        },
      ];

      const { additions, resolvedTools } = (AgentModeService as any).detectOpenResearchRequestChanges(entries, FIXED_NOW);

      expect(additions).toEqual([]);
      expect(resolvedTools).toEqual([]);
    });

    it('ignores tools outside RESEARCH_LOOKUP_TOOLS entirely, even on a timeout-classified failure', () => {
      const entries = [
        {
          name: 'playwright_browser_navigate',
          arguments: { url: 'https://example.com' },
          error: 'Navigation timed out after 30000ms',
        },
      ];

      const { additions, resolvedTools } = (AgentModeService as any).detectOpenResearchRequestChanges(entries, FIXED_NOW);

      expect(additions).toEqual([]);
      expect(resolvedTools).toEqual([]);
    });

    it('aggregates multiple entries in one iteration independently', () => {
      const entries = [
        {
          name: 'perform_deep_research',
          arguments: { topic: 'Topic A' },
          result: { success: false, partial: true, error: 'Deep research timed out.' },
        },
        {
          name: 'you_search_web',
          arguments: { query: 'Topic B' },
          result: { success: true, results: [] },
        },
        {
          name: 'linkedin_outreach',
          arguments: { action: 'get-profile', profile_url: 'https://linkedin.com/in/x' },
          error: 'ETIMEDOUT',
        },
      ];

      const { additions, resolvedTools } = (AgentModeService as any).detectOpenResearchRequestChanges(entries, FIXED_NOW);

      expect(additions.map((a: any) => a.tool).sort()).toEqual(['linkedin_outreach', 'perform_deep_research']);
      expect(resolvedTools).toEqual(['you_search_web']);
    });

    it('truncates a topic derived from a long free-text query to 150 chars', () => {
      const longQuery = 'a'.repeat(300);
      const entries = [
        {
          name: 'you_search_web',
          arguments: { query: longQuery },
          error: 'timed out',
        },
      ];

      const { additions } = (AgentModeService as any).detectOpenResearchRequestChanges(entries, FIXED_NOW);

      expect(additions[0].topic.length).toBe(150);
    });

    it('falls back to a generic topic label when args carry no usable text field', () => {
      const entries = [
        {
          name: 'linkedin_outreach',
          arguments: {},
          error: 'deadline exceeded',
        },
      ];

      const { additions } = (AgentModeService as any).detectOpenResearchRequestChanges(entries, FIXED_NOW);

      expect(additions[0].topic).toBe('unspecified topic');
    });

    it('returns empty additions/resolvedTools for an empty entry list', () => {
      const { additions, resolvedTools } = (AgentModeService as any).detectOpenResearchRequestChanges([], FIXED_NOW);
      expect(additions).toEqual([]);
      expect(resolvedTools).toEqual([]);
    });
  });

  describe('buildOpenResearchRequestReminder', () => {
    const NOW_MS = Date.parse('2026-07-27T20:00:00.000Z');

    it('returns an empty array when there are no open requests', () => {
      expect(AgentModeService.buildOpenResearchRequestReminder(undefined, NOW_MS)).toEqual([]);
      expect(AgentModeService.buildOpenResearchRequestReminder([], NOW_MS)).toEqual([]);
    });

    it('surfaces a recent open request with the tool, topic, and an explicit do-not-drop instruction', () => {
      const openRequests = [
        {
          tool: 'perform_deep_research',
          topic: 'Semiconductor architecture and Apple silicon moat',
          failedAt: '2026-07-27T18:57:00.000Z', // ~1h before NOW_MS
          errorSummary: 'Deep research timed out. Please try again with a more specific topic.',
        },
      ];

      const messages = AgentModeService.buildOpenResearchRequestReminder(openRequests, NOW_MS);

      expect(messages.length).toBe(1);
      expect(messages[0].role).toBe('assistant');
      expect(messages[0].content).toContain('perform_deep_research');
      expect(messages[0].content).toContain('Semiconductor architecture and Apple silicon moat');
      expect(messages[0].content.toLowerCase()).toContain('do not');
    });

    it('filters out an open request older than the age window', () => {
      const openRequests = [
        {
          tool: 'perform_deep_research',
          topic: 'Old topic',
          failedAt: '2026-07-20T00:00:00.000Z', // 7+ days before NOW_MS
          errorSummary: 'Deep research timed out.',
        },
      ];

      const messages = AgentModeService.buildOpenResearchRequestReminder(openRequests, NOW_MS);

      expect(messages).toEqual([]);
    });

    it('lists multiple still-recent open requests in one combined message', () => {
      const openRequests = [
        {
          tool: 'perform_deep_research',
          topic: 'Topic A',
          failedAt: '2026-07-27T19:00:00.000Z',
          errorSummary: 'Deep research timed out.',
        },
        {
          tool: 'you_search_web',
          topic: 'Topic B',
          failedAt: '2026-07-27T19:30:00.000Z',
          errorSummary: 'Request timed out.',
        },
      ];

      const messages = AgentModeService.buildOpenResearchRequestReminder(openRequests, NOW_MS);

      expect(messages.length).toBe(1);
      expect(messages[0].content).toContain('Topic A');
      expect(messages[0].content).toContain('Topic B');
    });
  });

  // End-to-end through the real per-iteration tool-dispatch loop (mirrors the
  // established harness in agentModeService.llmTiming.test.ts): mocks the LLM
  // call and the tool executor, but runs the REAL extractMinimalToolResult,
  // detectOpenResearchRequestChanges, and the counter-update integration point
  // so the actual wiring — not just the pure functions in isolation — is verified.
  describe('wiring into the agent-mode tool-dispatch loop', () => {
    let agentModeService: AgentModeService;
    let llmCallSpy: jest.SpyInstance;

    beforeEach(() => {
      jest.clearAllMocks();

      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({
        sessionId: 'test-session',
        userId: 'test-user',
        messages: [],
        workPlan: null,
        associatedSkills: [],
      });

      const mockSettingsService = require('../services/settingsService');
      mockSettingsService.settingsService = { getSetting: jest.fn().mockResolvedValue(null) };

      const mockDb = require('../services/db');
      mockDb.userDb = { getUserById: jest.fn().mockResolvedValue(null) };

      agentModeService = new AgentModeService();
      llmCallSpy = jest.spyOn(agentModeService as any, 'callLLM');
    });

    it('records an open research request when perform_deep_research times out mid-turn', async () => {
      llmCallSpy.mockResolvedValueOnce({
        choices: [{
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{
              id: 'tc-research',
              function: {
                name: 'perform_deep_research',
                arguments: JSON.stringify({ topic: 'Semiconductor architecture and Apple silicon moat', depth: 'comprehensive' }),
              },
            }],
          },
        }],
      }).mockResolvedValueOnce({
        choices: [{
          message: {
            role: 'assistant',
            content: 'Your request timed out. Please try again.',
            tool_calls: null,
          },
        }],
      });

      jest.spyOn(agentModeService as any, 'executeTool').mockImplementation(async (...args: any[]) => {
        const toolName = args[1] as string;
        if (toolName === 'perform_deep_research') {
          return {
            success: false,
            partial: true,
            message: 'Deep research on "Semiconductor architecture and Apple silicon moat" didn\'t finish before the time budget ran out.',
            error: 'Deep research timed out. Please try again with a more specific topic.',
            data: { research_depth: 'comprehensive', topic: 'Semiconductor architecture and Apple silicon moat' },
          };
        }
        return { success: true };
      });

      await agentModeService.generateMarketingResponse(
        'research fab design and Apple silicon moat', [], 'test-user', 'test-model', 'test-session', true
      );

      expect(chatbotDb.recordOpenResearchRequests).toHaveBeenCalledWith(
        'test-session',
        [
          expect.objectContaining({
            tool: 'perform_deep_research',
            topic: 'Semiconductor architecture and Apple silicon moat',
            errorSummary: 'Deep research timed out. Please try again with a more specific topic.',
          }),
        ],
        []
      );
    });

    it('resolves an open research request when perform_deep_research succeeds', async () => {
      llmCallSpy.mockResolvedValueOnce({
        choices: [{
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{
              id: 'tc-research',
              function: { name: 'perform_deep_research', arguments: JSON.stringify({ topic: 'AI in marketing' }) },
            }],
          },
        }],
      }).mockResolvedValueOnce({
        choices: [{ message: { role: 'assistant', content: 'Done.', tool_calls: null } }],
      });

      jest.spyOn(agentModeService as any, 'executeTool').mockResolvedValue({
        success: true,
        message: 'Deep research completed successfully.',
        data: { research_url: 'https://s3.example.com/r.md', research_depth: 'detailed' },
      });

      await agentModeService.generateMarketingResponse(
        'research AI in marketing', [], 'test-user', 'test-model', 'test-session', true
      );

      expect(chatbotDb.recordOpenResearchRequests).toHaveBeenCalledWith('test-session', [], ['perform_deep_research']);
    });

    it('does not call recordOpenResearchRequests when no research-lookup tool ran', async () => {
      llmCallSpy.mockResolvedValueOnce({
        choices: [{
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{ id: 'tc1', function: { name: 'generate_image', arguments: '{}' } }],
          },
        }],
      }).mockResolvedValueOnce({
        choices: [{ message: { role: 'assistant', content: 'Done.', tool_calls: null } }],
      });

      jest.spyOn(agentModeService as any, 'executeTool').mockResolvedValue({ success: true, imageUrl: 'https://x/y.png' });

      await agentModeService.generateMarketingResponse(
        'make an image', [], 'test-user', 'test-model', 'test-session', true
      );

      expect(chatbotDb.recordOpenResearchRequests).not.toHaveBeenCalled();
    });
  });
});
