/**
 * ENG-1134: agent-mode turns were charged to the per-user quota counter TWICE.
 *
 * `agentModeService.callLLM` meters at the LLM call (ledger row + counter charge,
 * counting input + output + cache tokens). The assistant message is then persisted
 * through `chatbotDb.addMessageToSession` / `addMessagesToSession`, which charged
 * `incrementUserTokenUsage` a SECOND time from `message.usage.estimated_cost`.
 *
 * Measured in dev against a single ledger row: cost exactly 2.000x, tokens 1.034x.
 * The token ratio stayed near 1 because `usage.total_tokens` carries only
 * prompt+completion while the real charge includes cache tokens (~73% of traffic) —
 * which is precisely why the double charge hid for three weeks.
 *
 * The persist-time charge is the wrong charging point regardless of the double:
 * it writes no ledger row, so it breaks ENG-200's rule that nothing is deducted
 * without also being recorded, and it under-counts tokens by excluding cache.
 * Charging belongs at the LLM call site, which records and charges together.
 *
 * Removing it alone would open a hole: Emma reaches Claude via
 * `agentModeService.getBedrockClient()` and Gemini via `getGeminiClient()`, and
 * NEITHER of those clients meters — only `callLLM` does, and Emma does not go
 * through it. So those two call sites must start metering as the charge moves off
 * the persist path. Azure must NOT, because its factory client already meters —
 * metering it here would recreate the very double-charge this fixes.
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

const mockBedrockCreate = jest.fn();
const mockGeminiCreate = jest.fn();
const mockGetBedrockClient = jest.fn().mockResolvedValue({
  chat: { completions: { create: mockBedrockCreate } },
});
const mockGetGeminiClient = jest.fn().mockResolvedValue({
  chat: { completions: { create: mockGeminiCreate } },
});

jest.mock('../services/agentModeService', () => ({
  AgentModeService: jest.fn().mockImplementation(() => ({
    getBedrockClient: mockGetBedrockClient,
    getGeminiClient: mockGetGeminiClient,
    executeTool: jest.fn(),
  })),
  agentModeService: {
    getBedrockClient: mockGetBedrockClient,
    getGeminiClient: mockGetGeminiClient,
    executeTool: jest.fn(),
  },
}));

const mockIncrementUserTokenUsage = jest.fn().mockResolvedValue(undefined);
jest.mock('../services/tokenUsageService', () => ({
  incrementUserTokenUsage: (...args: unknown[]) => mockIncrementUserTokenUsage(...args),
}));

const mockGetAzureClient = jest.fn(() => ({
  chat: { completions: { create: jest.fn() } },
}));
jest.mock('../utils/llmClients', () => ({
  getAzureClient: (...args: unknown[]) => mockGetAzureClient(...(args as [])),
}));

const mockMeterUserUsage = jest.fn();
jest.mock('../services/usageRecorderService', () => ({
  // Keep the real module — chatbotService also imports computeCostMicroUsd from
  // here for calculateCost. Only the meter is stubbed.
  ...jest.requireActual('../services/usageRecorderService'),
  meterUserUsage: (...args: unknown[]) => mockMeterUserUsage(...args),
}));

jest.mock('openai', () => jest.fn().mockImplementation(() => ({
  chat: { completions: { create: jest.fn() } },
})));
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
    choices: [{ message: { role: 'assistant', content, tool_calls: null } }],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 20,
      total_tokens: 30,
      // Bedrock Converse answers in OpenAI shape but carries Anthropic-style
      // cache fields. normalizeOpenAIUsage does NOT read these, which is why the
      // meter reads them explicitly.
      cache_read_input_tokens: 5000,
      cache_creation_input_tokens: 700,
    },
    model: 'test-model',
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
});

describe('ENG-1134: message persistence must not charge the quota counter', () => {
  const usageMessage = {
    role: 'assistant' as const,
    content: 'hello',
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30, estimated_cost: 0.74 },
  };

  it('does not charge the counter when a usage-carrying message is appended', async () => {
    // The LLM call site already charged this exact spend AND wrote the ledger row.
    // Charging again here is the 2.000x double.
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

describe('ENG-1134: Emma meters its own un-metered clients exactly once', () => {
  it('meters the Bedrock path, which no client wrapper covers', async () => {
    mockBedrockCreate.mockResolvedValue(completion());

    await generateChatResponse('sess-1', 'Hello', {
      portalType: 'customer',
      userId: 'user-1',
      model: 'anthropic.claude-sonnet-4-6',
    } as never);

    expect(mockMeterUserUsage).toHaveBeenCalledTimes(1);
    const [ctx] = mockMeterUserUsage.mock.calls[0];
    expect(ctx).toMatchObject({ userId: 'user-1', feature: 'chat', provider: 'bedrock' });
    // The regression this guards: routing through meterUsageFromResponse would
    // take normalizeOpenAIUsage and record both of these as 0, under-counting
    // Bedrock spend by ~4x since cache is the bulk of the traffic.
    expect(ctx).toMatchObject({ cacheReadTokens: 5000, cacheWriteTokens: 700 });
  });

  it('meters the Gemini path, which no client wrapper covers', async () => {
    mockGeminiCreate.mockResolvedValue(completion());

    await generateChatResponse('sess-1', 'Hello', {
      portalType: 'customer',
      userId: 'user-1',
      model: 'gemini-2.5-flash',
    } as never);

    expect(mockMeterUserUsage).toHaveBeenCalledTimes(1);
    const [ctx] = mockMeterUserUsage.mock.calls[0];
    expect(ctx).toMatchObject({ userId: 'user-1', feature: 'chat', provider: 'gemini' });
  });

  it('does NOT meter the Azure path, whose factory client already meters', async () => {
    // Metering here would recreate exactly the double-charge this ticket fixes.
    const azureCreate = jest.fn().mockResolvedValue(completion());
    mockGetAzureClient.mockReturnValue({ chat: { completions: { create: azureCreate } } });

    await generateChatResponse('sess-1', 'Hello', {
      portalType: 'customer',
      userId: 'user-1',
    } as never);

    expect(mockMeterUserUsage).not.toHaveBeenCalled();
  });
});
