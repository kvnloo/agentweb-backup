/**
 * ENG-1670 — a scheduled run's own tool-calling loop can fire several Gemini
 * calls back-to-back within one turn with nothing pacing them (prod-verified:
 * 4 calls in ~22s on the "LinkedIn Post Factory" schedule, immediately before
 * a 429). The schedule-jitter fix (agentModeController.calculateNextRunTime)
 * addresses platform-wide clustering across DIFFERENT schedules; this covers
 * a single session's own rapid iteration cadence — a narrow, defense-in-depth
 * pacing delay before each Gemini call PAST the first one in a turn, scheduled
 * runs only.
 */

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

import { AgentModeService } from '../services/agentModeService';

function makeSession(sessionType: 'scheduled' | 'interactive', sessionId = 'test-session') {
  return { sessionId, sessionType, messages: [], associatedSkills: null };
}

function mockDeps(session: any) {
  const mockChatbotService = require('../services/chatbotService');
  mockChatbotService.chatbotDb = {
    getChatSession: jest.fn().mockResolvedValue(session),
    addMessagesToSession: jest.fn().mockResolvedValue(undefined),
  };
  const mockSettingsService = require('../services/settingsService');
  mockSettingsService.settingsService = { getSetting: jest.fn().mockResolvedValue(null) };
  const mockDb = require('../services/db');
  mockDb.userDb = { getUserById: jest.fn().mockResolvedValue({ userId: 'test-user', isAdmin: false }) };
  mockDb.accountMemoryDb = { getRecentMemories: jest.fn().mockResolvedValue([]) };
}

function makeToolCallResponse(toolName = 'search_knowledge_base', callId = 'call_1') {
  return {
    choices: [{
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: callId, type: 'function', function: { name: toolName, arguments: '{}' } }],
      },
      finish_reason: 'tool_calls',
    }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function makeFinalResponse(text = 'Done.') {
  return {
    choices: [{ message: { role: 'assistant', content: text, tool_calls: null }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

describe('AgentModeService — scheduled-run Gemini iteration pacing (ENG-1670)', () => {
  let agentModeService: AgentModeService;

  beforeEach(() => {
    jest.clearAllMocks();
    agentModeService = new AgentModeService();
  });

  it('sleeps before the 2nd+ Gemini call on a scheduled run, not before the 1st', async () => {
    mockDeps(makeSession('scheduled'));
    const events: string[] = [];
    const PACING_MS = (AgentModeService as any).SCHEDULED_GEMINI_ITERATION_PACING_MS;

    let callCount = 0;
    jest.spyOn(agentModeService as any, 'callLLM').mockImplementation(async () => {
      callCount++;
      events.push('call');
      return callCount < 3 ? makeToolCallResponse() : makeFinalResponse();
    });
    jest.spyOn(agentModeService as any, 'executeTool').mockResolvedValue({ success: true });
    jest.spyOn(agentModeService as any, 'sleep').mockImplementation(async (...args: unknown[]) => {
      if (args[0] === PACING_MS) events.push('pace');
    });

    await agentModeService.generateMarketingResponse(
      'Run the pipeline', [], 'test-user', 'gemini-3.7-flash', 'test-session',
    );

    // At least the two scripted tool-call rounds happened, each preceded by
    // pacing except the very first call in the turn.
    expect(callCount).toBeGreaterThanOrEqual(3);
    expect(events[0]).toBe('call'); // no pacing before the turn's first call
    expect(events.filter((e) => e === 'pace').length).toBeGreaterThanOrEqual(2);
    // Every 'pace' must immediately precede a 'call' (paired, in order) — proves
    // the guard fires at the right point in the loop, not just "somewhere".
    for (let i = 0; i < events.length; i++) {
      if (events[i] === 'pace') expect(events[i + 1]).toBe('call');
    }
  });

  it('does NOT sleep before an interactive session\'s Gemini calls', async () => {
    mockDeps(makeSession('interactive'));
    let callCount = 0;
    jest.spyOn(agentModeService as any, 'callLLM').mockImplementation(async () => {
      callCount++;
      return callCount < 3 ? makeToolCallResponse() : makeFinalResponse();
    });
    jest.spyOn(agentModeService as any, 'executeTool').mockResolvedValue({ success: true });
    const sleepSpy = jest.spyOn(agentModeService as any, 'sleep').mockResolvedValue(undefined);

    await agentModeService.generateMarketingResponse(
      'Run the pipeline', [], 'test-user', 'gemini-3.7-flash', 'test-session',
    );

    const pacingSleeps = sleepSpy.mock.calls.filter(
      (call) => call[0] === (AgentModeService as any).SCHEDULED_GEMINI_ITERATION_PACING_MS
    );
    expect(pacingSleeps.length).toBe(0);
  });

  it('does NOT sleep for a non-Gemini model on a scheduled run', async () => {
    mockDeps(makeSession('scheduled'));
    let callCount = 0;
    jest.spyOn(agentModeService as any, 'callLLM').mockImplementation(async () => {
      callCount++;
      return callCount < 3 ? makeToolCallResponse() : makeFinalResponse();
    });
    jest.spyOn(agentModeService as any, 'executeTool').mockResolvedValue({ success: true });
    const sleepSpy = jest.spyOn(agentModeService as any, 'sleep').mockResolvedValue(undefined);

    await agentModeService.generateMarketingResponse(
      'Run the pipeline', [], 'test-user', 'gpt-5.5', 'test-session',
    );

    const pacingSleeps = sleepSpy.mock.calls.filter(
      (call) => call[0] === (AgentModeService as any).SCHEDULED_GEMINI_ITERATION_PACING_MS
    );
    expect(pacingSleeps.length).toBe(0);
  });

  it('does NOT sleep at all for a single-iteration scheduled Gemini turn (no tool calls)', async () => {
    mockDeps(makeSession('scheduled'));
    jest.spyOn(agentModeService as any, 'callLLM').mockResolvedValue(makeFinalResponse());
    const sleepSpy = jest.spyOn(agentModeService as any, 'sleep').mockResolvedValue(undefined);

    await agentModeService.generateMarketingResponse(
      'Quick question', [], 'test-user', 'gemini-3.7-flash', 'test-session',
    );

    const pacingSleeps = sleepSpy.mock.calls.filter(
      (call) => call[0] === (AgentModeService as any).SCHEDULED_GEMINI_ITERATION_PACING_MS
    );
    expect(pacingSleeps.length).toBe(0);
  });
});
