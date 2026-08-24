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
    FOUNDATION_TOOLS: [],
    buildWorkPlanContextMessages: jest.fn().mockReturnValue([]),
  });
  return { AgentModeService, agentModeService: mockAgentModeService };
});

const mockResolveSkillsToToolNames = jest.fn();
jest.mock('../services/subscriptionService', () => ({
  resolveSkillsToToolNames: (...args: any[]) => mockResolveSkillsToToolNames(...args),
}));

const GOOGLE_ADS_TOOL = {
  definition: {
    name: 'list_connected_accounts',
    description: 'List connected ad accounts',
    inputSchema: { type: 'object', properties: {} },
  },
};

jest.mock('../mcp/server/registry', () => ({
  mcpToolRegistry: {
    getTool: (name: string) => (name === 'list_connected_accounts' ? GOOGLE_ADS_TOOL : undefined),
    getToolNames: () => ['list_connected_accounts'],
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
