/**
 * Tests for generateChatResponse model routing:
 * - Gemini  → agentModeService.getGeminiClient() → tool-calling loop
 * - Claude  → agentModeService.getBedrockClient() → tool-calling loop
 * - Azure   → default OpenAI client → tool-calling loop
 */

// ── DynamoDB mock (module-level, shared by chatbotService on import) ──────────
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

// ── Client create mocks ───────────────────────────────────────────────────────
const mockBedrockClientCreate = jest.fn();
const mockGeminiClientCreate = jest.fn();

const mockGetBedrockClient = jest.fn().mockResolvedValue({
  chat: { completions: { create: mockBedrockClientCreate } },
});
const mockGetGeminiClient = jest.fn().mockResolvedValue({
  chat: { completions: { create: mockGeminiClientCreate } },
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

// ── OpenAI mock (used for the module-level default `openai` client init) ─────
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

import { generateChatResponse, __resetEmmaSystemContextCache } from '../services/chatbotService';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Minimal OpenAI-format completion with no tool calls */
function makeCompletion(content = 'Hello') {
  return {
    choices: [{ message: { role: 'assistant', content, tool_calls: null } }],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    model: 'test-model',
  };
}

/** Seed DynamoDB so getChatSession returns a valid session */
function seedSessionMocks() {
  const session = {
    sessionId: 'sess-1',
    userId: 'user-1',
    portalType: 'customer',
    messages: [{ role: 'user', content: 'Hello' }],
    pageIdentifier: 'customer-portal',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
  };
  getPromiseMock.mockResolvedValue({ Item: session });
  queryPromiseMock.mockResolvedValue({ Items: [] });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('generateChatResponse — model routing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetEmmaSystemContextCache();
    putPromiseMock.mockResolvedValue({});
    updatePromiseMock.mockResolvedValue({});
  });

  // ── Gemini ────────────────────────────────────────────────────────────────

  describe('Gemini model', () => {
    it('calls agentModeService.getGeminiClient for gemini models', async () => {
      seedSessionMocks();
      mockGeminiClientCreate.mockResolvedValue(makeCompletion('Gemini says hi'));

      await generateChatResponse(
        'sess-1', 'Hello',
        { portalType: 'customer', userId: 'user-1', model: 'gemini-2.5-flash' }
      );

      expect(mockGetGeminiClient).toHaveBeenCalledTimes(1);
      expect(mockGetBedrockClient).not.toHaveBeenCalled();
    });

    it('returns content from the Gemini completion', async () => {
      seedSessionMocks();
      mockGeminiClientCreate.mockResolvedValue(makeCompletion('Gemini says hi'));

      const result = await generateChatResponse(
        'sess-1', 'Hello',
        { portalType: 'customer', userId: 'user-1', model: 'gemini-2.5-flash' }
      );

      const content = typeof result === 'string' ? result : (result as any).content;
      expect(content).toBe('Gemini says hi');
    });

    it('does NOT call Bedrock for a gemini model', async () => {
      seedSessionMocks();
      mockGeminiClientCreate.mockResolvedValue(makeCompletion());

      await generateChatResponse(
        'sess-1', 'Hi',
        { portalType: 'customer', userId: 'user-1', model: 'gemini-2.5-pro' }
      );

      expect(mockGetBedrockClient).not.toHaveBeenCalled();
    });
  });

  // ── Claude ────────────────────────────────────────────────────────────────

  describe('Claude / Bedrock model', () => {
    it('calls agentModeService.getBedrockClient with the model ID', async () => {
      seedSessionMocks();
      mockBedrockClientCreate.mockResolvedValue(makeCompletion('Claude says hi'));

      await generateChatResponse(
        'sess-1', 'Hello',
        { portalType: 'customer', userId: 'user-1', model: 'anthropic.claude-sonnet-4-6' }
      );

      expect(mockGetBedrockClient).toHaveBeenCalledWith('anthropic.claude-sonnet-4-6');
      expect(mockGetGeminiClient).not.toHaveBeenCalled();
    });

    it('returns the assistant message from the Bedrock completion', async () => {
      seedSessionMocks();
      mockBedrockClientCreate.mockResolvedValue(makeCompletion('Bedrock response'));

      const result = await generateChatResponse(
        'sess-1', 'Hi',
        { portalType: 'customer', userId: 'user-1', model: 'anthropic.claude-sonnet-4-6' }
      );

      const content = typeof result === 'string' ? result : (result as any).content;
      expect(content).toBe('Bedrock response');
    });

    it('routes claude-* model names (not just anthropic. prefix) to Bedrock', async () => {
      seedSessionMocks();
      mockBedrockClientCreate.mockResolvedValue(makeCompletion('ok'));

      await generateChatResponse(
        'sess-1', 'Hi',
        { portalType: 'customer', userId: 'user-1', model: 'claude-opus-4' }
      );

      expect(mockGetBedrockClient).toHaveBeenCalledWith('claude-opus-4');
    });

    it('does NOT route generic model "sonnet-x" to Bedrock (fragile-match guard)', async () => {
      // A hypothetical model named "sonnet-v2" that is NOT Claude should use Azure OpenAI.
      // The isClaudeModel check no longer matches on 'sonnet' alone.
      seedSessionMocks();
      try {
        await generateChatResponse(
          'sess-1', 'Hi',
          { portalType: 'customer', userId: 'user-1', model: 'sonnet-v2-custom' }
        );
      } catch {
        // Expected — Azure OpenAI is not configured in tests
      }

      expect(mockGetBedrockClient).not.toHaveBeenCalled();
      expect(mockGetGeminiClient).not.toHaveBeenCalled();
    });
  });
});
