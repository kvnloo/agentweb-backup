/**
 * ENG-1430: Emma sidebar routing belongs to the shared AgentModeService.callLLM
 * boundary. The sidebar must preserve logical model identity and conversation /
 * tool behavior without selecting a naked provider client of its own.
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
const mockAgentModeService = {
  callLLM: mockCallLLM,
  getDefaultModel: mockGetDefaultModel,
  executeTool: mockExecuteTool,
  initialize: mockInitialize,
  getAdminToolNames: jest.fn().mockReturnValue([]),
};

jest.mock('../services/agentModeService', () => {
  const AgentModeService = jest.fn().mockImplementation(() => mockAgentModeService);
  Object.assign(AgentModeService, {
    FOUNDATION_TOOLS: [],
    buildWorkPlanContextMessages: jest.fn().mockReturnValue([]),
  });
  return { AgentModeService, agentModeService: mockAgentModeService };
});

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

import { generateChatResponse, __resetEmmaSystemContextCache } from '../services/chatbotService';

function makeCompletion(content = 'Hello', model = 'openrouter/upstream-model') {
  return {
    id: 'completion-1',
    choices: [{ message: { role: 'assistant', content, tool_calls: null } }],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    model,
  };
}

function seedSession(llmModel?: string) {
  getPromiseMock.mockResolvedValue({
    Item: {
      sessionId: 'sess-1',
      userId: 'user-1',
      portalType: 'customer',
      messages: [{ role: 'user', content: 'Hello' }],
      pageIdentifier: 'customer-portal',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
      ...(llmModel ? { llmModel } : {}),
    },
  });
  queryPromiseMock.mockResolvedValue({ Items: [] });
}

describe('generateChatResponse — shared interactive gateway', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetEmmaSystemContextCache();
    putPromiseMock.mockResolvedValue({});
    updatePromiseMock.mockResolvedValue({});
    mockGetDefaultModel.mockResolvedValue('gpt-5.4');
    mockCallLLM.mockResolvedValue(makeCompletion());
  });

  it.each([
    'gpt-5.4',
    'gemini-3.1-flash-lite',
    'anthropic.claude-sonnet-4-6',
    'openrouter/deepseek/deepseek-v4-flash',
  ])('routes logical model %s through callLLM with interactive attribution', async (logicalModel) => {
    seedSession();

    await generateChatResponse('sess-1', 'Hello', {
      portalType: 'customer',
      userId: 'user-1',
      model: logicalModel,
    });

    expect(mockCallLLM).toHaveBeenCalledTimes(1);
    expect(mockCallLLM).toHaveBeenCalledWith(
      logicalModel,
      expect.any(Array),
      expect.objectContaining({
        taskClass: 'interactive_chat',
        humanPaced: true,
        usageContext: { userId: 'user-1', sessionId: 'sess-1', feature: 'chat' },
      }),
    );
  });

  it('returns the shared completion content unchanged', async () => {
    seedSession();
    mockCallLLM.mockResolvedValue(makeCompletion('Gateway says hi'));

    const result = await generateChatResponse('sess-1', 'Hello', {
      portalType: 'customer',
      userId: 'user-1',
      model: 'gpt-5.4',
    });

    expect(typeof result === 'string' ? result : result.content).toBe('Gateway says hi');
  });

  it('does not include the legacy partner portal in the Emma canary', async () => {
    seedSession();

    await generateChatResponse('sess-1', 'Hello', {
      portalType: 'partner',
      userId: 'user-1',
      model: 'gpt-5.4',
    });

    expect(mockCallLLM).toHaveBeenCalledWith(
      'gpt-5.4',
      expect.any(Array),
      expect.not.objectContaining({ taskClass: 'interactive_chat' }),
    );
  });

  it('uses the persisted session model before the system default', async () => {
    seedSession('gemini-3.7-flash');

    await generateChatResponse('sess-1', 'Hello', {
      portalType: 'customer',
      userId: 'user-1',
    });

    expect(mockCallLLM).toHaveBeenCalledWith('gemini-3.7-flash', expect.any(Array), expect.any(Object));
    expect(mockGetDefaultModel).not.toHaveBeenCalled();
  });

  it('uses the shared system default when neither request nor session selects a model', async () => {
    seedSession();
    mockGetDefaultModel.mockResolvedValue('anthropic.claude-sonnet-5');

    await generateChatResponse('sess-1', 'Hello', {
      portalType: 'customer',
      userId: 'user-1',
    });

    expect(mockCallLLM).toHaveBeenCalledWith(
      'anthropic.claude-sonnet-5',
      expect.any(Array),
      expect.any(Object),
    );
  });

  it('keeps logical model identity when an OpenRouter response requests a tool', async () => {
    seedSession();
    mockCallLLM
      .mockResolvedValueOnce({
        ...makeCompletion('', 'openai/gpt-5.4'),
        choices: [{
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{
              id: 'tool-1',
              function: { name: 'search_user_guide', arguments: '{}' },
            }],
          },
        }],
      })
      .mockResolvedValueOnce(makeCompletion('Done', 'openai/gpt-5.4'));

    await generateChatResponse('sess-1', 'Help', {
      portalType: 'customer',
      userId: 'user-1',
      model: 'gpt-5.4',
    });

    expect(mockExecuteTool).toHaveBeenCalledWith(
      'gpt-5.4',
      'search_user_guide',
      {},
      'user-1',
      'sess-1',
      false,
      undefined,
    );
    expect(mockCallLLM).toHaveBeenCalledTimes(2);
  });

  it('propagates a rejected shared-gateway request', async () => {
    seedSession();
    mockCallLLM.mockRejectedValueOnce(new Error('gateway unavailable'));

    await expect(generateChatResponse('sess-1', 'Hello', {
      portalType: 'customer',
      userId: 'user-1',
      model: 'gpt-5.4',
    })).rejects.toThrow('gateway unavailable');
  });

  it('rejects a shared completion with no assistant message', async () => {
    seedSession();
    mockCallLLM.mockResolvedValueOnce({
      ...makeCompletion(),
      choices: [],
    });

    await expect(generateChatResponse('sess-1', 'Hello', {
      portalType: 'customer',
      userId: 'user-1',
      model: 'gpt-5.4',
    })).rejects.toThrow('No response from LLM');
  });

  it('records a failed tool call and continues through the shared gateway', async () => {
    seedSession();
    mockCallLLM
      .mockResolvedValueOnce({
        ...makeCompletion('', 'openai/gpt-5.4'),
        choices: [{
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{
              id: 'tool-1',
              function: { name: 'search_user_guide', arguments: '{}' },
            }],
          },
        }],
      })
      .mockResolvedValueOnce(makeCompletion('Recovered', 'openai/gpt-5.4'));
    mockExecuteTool.mockRejectedValueOnce(new Error('tool unavailable'));

    const result = await generateChatResponse('sess-1', 'Help', {
      portalType: 'customer',
      userId: 'user-1',
      model: 'gpt-5.4',
    });

    expect(typeof result === 'string' ? result : result.content).toBe('Recovered');
    expect(typeof result === 'string' ? [] : result.toolCalls).toEqual([
      expect.objectContaining({ id: 'tool-1', error: 'tool unavailable' }),
    ]);
    expect(mockCallLLM).toHaveBeenCalledTimes(2);
  });

  it('prices upstream gateway responses with the logical model', async () => {
    seedSession();
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      await generateChatResponse('sess-1', 'Hello', {
        portalType: 'customer',
        userId: 'user-1',
        model: 'gpt-5.4',
      });

      expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(
        /\[Token Usage\] Model: gpt-5\.4 .* Cost: \$[0-9]/,
      ));
    } finally {
      logSpy.mockRestore();
    }
  });
});
