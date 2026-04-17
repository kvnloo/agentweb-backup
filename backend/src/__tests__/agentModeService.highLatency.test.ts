import { AgentModeService } from '../services/agentModeService';

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
  return { sessionId, messages: [], associatedSkills: null };
}

function mockDeps() {
  const mockChatbotService = require('../services/chatbotService');
  mockChatbotService.chatbotDb = {
    getChatSession: jest.fn().mockResolvedValue(makeSession()),
    addMessagesToSession: jest.fn().mockResolvedValue(undefined),
    incrementCalledFunctions: jest.fn().mockResolvedValue(undefined),
    incrementFailedFunctions: jest.fn().mockResolvedValue(undefined),
    addToolCostToSession: jest.fn().mockResolvedValue(undefined),
  };
  const mockSettingsService = require('../services/settingsService');
  mockSettingsService.settingsService = {
    getSetting: jest.fn().mockResolvedValue(null),
  };
  const mockDb = require('../services/db');
  mockDb.userDb = { getUserById: jest.fn().mockResolvedValue({ userId: 'test-user', isAdmin: false }) };
  mockDb.accountMemoryDb = { getRecentMemories: jest.fn().mockResolvedValue([]) };
}

function makeLLMResponse(text = 'Done.') {
  return {
    choices: [{ message: { role: 'assistant', content: text, tool_calls: null }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function makeSearchToolCallResponse(callId = 'call_1') {
  return {
    choices: [{
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: callId,
          type: 'function',
          function: { name: 'search_web', arguments: JSON.stringify({ query: 'test query' }) },
        }],
      },
      finish_reason: 'tool_calls',
    }],
    usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
  };
}

describe('AgentModeService - High Latency Mitigations', () => {
  let service: AgentModeService;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
    service = new AgentModeService();
  });

  describe('Wall-clock response timeout', () => {
    it('breaks out of the loop and returns a timeout message when elapsed time exceeds 4.5 minutes', async () => {
      mockDeps();

      // Simulate time advancing past 4.5 minutes after the first LLM call
      const startTime = Date.now();
      let callCount = 0;
      jest.spyOn(service as any, 'callLLM').mockImplementation(async () => {
        callCount++;
        if (callCount >= 2) {
          // Simulate 4.6 minutes elapsed by mocking Date.now
          jest.spyOn(Date, 'now').mockReturnValue(startTime + 4.6 * 60 * 1000 + 1);
        }
        return makeSearchToolCallResponse(`call_${callCount}`);
      });

      jest.spyOn(service as any, 'executeTool').mockResolvedValue({ success: true, data: 'result' });
      jest.spyOn(service as any, 'getFilteredTools').mockResolvedValue([]);

      const result = await service.generateMarketingResponse(
        'research 50 competitors',
        [],
        'test-user',
        service.default_model,
        'test-session'
      );

      // Must have broken out due to timeout, not iterated to 40
      expect(callCount).toBeLessThan(10);
      expect(result.content).toMatch(/taking (too long|longer than expected)|time.?out|unable to complete/i);
    });

    it('does NOT time out for fast responses that complete within 4.5 minutes', async () => {
      mockDeps();

      let callCount = 0;
      jest.spyOn(service as any, 'callLLM').mockImplementation(async () => {
        callCount++;
        if (callCount >= 2) return makeLLMResponse('Here is the result.');
        return makeSearchToolCallResponse('call_1');
      });
      jest.spyOn(service as any, 'executeTool').mockResolvedValue({ success: true });
      jest.spyOn(service as any, 'getFilteredTools').mockResolvedValue([]);

      const result = await service.generateMarketingResponse(
        'quick task',
        [],
        'test-user',
        service.default_model,
        'test-session'
      );

      expect(result.content).toBe('Here is the result.');
    });

    it('timeout check respects isCancelled — does not override cancellation with timeout message', async () => {
      mockDeps();

      let cancelled = false;
      let callCount = 0;
      const fakeStart = Date.now() - 5 * 60 * 1000; // already 5 min in the past
      jest.spyOn(Date, 'now').mockReturnValue(fakeStart + 5 * 60 * 1000 + 1);

      jest.spyOn(service as any, 'callLLM').mockImplementation(async () => {
        callCount++;
        cancelled = true; // cancel on first iteration
        return makeSearchToolCallResponse('call_1');
      });
      jest.spyOn(service as any, 'executeTool').mockResolvedValue({ success: true });
      jest.spyOn(service as any, 'getFilteredTools').mockResolvedValue([]);

      const result = await service.generateMarketingResponse(
        'any task',
        [],
        'test-user',
        service.default_model,
        'test-session',
        false,
        undefined,
        undefined,
        false,
        () => cancelled
      );

      expect(result.cancelled).toBe(true);
    });
  });

  describe('search_web per-response cap', () => {
    it('stops offering search_web tool after 15 calls within one response', async () => {
      mockDeps();

      let callCount = 0;
      let toolsPassedToLLM: any[][] = [];

      jest.spyOn(service as any, 'callLLM').mockImplementation(async (_model: any, _msgs: any, opts: any) => {
        callCount++;
        toolsPassedToLLM.push(opts?.tools ?? []);
        // After 15 search_web results, return a final answer
        if (callCount > 16) return makeLLMResponse('Final answer after many searches.');
        return makeSearchToolCallResponse(`call_${callCount}`);
      });

      jest.spyOn(service as any, 'executeTool').mockResolvedValue({ success: true, results: [] });
      jest.spyOn(service as any, 'getFilteredTools').mockResolvedValue([
        { function: { name: 'search_web' } },
        { function: { name: 'read_brand_guidelines' } },
      ]);

      await service.generateMarketingResponse(
        'research everything',
        [],
        'test-user',
        service.default_model,
        'test-session'
      );

      // After 15 search_web calls, subsequent LLM calls must not include search_web in tools
      const callsAfterCap = toolsPassedToLLM.slice(15);
      for (const tools of callsAfterCap) {
        const names = tools.map((t: any) => t.function?.name);
        expect(names).not.toContain('search_web');
      }
    });

    it('injects a warning message when search_web cap is hit', async () => {
      mockDeps();

      let callCount = 0;
      let messagesAtCapHit: any[] | null = null;

      jest.spyOn(service as any, 'callLLM').mockImplementation(async (_model: any, msgs: any) => {
        callCount++;
        if (callCount === 16) {
          // Capture messages the moment cap is hit
          messagesAtCapHit = [...msgs];
          return makeLLMResponse('Wrapping up now.');
        }
        return makeSearchToolCallResponse(`call_${callCount}`);
      });

      jest.spyOn(service as any, 'executeTool').mockResolvedValue({ success: true, results: [] });
      jest.spyOn(service as any, 'getFilteredTools').mockResolvedValue([
        { function: { name: 'search_web' } },
      ]);

      await service.generateMarketingResponse(
        'research everything',
        [],
        'test-user',
        service.default_model,
        'test-session'
      );

      expect(messagesAtCapHit).not.toBeNull();
      const capMsg = messagesAtCapHit!.find(
        (m: any) => typeof m.content === 'string' && m.content.includes('search')
      );
      expect(capMsg).toBeDefined();
    });

    it('allows search_web when calls are below the cap', async () => {
      mockDeps();

      let callCount = 0;
      const toolsPassedToLLM: any[][] = [];

      jest.spyOn(service as any, 'callLLM').mockImplementation(async (_model: any, _msgs: any, opts: any) => {
        callCount++;
        toolsPassedToLLM.push(opts?.tools ?? []);
        if (callCount >= 3) return makeLLMResponse('Done with 2 searches.');
        return makeSearchToolCallResponse(`call_${callCount}`);
      });

      jest.spyOn(service as any, 'executeTool').mockResolvedValue({ success: true, results: [] });
      jest.spyOn(service as any, 'getFilteredTools').mockResolvedValue([
        { function: { name: 'search_web' } },
      ]);

      await service.generateMarketingResponse(
        'quick research',
        [],
        'test-user',
        service.default_model,
        'test-session'
      );

      // All calls should still have search_web available
      for (const tools of toolsPassedToLLM) {
        const names = tools.map((t: any) => t.function?.name);
        expect(names).toContain('search_web');
      }
    });
  });
});
