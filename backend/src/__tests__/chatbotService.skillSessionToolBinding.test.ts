/**
 * ENG-1222: a session with skills installed (session.associatedSkills) must
 * always get its skill tools bound to the LLM call, regardless of which
 * portalType the request happened to arrive under. Before this fix,
 * generateChatResponse only resolved session skills into tool definitions
 * when portalType was 'customer'/'emma-sidebar' or the caller was a
 * delegated admin — a session reached via any other route (e.g. the
 * partner-portal's global chat widget, whose socket.emit('message') omits
 * `portal` and lands the request on the 'partner' default) got ZERO tools
 * bound. With no `tools` key sent to the model at all, it cannot call the
 * skill's tools and either denies having the capability or fabricates a
 * result in prose — this is the P0 bug in production sessions
 * bb89e75d-20da-4d44-879c-3b59c648bf22 and 0e5792fd-4982-4547-acf1-0a1c738cca59.
 */

const queryPromiseMock = jest.fn();
const getPromiseMock = jest.fn();
const putPromiseMock = jest.fn().mockResolvedValue({});
const updatePromiseMock = jest.fn().mockResolvedValue({});

jest.mock('aws-sdk', () => ({
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      query: jest.fn(() => ({ promise: queryPromiseMock })),
      get: jest.fn(() => ({ promise: getPromiseMock })),
      put: jest.fn(() => ({ promise: putPromiseMock })),
      update: jest.fn(() => ({ promise: updatePromiseMock })),
      batchWrite: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
    })),
  },
  S3: jest.fn(() => ({
    upload: jest.fn().mockReturnThis(),
    promise: jest.fn().mockResolvedValue({ Location: 'https://s3.example.com/file.jpg' }),
  })),
  config: { update: jest.fn() },
}));

const mockCallLLM = jest.fn();
const mockGetDefaultModel = jest.fn().mockResolvedValue('gpt-5.4');
const mockExecuteTool = jest.fn().mockResolvedValue({ success: true });
const mockInitialize = jest.fn().mockResolvedValue(undefined);
const mockGetAdminToolNames = jest.fn().mockReturnValue([]);
const mockAgentModeService = {
  callLLM: mockCallLLM,
  getDefaultModel: mockGetDefaultModel,
  executeTool: mockExecuteTool,
  initialize: mockInitialize,
  getAdminToolNames: mockGetAdminToolNames,
};

jest.mock('../services/agentModeService', () => {
  const AgentModeService = jest.fn().mockImplementation(() => mockAgentModeService);
  Object.assign(AgentModeService, {
    // 'send_notification' is a foundation-only tool never listed in any test
    // skill's own toolNames, so it distinguishes "came from FOUNDATION_TOOLS"
    // from "came from resolveSkillsToToolNames".
    FOUNDATION_TOOLS: ['send_notification'],
    buildWorkPlanContextMessages: jest.fn().mockReturnValue([]),
  });
  return { AgentModeService, agentModeService: mockAgentModeService };
});

const mockResolveSkillsToToolNames = jest.fn();
jest.mock('../services/subscriptionService', () => ({
  resolveSkillsToToolNames: (...args: any[]) => mockResolveSkillsToToolNames(...args),
}));

const mockGetPublishedSkills = jest.fn().mockResolvedValue([]);
jest.mock('../services/skillService', () => ({
  skillService: { getPublishedSkills: (...args: any[]) => mockGetPublishedSkills(...args) },
}));

const GOOGLE_ADS_TOOL = {
  definition: {
    name: 'list_connected_accounts',
    description: 'List connected ad accounts',
    inputSchema: { type: 'object', properties: {} },
  },
};

const NOTIFICATION_TOOL = {
  definition: {
    name: 'send_notification',
    description: 'Send a notification',
    inputSchema: { type: 'object', properties: {} },
  },
};

// Only reachable via the wildcard-expansion branch (mcpToolRegistry.getToolNames()),
// never via a skill's own resolved toolNames in these tests — lets a test observe
// whether wildcard expansion actually happened.
const WILDCARD_ONLY_TOOL = {
  definition: {
    name: 'wildcard_only_tool',
    description: 'Only reachable via full wildcard tool expansion',
    inputSchema: { type: 'object', properties: {} },
  },
};

jest.mock('../mcp/server/registry', () => ({
  mcpToolRegistry: {
    getTool: (name: string) => {
      if (name === 'list_connected_accounts') return GOOGLE_ADS_TOOL;
      if (name === 'send_notification') return NOTIFICATION_TOOL;
      if (name === 'wildcard_only_tool') return WILDCARD_ONLY_TOOL;
      return undefined;
    },
    getToolNames: () => ['list_connected_accounts', 'send_notification', 'wildcard_only_tool'],
  },
}));

jest.mock('../emma/registry', () => ({
  emmaToolRegistry: {
    getTool: () => undefined,
    getToolNames: () => [],
  },
}));

jest.mock('../emma/tools', () => ({}));
jest.mock('../emma/tempEmailTools', () => ({}));
jest.mock('../emma/testAccountTools', () => ({}));
jest.mock('../emma/localAgentTools', () => ({}));

jest.mock('openai', () => jest.fn());
jest.mock('@google-cloud/discoveryengine', () => ({
  EngineServiceClient: jest.fn(),
  SearchServiceClient: jest.fn(),
}));
jest.mock('@google-cloud/storage', () => ({ Storage: jest.fn() }));
jest.mock('../controllers/guide', () => ({ getGuide: jest.fn() }));
jest.mock('../controllers/release', () => ({ getReleases: jest.fn() }));
jest.mock('../controllers/docsController', () => ({ getUserReleaseNotes: jest.fn() }));
jest.mock('../services/db', () => ({ taskDb: {} }));
jest.mock('../utils/secretsManager', () => ({
  getGCSPPrivateKey: jest.fn(),
  getSecret: jest.fn().mockResolvedValue('fake-key'),
}));
jest.mock('../utils/s3Utils', () => ({
  uploadFileToS3: jest.fn().mockResolvedValue({ success: false }),
}));

import { generateChatResponse, __resetEmmaSystemContextCache, chatbotDb } from '../services/chatbotService';
import { mcpToolRegistry } from '../mcp/server/registry';

function makeCompletion(content = 'Hello') {
  return {
    id: 'completion-1',
    choices: [{ message: { role: 'assistant', content, tool_calls: null } }],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    model: 'anthropic.claude-opus-5',
  };
}

function makeToolCallCompletion(toolName: string, args: object = {}) {
  return {
    id: 'completion-tool',
    choices: [{
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call-1', type: 'function', function: { name: toolName, arguments: JSON.stringify(args) } }],
      },
    }],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    model: 'anthropic.claude-opus-5',
  };
}

function seedSession(overrides: Record<string, any> = {}) {
  getPromiseMock.mockResolvedValue({
    Item: {
      sessionId: 'sess-1',
      userId: 'user-1',
      portalType: 'agent',
      messages: [{ role: 'user', content: 'Run list_connected_accounts' }],
      pageIdentifier: 'skill-google-ads-discovery',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
      ...overrides,
    },
  });
  queryPromiseMock.mockResolvedValue({ Items: [] });
}

describe('generateChatResponse — skill-session tool binding (ENG-1222)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // clearAllMocks() resets call history but NOT a mock's queued
    // mockResolvedValueOnce() chain — a prior test that queued more once-values
    // than it consumed would otherwise leak the leftover into this test's first
    // mockCallLLM() call. Reset it explicitly, then re-establish this block's default.
    mockCallLLM.mockReset();
    __resetEmmaSystemContextCache();
    putPromiseMock.mockResolvedValue({});
    updatePromiseMock.mockResolvedValue({});
    mockGetDefaultModel.mockResolvedValue('gpt-5.4');
    mockCallLLM.mockResolvedValue(makeCompletion());
    mockResolveSkillsToToolNames.mockResolvedValue(['list_connected_accounts']);
  });

  it('binds the session skill tools even when portalType is "partner" and the caller is not an admin', async () => {
    seedSession({ associatedSkills: ['google-ads-skill'] });

    await generateChatResponse('sess-1', 'Run list_connected_accounts', {
      portalType: 'partner',
      userId: 'user-1',
      model: 'anthropic.claude-opus-5',
    });

    expect(mockCallLLM).toHaveBeenCalledWith(
      'anthropic.claude-opus-5',
      expect.any(Array),
      expect.objectContaining({
        tools: expect.arrayContaining([
          expect.objectContaining({ function: expect.objectContaining({ name: 'list_connected_accounts' }) }),
        ]),
      }),
    );
  });

  it('omits tools for a "partner" session with no installed skills (no regression)', async () => {
    seedSession({ associatedSkills: [] });

    await generateChatResponse('sess-1', 'Hello', {
      portalType: 'partner',
      userId: 'user-1',
      model: 'anthropic.claude-opus-5',
    });

    expect(mockCallLLM).toHaveBeenCalledWith(
      'anthropic.claude-opus-5',
      expect.any(Array),
      expect.not.objectContaining({ tools: expect.anything() }),
    );
  });

  it('still binds skill tools on the "customer" portal (existing behavior preserved)', async () => {
    seedSession({ associatedSkills: ['google-ads-skill'] });

    await generateChatResponse('sess-1', 'Run list_connected_accounts', {
      portalType: 'customer',
      userId: 'user-1',
      model: 'anthropic.claude-opus-5',
    });

    expect(mockCallLLM).toHaveBeenCalledWith(
      'anthropic.claude-opus-5',
      expect.any(Array),
      expect.objectContaining({
        tools: expect.arrayContaining([
          expect.objectContaining({ function: expect.objectContaining({ name: 'list_connected_accounts' }) }),
        ]),
      }),
    );
  });

  it('still binds admin tools for a delegated admin with no installed skills (existing behavior preserved)', async () => {
    seedSession({ associatedSkills: [] });
    mockGetAdminToolNames.mockReturnValue(['list_connected_accounts']);

    await generateChatResponse('sess-1', 'Hello', {
      portalType: 'partner',
      userId: 'user-1',
      model: 'anthropic.claude-opus-5',
      isDelegatedAdmin: true,
    });

    expect(mockCallLLM).toHaveBeenCalledWith(
      'anthropic.claude-opus-5',
      expect.any(Array),
      expect.objectContaining({
        tools: expect.arrayContaining([
          expect.objectContaining({ function: expect.objectContaining({ name: 'list_connected_accounts' }) }),
        ]),
      }),
    );
  });
});

describe('generateChatResponse — ENG-1222 attribution stamp + fabrication guard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // See the first describe block's beforeEach for why this is necessary:
    // clearAllMocks() doesn't drain a mock's queued mockResolvedValueOnce() chain.
    mockCallLLM.mockReset();
    __resetEmmaSystemContextCache();
    putPromiseMock.mockResolvedValue({});
    updatePromiseMock.mockResolvedValue({});
    mockGetDefaultModel.mockResolvedValue('gpt-5.4');
    mockResolveSkillsToToolNames.mockResolvedValue(['list_connected_accounts']);
  });

  it('stamps .llm on the persisted assistant message so telemetry can attribute the turn', async () => {
    seedSession({ associatedSkills: [] });
    mockCallLLM.mockResolvedValue(makeCompletion('Hi there!'));
    const addMessageSpy = jest.spyOn(chatbotDb, 'addMessageToSession');

    await generateChatResponse('sess-1', 'Hello', {
      portalType: 'partner',
      userId: 'user-1',
      model: 'anthropic.claude-opus-5',
    });

    expect(addMessageSpy).toHaveBeenCalledWith(
      'sess-1',
      expect.objectContaining({ role: 'assistant', llm: 'anthropic.claude-opus-5' }),
    );
  });

  it('blocks a zero-tool-call response that claims to present actual/real tool-derived data', async () => {
    seedSession({ associatedSkills: [] });
    mockCallLLM.mockResolvedValue(makeCompletion(
      'Here are the actual returned rows: Acme Widgets Main, customer ID 123-456-7890.'
    ));
    const addMessageSpy = jest.spyOn(chatbotDb, 'addMessageToSession');

    const response = await generateChatResponse('sess-1', 'Report the ACTUAL returned rows', {
      portalType: 'partner',
      userId: 'user-1',
      model: 'anthropic.claude-opus-5',
    });

    expect(response).not.toMatch(/Acme Widgets Main/);
    expect(addMessageSpy).toHaveBeenCalledWith(
      'sess-1',
      expect.objectContaining({
        role: 'assistant',
        content: expect.not.stringContaining('Acme Widgets Main'),
      }),
    );
  });

  it('does not block a normal zero-tool-call reply that makes no real-data claim', async () => {
    seedSession({ associatedSkills: [] });
    mockCallLLM.mockResolvedValue(makeCompletion('Sure, I can help with that — what would you like to do?'));

    const response = await generateChatResponse('sess-1', 'Hello', {
      portalType: 'partner',
      userId: 'user-1',
      model: 'anthropic.claude-opus-5',
    });

    expect(response).toBe('Sure, I can help with that — what would you like to do?');
  });

  it('does not block a response that reports real data after actually calling a tool', async () => {
    seedSession({ associatedSkills: ['google-ads-skill'] });
    mockExecuteTool.mockResolvedValue({ accounts: [{ name: 'Real Customer LLC', id: '999' }] });
    mockCallLLM
      .mockResolvedValueOnce(makeToolCallCompletion('list_connected_accounts'))
      .mockResolvedValueOnce(makeCompletion('Here are the actual returned rows: Real Customer LLC, ID 999.'));

    const response = await generateChatResponse('sess-1', 'Run list_connected_accounts', {
      portalType: 'partner',
      userId: 'user-1',
      model: 'anthropic.claude-opus-5',
    });

    const content = typeof response === 'string' ? response : response.content;
    expect(content).toContain('Real Customer LLC');
  });
});

describe('generateChatResponse — ENG-1222 hard gate, retry, skill prompt, and foundation-tool parity', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // See the first describe block's beforeEach for why this is necessary:
    // clearAllMocks() doesn't drain a mock's queued mockResolvedValueOnce() chain.
    mockCallLLM.mockReset();
    __resetEmmaSystemContextCache();
    putPromiseMock.mockResolvedValue({});
    updatePromiseMock.mockResolvedValue({});
    mockGetDefaultModel.mockResolvedValue('gpt-5.4');
    mockGetPublishedSkills.mockResolvedValue([]);
  });

  it('hard-fails a skill session that resolves to zero tools instead of letting the model answer toolless', async () => {
    seedSession({ associatedSkills: ['google-ads-skill'] });
    mockResolveSkillsToToolNames.mockResolvedValue(['unregistered_tool']);
    // Even FOUNDATION_TOOLS (send_notification) must fail to resolve here — otherwise
    // the ENG-1222 parity fix means a skill session almost never truly hits zero tools.
    const getToolSpy = jest.spyOn(mcpToolRegistry, 'getTool').mockReturnValue(undefined);

    const response = await generateChatResponse('sess-1', 'Run list_connected_accounts', {
      portalType: 'partner',
      userId: 'user-1',
      model: 'anthropic.claude-opus-5',
    });

    expect(mockCallLLM).not.toHaveBeenCalled();
    expect(response).toMatch(/wasn't able to load the tools/i);
    getToolSpy.mockRestore();
  });

  it('retries once when the user names an available tool but the model makes zero tool calls', async () => {
    seedSession({ associatedSkills: ['google-ads-skill'] });
    mockResolveSkillsToToolNames.mockResolvedValue(['list_connected_accounts']);
    mockExecuteTool.mockResolvedValue({ accounts: [{ name: 'Real Customer LLC', id: '999' }] });
    mockCallLLM
      .mockResolvedValueOnce(makeCompletion("I don't have the capability to run tools."))
      .mockResolvedValueOnce(makeToolCallCompletion('list_connected_accounts'))
      .mockResolvedValueOnce(makeCompletion('Here are the actual returned rows: Real Customer LLC, ID 999.'));

    const response = await generateChatResponse('sess-1', 'Call list_connected_accounts for google_ads', {
      portalType: 'partner',
      userId: 'user-1',
      model: 'anthropic.claude-opus-5',
    });

    expect(mockCallLLM).toHaveBeenCalledTimes(3);
    expect(mockExecuteTool).toHaveBeenCalledWith(
      'anthropic.claude-opus-5', 'list_connected_accounts', expect.anything(), 'user-1', 'sess-1', false, undefined,
    );
    const content = typeof response === 'string' ? response : response.content;
    expect(content).toContain('Real Customer LLC');
  });

  it('does not retry a normal toolless reply when the user never named an available tool', async () => {
    seedSession({ associatedSkills: ['google-ads-skill'] });
    mockResolveSkillsToToolNames.mockResolvedValue(['list_connected_accounts']);
    mockCallLLM.mockResolvedValue(makeCompletion('Sure, what would you like to do?'));

    await generateChatResponse('sess-1', 'Hello there', {
      portalType: 'partner',
      userId: 'user-1',
      model: 'anthropic.claude-opus-5',
    });

    expect(mockCallLLM).toHaveBeenCalledTimes(1);
  });

  it('injects the installed skill\'s own systemPrompt even on the non-customer portal', async () => {
    seedSession({ associatedSkills: ['google-ads-skill'] });
    mockResolveSkillsToToolNames.mockResolvedValue(['list_connected_accounts']);
    mockGetPublishedSkills.mockResolvedValue([
      { skillId: 'google-ads-skill', systemPrompt: 'You are running the Google Ads Pre-Flight Health Gate skill.' },
    ]);
    mockCallLLM.mockResolvedValue(makeCompletion('ok'));

    await generateChatResponse('sess-1', 'Hello', {
      portalType: 'partner',
      userId: 'user-1',
      model: 'anthropic.claude-opus-5',
    });

    expect(mockCallLLM).toHaveBeenCalledWith(
      'anthropic.claude-opus-5',
      expect.arrayContaining([
        expect.objectContaining({ role: 'system', content: expect.stringContaining('Pre-Flight Health Gate') }),
      ]),
      expect.anything(),
    );
  });

  it('unions FOUNDATION_TOOLS onto a skill session even when the skill itself does not redeclare them', async () => {
    seedSession({ associatedSkills: ['google-ads-skill'] });
    // The skill only declares list_connected_accounts — not the foundation-only send_notification tool.
    mockResolveSkillsToToolNames.mockResolvedValue(['list_connected_accounts']);
    mockCallLLM.mockResolvedValue(makeCompletion('ok'));

    await generateChatResponse('sess-1', 'Hello', {
      portalType: 'partner',
      userId: 'user-1',
      model: 'anthropic.claude-opus-5',
    });

    expect(mockCallLLM).toHaveBeenCalledWith(
      'anthropic.claude-opus-5',
      expect.any(Array),
      expect.objectContaining({
        tools: expect.arrayContaining([
          expect.objectContaining({ function: expect.objectContaining({ name: 'list_connected_accounts' }) }),
          expect.objectContaining({ function: expect.objectContaining({ name: 'send_notification' }) }),
        ]),
      }),
    );
  });

  it('does not expand to every registered tool when resolveSkillsToToolNames silently fails open to a wildcard', async () => {
    seedSession({ associatedSkills: ['google-ads-skill'] }); // no '*' — never asked for wildcard access
    // subscriptionService.ts's own catch fails open to ['*'] on any internal error —
    // indistinguishable at this call site from a legitimate wildcard request.
    mockResolveSkillsToToolNames.mockResolvedValue(['*']);
    mockCallLLM.mockResolvedValue(makeCompletion('ok'));

    await generateChatResponse('sess-1', 'Hello', {
      portalType: 'partner',
      userId: 'user-1',
      model: 'anthropic.claude-opus-5',
    });

    expect(mockCallLLM).toHaveBeenCalledWith(
      'anthropic.claude-opus-5',
      expect.any(Array),
      expect.objectContaining({
        tools: expect.not.arrayContaining([
          expect.objectContaining({ function: expect.objectContaining({ name: 'wildcard_only_tool' }) }),
        ]),
      }),
    );
  });

  it('does expand to every registered tool when the session itself explicitly has wildcard skill access', async () => {
    seedSession({ associatedSkills: ['*'] });
    mockResolveSkillsToToolNames.mockResolvedValue(['*']);
    mockCallLLM.mockResolvedValue(makeCompletion('ok'));

    await generateChatResponse('sess-1', 'Hello', {
      portalType: 'partner',
      userId: 'user-1',
      model: 'anthropic.claude-opus-5',
    });

    expect(mockCallLLM).toHaveBeenCalledWith(
      'anthropic.claude-opus-5',
      expect.any(Array),
      expect.objectContaining({
        tools: expect.arrayContaining([
          expect.objectContaining({ function: expect.objectContaining({ name: 'wildcard_only_tool' }) }),
        ]),
      }),
    );
  });
});
