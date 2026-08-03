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

  it('injects the anti-loop directive as a system message, never as a user turn (ENG-763)', async () => {
    // The directive used to be pushed with role:'user'. On Gemini consecutive user
    // parts are merged, so the model read the system-authored "[SYSTEM OVERRIDE]" text
    // as the user's own words and quoted it back — hallucinating that the user sent it.
    mockDeps();
    const callLLMSpy = jest
      .spyOn(agentModeService as any, 'callLLM')
      .mockResolvedValue(makeLLMResponse());

    const repeatedMessage = 'qa exactly once check';
    const sessionHistory = [
      { role: 'user', content: repeatedMessage },
      { role: 'assistant', content: 'I need a target first.' },
      { role: 'user', content: repeatedMessage },
      { role: 'assistant', content: 'Still need a target.' },
      { role: 'user', content: repeatedMessage },
      { role: 'assistant', content: 'Cannot proceed without a target.' },
    ];

    await agentModeService.generateMarketingResponse(
      repeatedMessage,
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
    // Must not be attributable to the user.
    expect(antiLoopMsg.role).toBe('system');
    // Must not leak the "[SYSTEM OVERRIDE]" phrasing the model was echoing back.
    expect(antiLoopMsg.content).not.toMatch(/SYSTEM OVERRIDE/i);
    // No user-role message may carry the internal directive text.
    const userCarryingDirective = messagesArg.find(
      (m: any) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('ANTI-LOOP')
    );
    expect(userCarryingDirective).toBeUndefined();
    // Explicitly instructs the model not to attribute the directive to the user.
    expect(antiLoopMsg.content.toLowerCase()).toContain('attribute');
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

describe('AgentModeService - Sliding-Window Tool Call Loop Detection', () => {
  let agentModeService: AgentModeService;

  beforeEach(() => {
    jest.clearAllMocks();
    agentModeService = new AgentModeService();
  });

  function makeToolCallResponse(toolName: string, args: string = '{}', callId = 'call_1') {
    return {
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: callId, type: 'function', function: { name: toolName, arguments: args } }],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };
  }

  it('injects cycling anti-loop warning when alternating tool calls repeat 3+ times in 10-step window', async () => {
    mockDeps();

    // Alternate between two different tool signatures 5 times each = 10 iterations
    // Neither pair is "consecutive" but each repeats >= 3x in the window
    let callCount = 0;
    const callLLMSpy = jest.spyOn(agentModeService as any, 'callLLM').mockImplementation(async () => {
      callCount++;
      if (callCount <= 10) {
        const toolName = callCount % 2 === 0
          ? 'mcp__playwright__browser_take_screenshot'
          : 'mcp__playwright__browser_navigate';
        return makeToolCallResponse(toolName, callCount % 2 === 0 ? '{}' : '{"url":"https://example.com"}');
      }
      return makeLLMResponse('Done.');
    });

    jest.spyOn(agentModeService as any, 'executeTool').mockResolvedValue({ success: true });

    await agentModeService.generateMarketingResponse(
      'Analyze this page',
      [],
      'test-user',
      agentModeService.default_model,
      'test-session'
    );

    // The cycling warning should have been injected into one of the later LLM calls
    const allMessages = callLLMSpy.mock.calls.flatMap((call) => call[1] as any[]);
    const cyclingWarning = allMessages.find(
      (m: any) => typeof m.content === 'string' && m.content.includes('stuck in a loop')
    );
    expect(cyclingWarning).toBeDefined();
    expect(cyclingWarning.content).toContain('Do not navigate or take screenshots again');
  });

  it('does NOT inject cycling warning when tool calls are varied and non-repeating', async () => {
    mockDeps();

    const tools = ['tool_a', 'tool_b', 'tool_c', 'tool_d', 'tool_e', 'tool_f', 'tool_g', 'tool_h', 'tool_i'];
    let callCount = 0;
    const callLLMSpy = jest.spyOn(agentModeService as any, 'callLLM').mockImplementation(async () => {
      if (callCount < tools.length) {
        return makeToolCallResponse(tools[callCount++]);
      }
      return makeLLMResponse('Done.');
    });

    jest.spyOn(agentModeService as any, 'executeTool').mockResolvedValue({ success: true });

    await agentModeService.generateMarketingResponse(
      'Do many different things',
      [],
      'test-user',
      agentModeService.default_model,
      'test-session'
    );

    const allMessages = callLLMSpy.mock.calls.flatMap((call) => call[1] as any[]);
    const cyclingWarning = allMessages.find(
      (m: any) => typeof m.content === 'string' && m.content.includes('stuck in a loop')
    );
    expect(cyclingWarning).toBeUndefined();
  });

  it('resets sliding window after injecting warning so it only injects once per cycle', async () => {
    mockDeps();

    // Fill a full window with alternating calls (10 steps), then 5 more alternating steps.
    // The warning fires at step 10, window resets. Steps 11-15 don't yet fill a new window.
    let callCount = 0;
    jest.spyOn(agentModeService as any, 'callLLM').mockImplementation(async () => {
      callCount++;
      if (callCount <= 15) {
        const toolName = callCount % 2 === 0
          ? 'mcp__playwright__browser_take_screenshot'
          : 'mcp__playwright__browser_navigate';
        return makeToolCallResponse(toolName, callCount % 2 === 0 ? '{}' : '{"url":"https://example.com"}');
      }
      return makeLLMResponse('Done.');
    });

    jest.spyOn(agentModeService as any, 'executeTool').mockResolvedValue({ success: true });

    const warningInjections: number[] = [];
    const origConsoleWarn = console.warn;
    console.warn = (...args: any[]) => {
      if (typeof args[0] === 'string' && args[0].includes('cycling tool call pattern')) {
        warningInjections.push(callCount);
      }
      origConsoleWarn(...args);
    };

    try {
      await agentModeService.generateMarketingResponse(
        'Analyze this page',
        [],
        'test-user',
        agentModeService.default_model,
        'test-session'
      );
    } finally {
      console.warn = origConsoleWarn;
    }

    // Warning fires once (at step 10), window resets, no second warning in steps 11-15
    expect(warningInjections.length).toBe(1);
  });
});
