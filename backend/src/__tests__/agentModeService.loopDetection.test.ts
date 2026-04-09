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
    associatedSkills: null, // legacy session — no skill filtering
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

/** Minimal LLM response — no tool calls, loop exits immediately */
function makeLLMResponse(text = 'Done.') {
  return {
    choices: [
      {
        message: { role: 'assistant', content: text, tool_calls: null },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

describe('AgentModeService - Cross-message Loop Detection', () => {
  let agentModeService: AgentModeService;

  beforeEach(() => {
    jest.clearAllMocks();
    agentModeService = new AgentModeService();
  });

  it('does NOT inject anti-loop message when user sends a new (non-repeating) message', async () => {
    mockDeps();
    const callLLMSpy = jest
      .spyOn(agentModeService as any, 'callLLM')
      .mockResolvedValue(makeLLMResponse());

    const sessionHistory = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there!' },
      { role: 'user', content: 'What can you do?' },
    ];

    await agentModeService.generateMarketingResponse(
      'Tell me about GTM plans',
      sessionHistory as any,
      'test-user',
      agentModeService.default_model,
      'test-session'
    );

    const messagesArg = callLLMSpy.mock.calls[0][1] as any[];
    const antiLoopMsg = messagesArg.find(
      (m: any) => typeof m.content === 'string' && m.content.includes('ANTI-LOOP')
    );
    expect(antiLoopMsg).toBeUndefined();
  });

  it('does NOT inject anti-loop message when user repeats a message fewer than threshold times', async () => {
    mockDeps();
    const callLLMSpy = jest
      .spyOn(agentModeService as any, 'callLLM')
      .mockResolvedValue(makeLLMResponse());

    const repeatedMessage = 'Please perform the work on pending steps.';
    const sessionHistory = [
      { role: 'user', content: repeatedMessage },
      { role: 'assistant', content: 'I need your business name first.' },
      { role: 'user', content: repeatedMessage },
      { role: 'assistant', content: 'I still need your business name.' },
    ];

    await agentModeService.generateMarketingResponse(
      repeatedMessage, // 3rd occurrence total — threshold is 3 in HISTORY before current
      sessionHistory as any,
      'test-user',
      agentModeService.default_model,
      'test-session'
    );

    const messagesArg = callLLMSpy.mock.calls[0][1] as any[];
    const antiLoopMsg = messagesArg.find(
      (m: any) => typeof m.content === 'string' && m.content.includes('ANTI-LOOP')
    );
    // Only 2 identical messages in history (< threshold of 3), so no injection
    expect(antiLoopMsg).toBeUndefined();
  });

  it('injects anti-loop override when user repeats the same message 3+ times', async () => {
    mockDeps();
    const callLLMSpy = jest
      .spyOn(agentModeService as any, 'callLLM')
      .mockResolvedValue(makeLLMResponse());

    const repeatedMessage = 'Please perform the work on pending steps. After you are done, mark the steps as completed with set_work_plan_status.';
    const sessionHistory = [
      { role: 'user', content: repeatedMessage },
      { role: 'assistant', content: 'I need your business name first.' },
      { role: 'user', content: repeatedMessage },
      { role: 'assistant', content: 'Still need business name.' },
      { role: 'user', content: repeatedMessage },
      { role: 'assistant', content: 'Cannot proceed without your business name.' },
    ];

    await agentModeService.generateMarketingResponse(
      repeatedMessage, // 4th occurrence — 3 in history = triggers injection
      sessionHistory as any,
      'test-user',
      agentModeService.default_model,
      'test-session'
    );

    const messagesArg = callLLMSpy.mock.calls[0][1] as any[];
    const antiLoopMsg = messagesArg.find(
      (m: any) => typeof m.content === 'string' && m.content.includes('ANTI-LOOP')
    );
    expect(antiLoopMsg).toBeDefined();
    expect(antiLoopMsg.content).toContain('STOP asking');
    expect(antiLoopMsg.content).toContain('read_brand_guidelines');
    expect(antiLoopMsg.content).toContain('read_market_strategy');
  });

  it('loop detection is case-insensitive and whitespace-tolerant', async () => {
    mockDeps();
    const callLLMSpy = jest
      .spyOn(agentModeService as any, 'callLLM')
      .mockResolvedValue(makeLLMResponse());

    // Same message with different casing/whitespace
    const sessionHistory = [
      { role: 'user', content: '  Please proceed.  ' },
      { role: 'assistant', content: 'Need info.' },
      { role: 'user', content: 'Please proceed.' },
      { role: 'assistant', content: 'Still need info.' },
      { role: 'user', content: 'PLEASE PROCEED.' },
      { role: 'assistant', content: 'Still need info.' },
    ];

    await agentModeService.generateMarketingResponse(
      'please proceed.',
      sessionHistory as any,
      'test-user',
      agentModeService.default_model,
      'test-session'
    );

    const messagesArg = callLLMSpy.mock.calls[0][1] as any[];
    const antiLoopMsg = messagesArg.find(
      (m: any) => typeof m.content === 'string' && m.content.includes('ANTI-LOOP')
    );
    expect(antiLoopMsg).toBeDefined();
  });

  it('anti-loop message instructs Emma to use brand/market tools and proceed with defaults', async () => {
    mockDeps();
    const callLLMSpy = jest
      .spyOn(agentModeService as any, 'callLLM')
      .mockResolvedValue(makeLLMResponse());

    const msg = 'just do it';
    const sessionHistory = Array(3)
      .fill(null)
      .flatMap(() => [
        { role: 'user', content: msg },
        { role: 'assistant', content: 'I need more info.' },
      ]);

    await agentModeService.generateMarketingResponse(
      msg,
      sessionHistory as any,
      'test-user',
      agentModeService.default_model,
      'test-session'
    );

    const messagesArg = callLLMSpy.mock.calls[0][1] as any[];
    const antiLoopMsg = messagesArg.find(
      (m: any) => typeof m.content === 'string' && m.content.includes('ANTI-LOOP')
    );
    expect(antiLoopMsg).toBeDefined();
    expect(antiLoopMsg.content).toContain('reasonable generic placeholders');
    expect(antiLoopMsg.content).toContain('Never block on missing user-provided details');
  });
});
