import { AgentModeService } from '../services/agentModeService';

// Mock all dependencies
jest.mock('openai');
jest.mock('../services/settingsService');
jest.mock('../services/db');
jest.mock('../services/chatbotService');
jest.mock('../utils/secretsManager');
jest.mock('../services/skillService', () => ({
  skillService: {
    getPublishedSkills: jest.fn().mockResolvedValue([]),
    getSkillsByIds: jest.fn().mockResolvedValue([]),
  },
}));
jest.mock('../services/subscriptionService', () => ({
  getAllowedSkills: jest.fn().mockResolvedValue(['*']),
  resolveSkillsToToolNames: jest.fn().mockResolvedValue(['*']),
  filterFunctionCalls: jest.fn().mockImplementation((tools: any) => tools),
}));

function makeSession(sessionId = 'test-session') {
  return {
    sessionId,
    messages: [],
    associatedSkills: null,
  };
}

function mockDeps(overrides: { session?: any } = {}) {
  const mockChatbotService = require('../services/chatbotService');
  mockChatbotService.chatbotDb = {
    getChatSession: jest.fn().mockResolvedValue(overrides.session ?? makeSession()),
    addMessagesToSession: jest.fn().mockResolvedValue(undefined),
  };

  const mockSettingsService = require('../services/settingsService');
  mockSettingsService.settingsService = {
    getSetting: jest.fn().mockResolvedValue(null),
  };

  const mockDb = require('../services/db');
  mockDb.userDb = { getUserById: jest.fn().mockResolvedValue({ userId: 'test-user', isAdmin: false }) };
  mockDb.accountMemoryDb = { getRecentMemories: jest.fn().mockResolvedValue([]) };
}

/**
 * The raw OpenAI-SDK truncation shape (Azure gpt-* and Gemini OpenAI-compat — the
 * DEFAULT agent model): the output-token limit cut the create_html_file call off
 * mid-argument, so finish_reason is 'length' but the partial tool_calls array is
 * STILL attached, with content_draft sliced off (incomplete JSON). Unlike the
 * Bedrock/Vertex adapters, this path does not null its own tool_calls (ENG-403).
 */
function makeTruncatedToolCallResponse() {
  return {
    choices: [
      {
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call-trunc-1',
              type: 'function',
              // NOTE: incomplete JSON — content_draft was cut off mid-string.
              function: { name: 'create_html_file', arguments: '{"title":"One Pager","content_draft":"<html><body><h1>Rebrand' },
            },
          ],
        },
        finish_reason: 'length',
      },
    ],
    usage: { prompt_tokens: 5000, completion_tokens: 32000, total_tokens: 37000 },
  };
}

/** Normal text response */
function makeTextResponse(text = 'Here is the report.') {
  return {
    choices: [
      {
        message: { role: 'assistant', content: text, tool_calls: null },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 5, completion_tokens: 20, total_tokens: 25 },
  };
}

describe('AgentModeService - Truncated tool call guard (ENG-403, OpenAI/Gemini path)', () => {
  let agentModeService: AgentModeService;

  beforeEach(() => {
    jest.clearAllMocks();
    agentModeService = new AgentModeService();
    // Suppress suggested-reply generation so it doesn't add extra callLLM calls
    jest.spyOn(agentModeService as any, 'generateSuggestedReplies').mockResolvedValue([]);
  });

  it('does NOT execute a max_tokens-truncated tool call and routes to the continuation path instead', async () => {
    mockDeps();

    const callLLMSpy = jest
      .spyOn(agentModeService as any, 'callLLM')
      .mockResolvedValueOnce(makeTruncatedToolCallResponse()) // iter 1: truncated create_html_file (finish_reason=length)
      .mockResolvedValueOnce(makeTextResponse('Rebranded one-pager created.')); // iter 2: continuation succeeds

    const executeToolSpy = jest
      .spyOn(agentModeService as any, 'executeTool')
      .mockResolvedValue(JSON.stringify({ success: true }));

    const result = await agentModeService.generateMarketingResponse(
      'Rebrand this one-pager into HTML.',
      [],
      'test-user',
      agentModeService.default_model,
      'test-session'
    );

    // The broken (truncated) create_html_file call must never reach execution/validation.
    expect(executeToolSpy).not.toHaveBeenCalled();

    // The loop must have asked the model to continue rather than shipping the broken call.
    expect(callLLMSpy).toHaveBeenCalledTimes(2);
    const secondCallMessages = callLLMSpy.mock.calls[1][1] as any[];
    const continuePrompt = secondCallMessages.find(
      (m: any) => typeof m.content === 'string' && m.content.includes('continue exactly where you left off')
    );
    expect(continuePrompt).toBeDefined();
    expect(continuePrompt.content).toContain('[SYSTEM]');

    // And the dangling truncated tool_calls must be stripped from history, otherwise the
    // continuation request would be a malformed assistant tool_calls turn with no tool results.
    const assistantWithToolCalls = secondCallMessages.find(
      (m: any) => m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0
    );
    expect(assistantWithToolCalls).toBeUndefined();

    expect(result.content).toBe('Rebranded one-pager created.');
  });
});
