/**
 * ENG-1134 / ENG-1430: quota charging belongs at the shared LLM-call boundary.
 * Persisting a message must never charge again, and the Emma sidebar must not
 * create a second provider client or meter beside AgentModeService.callLLM.
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
    promise: jest.fn().mockResolvedValue({ Location: 'https://s3.example.com/f.jpg' }),
  })),
  config: { update: jest.fn() },
}));

const mockCallLLM = jest.fn();
const mockGetDefaultModel = jest.fn().mockResolvedValue('gpt-5.4');
const mockAgentModeService = {
  callLLM: mockCallLLM,
  getDefaultModel: mockGetDefaultModel,
  executeTool: jest.fn(),
  initialize: jest.fn().mockResolvedValue(undefined),
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

const mockIncrementUserTokenUsage = jest.fn().mockResolvedValue(undefined);
jest.mock('../services/tokenUsageService', () => ({
  incrementUserTokenUsage: (...args: unknown[]) => mockIncrementUserTokenUsage(...args),
}));

const mockGetAzureClient = jest.fn();
jest.mock('../utils/llmClients', () => ({
  getAzureClient: (...args: unknown[]) => mockGetAzureClient(...(args as [])),
}));

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

import { chatbotDb, generateChatResponse, __resetEmmaSystemContextCache } from '../services/chatbotService';

function completion(content = 'Hi') {
  return {
    id: 'completion-1',
    choices: [{ message: { role: 'assistant', content, tool_calls: null } }],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 20,
      total_tokens: 30,
      cache_read_input_tokens: 5000,
      cache_creation_input_tokens: 700,
      cost: 0.00123,
    },
    model: 'openai/gpt-5.4',
  };
}

function seedSession() {
  getPromiseMock.mockResolvedValue({
    Item: {
      sessionId: 'sess-1',
      userId: 'user-1',
      portalType: 'customer',
      messages: [{ role: 'user', content: 'Hello' }],
      pageIdentifier: 'customer-portal',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    },
  });
  queryPromiseMock.mockResolvedValue({ Items: [] });
}

beforeEach(() => {
  jest.clearAllMocks();
  __resetEmmaSystemContextCache();
  putPromiseMock.mockResolvedValue({});
  updatePromiseMock.mockResolvedValue({});
  seedSession();
  mockGetDefaultModel.mockResolvedValue('gpt-5.4');
  mockCallLLM.mockResolvedValue(completion());
});

describe('ENG-1134: message persistence must not charge the quota counter', () => {
  const usageMessage = {
    role: 'assistant' as const,
    content: 'hello',
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30, estimated_cost: 0.74 },
  };

  it('does not charge the counter when a usage-carrying message is appended', async () => {
    await chatbotDb.addMessageToSession('sess-1', usageMessage as never);
    expect(mockIncrementUserTokenUsage).not.toHaveBeenCalled();
  });

  it('does not charge the counter for a batch append either', async () => {
    await chatbotDb.addMessagesToSession('sess-1', [
      usageMessage,
      { ...usageMessage, content: 'second' },
    ] as never);
    expect(mockIncrementUserTokenUsage).not.toHaveBeenCalled();
  });
});

describe('ENG-1430: Emma has one shared record-and-charge point', () => {
  it('delegates the billable turn and its attribution to callLLM exactly once', async () => {
    await generateChatResponse('sess-1', 'Hello', {
      portalType: 'customer',
      userId: 'user-1',
      model: 'gpt-5.4',
    });

    expect(mockCallLLM).toHaveBeenCalledTimes(1);
    expect(mockCallLLM).toHaveBeenCalledWith(
      'gpt-5.4',
      expect.any(Array),
      expect.objectContaining({
        taskClass: 'interactive_chat',
        usageContext: { userId: 'user-1', sessionId: 'sess-1', feature: 'chat' },
      }),
    );
  });

  it('does not instantiate an Azure chat client beside callLLM', async () => {
    await generateChatResponse('sess-1', 'Hello', {
      portalType: 'customer',
      userId: 'user-1',
      model: 'gpt-5.4',
    });

    expect(mockGetAzureClient).not.toHaveBeenCalled();
  });

  it('still delegates responses with no usage block; callLLM owns the fail-open meter', async () => {
    mockCallLLM.mockResolvedValue({
      id: 'completion-no-usage',
      choices: [{ message: { role: 'assistant', content: 'Hi', tool_calls: null } }],
      model: 'openai/gpt-5.4',
    });

    const result = await generateChatResponse('sess-1', 'Hello', {
      portalType: 'customer',
      userId: 'user-1',
      model: 'gpt-5.4',
    });

    expect(mockCallLLM).toHaveBeenCalledTimes(1);
    expect(typeof result === 'string' ? result : result.content).toBe('Hi');
  });
});
