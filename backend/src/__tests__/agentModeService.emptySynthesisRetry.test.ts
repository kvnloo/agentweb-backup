import { AgentModeService } from '../services/agentModeService';
import { EMPTY_FINAL_RESPONSE_FALLBACK } from '../services/agentMode/core/termination';

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

/** LLM response with tool calls (triggers tool execution path) */
function makeToolCallResponse(toolName = 'search_tool_response') {
  return {
    choices: [
      {
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call-1',
              type: 'function',
              function: { name: toolName, arguments: '{"query":"test"}' },
            },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: { prompt_tokens: 93000, completion_tokens: 100, total_tokens: 93100 },
  };
}

/** Empty response — no tool calls, no text (Gemini extended-thinking silent failure) */
function makeEmptyResponse() {
  return {
    choices: [
      {
        message: { role: 'assistant', content: '', tool_calls: null },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 108000, completion_tokens: 0, total_tokens: 108000 },
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

describe('AgentModeService - Empty Synthesis Retry', () => {
  let agentModeService: AgentModeService;

  beforeEach(() => {
    jest.clearAllMocks();
    agentModeService = new AgentModeService();
    // Suppress suggested-reply generation so it doesn't add extra callLLM calls
    jest.spyOn(agentModeService as any, 'generateSuggestedReplies').mockResolvedValue([]);
  });

  it('injects synthesis prompt and retries when LLM returns empty content after tool calls', async () => {
    mockDeps();

    const callLLMSpy = jest
      .spyOn(agentModeService as any, 'callLLM')
      .mockResolvedValueOnce(makeToolCallResponse())  // iter 1: tool call
      .mockResolvedValueOnce(makeEmptyResponse())     // iter 2: empty after tool results
      .mockResolvedValueOnce(makeTextResponse('Daily Activity Report: …'));  // iter 3: synthesis nudge works

    // Mock the tool execution so it returns a result
    jest.spyOn(agentModeService as any, 'executeTool').mockResolvedValue(
      JSON.stringify({ success: true, data: 'tool result' })
    );

    const result = await agentModeService.generateMarketingResponse(
      'Generate a daily activity report.',
      [],
      'test-user',
      agentModeService.default_model,
      'test-session'
    );

    expect(result.content).toBe('Daily Activity Report: …');
    expect(callLLMSpy).toHaveBeenCalledTimes(3);

    // The synthesis nudge message should appear in the 3rd LLM call
    const thirdCallMessages = callLLMSpy.mock.calls[2][1] as any[];
    const synthesisNudge = thirdCallMessages.find(
      (m: any) => typeof m.content === 'string' && m.content.includes('synthesize')
    );
    expect(synthesisNudge).toBeDefined();
    expect(synthesisNudge.content).toContain('[SYSTEM]');
    expect(synthesisNudge.content).toContain('final response');
  });

  it('only retries once (MAX_EMPTY_SYNTHESIS_RETRIES = 1)', async () => {
    mockDeps();

    const callLLMSpy = jest
      .spyOn(agentModeService as any, 'callLLM')
      .mockResolvedValueOnce(makeToolCallResponse())  // iter 1: tool call
      .mockResolvedValueOnce(makeEmptyResponse())     // iter 2: empty
      .mockResolvedValueOnce(makeEmptyResponse());    // iter 3: empty again (no more retries)

    jest.spyOn(agentModeService as any, 'executeTool').mockResolvedValue(
      JSON.stringify({ success: true })
    );

    const result = await agentModeService.generateMarketingResponse(
      'Generate a report.',
      [],
      'test-user',
      agentModeService.default_model,
      'test-session'
    );

    // Still exits — does not loop forever.
    // ENG-1576: this used to assert `result.content` was `''`. That's stale —
    // ENG-1054's "terminating turn stayed empty" fallback (agentModeService.ts, the
    // synthesisResidueGuardEnabled branch keyed on !turnHadUsableText) was added
    // specifically to stop a turn that did real work (a tool call succeeded here)
    // from reaching the user as a blank, unexplained message. Truly empty content
    // in this exact scenario is the bug that fallback exists to prevent, so a
    // truthful action-ledger recap — not '' — is the correct, intentional result.
    expect(result.content).toContain('built directly from the actions I actually ran');
    expect(result.content).toContain('search_tool_response');
    // iter1 (tool call) + iter2 (empty, nudge injected) + iter3 (empty again, exits) = 3 calls
    expect(callLLMSpy).toHaveBeenCalledTimes(3);
  });

  it('does NOT inject synthesis prompt when LLM returns non-empty content after tool calls', async () => {
    mockDeps();

    const callLLMSpy = jest
      .spyOn(agentModeService as any, 'callLLM')
      .mockResolvedValueOnce(makeToolCallResponse())
      .mockResolvedValueOnce(makeTextResponse('Report ready.'));

    jest.spyOn(agentModeService as any, 'executeTool').mockResolvedValue(
      JSON.stringify({ success: true })
    );

    const result = await agentModeService.generateMarketingResponse(
      'Generate a report.',
      [],
      'test-user',
      agentModeService.default_model,
      'test-session'
    );

    expect(result.content).toBe('Report ready.');
    expect(callLLMSpy).toHaveBeenCalledTimes(2);

    // No synthesis nudge in any call
    for (const call of callLLMSpy.mock.calls) {
      const msgs = call[1] as any[];
      const nudge = msgs.find(
        (m: any) => typeof m.content === 'string' && m.content.includes('synthesize')
      );
      expect(nudge).toBeUndefined();
    }
  });

  it('does NOT inject synthesis prompt when LLM returns empty content with no prior tool calls', async () => {
    mockDeps();

    const callLLMSpy = jest
      .spyOn(agentModeService as any, 'callLLM')
      .mockResolvedValueOnce(makeEmptyResponse());

    const result = await agentModeService.generateMarketingResponse(
      'Hello.',
      [],
      'test-user',
      agentModeService.default_model,
      'test-session'
    );

    // No tool calls ran, so no synthesis nudge — exits immediately. Opslane 2026-10-13:
    // the empty answer is replaced by a short fallback rather than returned/stored as "".
    expect(result.content).toBe(EMPTY_FINAL_RESPONSE_FALLBACK);
    expect(callLLMSpy).toHaveBeenCalledTimes(1);
  });
});
