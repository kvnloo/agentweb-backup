/**
 * Tests for generateChatResponse model routing:
 * - Gemini  → early-exit text-only path (getGeminiClient)
 * - Claude  → agentModeService.getBedrockClient() → full tool-calling loop
 * - Azure   → default OpenAI client → full tool-calling loop
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

// ── Bedrock client mock — captures calls to getBedrockClient ─────────────────
const mockBedrockClientCreate = jest.fn();
const mockGetBedrockClient = jest.fn().mockResolvedValue({
  chat: {
    completions: {
      create: mockBedrockClientCreate,
    },
  },
});

jest.mock('../services/agentModeService', () => ({
  AgentModeService: jest.fn().mockImplementation(() => ({
    getBedrockClient: mockGetBedrockClient,
    executeTool: jest.fn(),
  })),
  agentModeService: {
    getBedrockClient: mockGetBedrockClient,
    executeTool: jest.fn(),
  },
}));

// ── Gemini client mock — captures calls ──────────────────────────────────────
const mockGeminiCreate = jest.fn();
const mockGeminiClientInstance = {
  chat: { completions: { create: mockGeminiCreate } },
};
jest.mock('openai', () =>
  jest.fn().mockImplementation(() => mockGeminiClientInstance)
);

jest.mock('@google-cloud/discoveryengine', () => ({
  EngineServiceClient: jest.fn(),
  SearchServiceClient: jest.fn(),
}));
jest.mock('@google-cloud/storage', () => ({ Storage: jest.fn() }));
jest.mock('../controllers/guide', () => ({ getGuide: jest.fn() }));
jest.mock('../controllers/release', () => ({ getReleases: jest.fn() }));
jest.mock('../controllers/api', () => ({ getApiDocs: jest.fn() }));
jest.mock('../controllers/user-guide', () => ({ getUserGuide: jest.fn() }));
jest.mock('../controllers/docsController', () => ({ getUserReleaseNotes: jest.fn() }));
jest.mock('../services/db', () => ({ taskDb: {} }));
jest.mock('../utils/secretsManager', () => ({
  getGCSPPrivateKey: jest.fn(),
  getSecret: jest.fn().mockResolvedValue('fake-gemini-key'),
}));
jest.mock('../utils/s3Utils', () => ({
  uploadFileToS3: jest.fn().mockResolvedValue({ success: false }),
}));

import { generateChatResponse, __resetEmmaSystemContextCache } from '../services/chatbotService';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** A minimal OpenAI-format completion with no tool calls */
function makeCompletion(content = 'Hello') {
  return {
    choices: [{ message: { role: 'assistant', content, tool_calls: null } }],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    model: 'test-model',
  };
}

/**
 * Seed the DynamoDB mock so that:
 *  1. addMessageToSession (put) succeeds
 *  2. getChatSession (get) returns a session with one user message
 *  3. getEmmaSystemContext (get) returns the hardcoded fallback
 *  4. searchKnowledgeBase / platform KB (query) returns empty
 */
function seedSessionMocks(sessionId = 'sess-1', userId = 'user-1') {
  const session = {
    sessionId,
    userId,
    portalType: 'customer',
    messages: [{ role: 'user', content: 'Hello' }],
    pageIdentifier: 'customer-portal',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
  };

  // getChatSession call returns the session
  getPromiseMock.mockResolvedValue({ Item: session });
  // All DynamoDB queries (KB search) return empty
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
    it('calls getGeminiClient (OpenAI constructor) and takes the early-exit path', async () => {
      seedSessionMocks();
      mockGeminiCreate.mockResolvedValue(makeCompletion('Gemini says hi'));

      const result = await generateChatResponse(
        'sess-1', 'Hello', undefined, undefined, 'customer', 'user-1',
        undefined, undefined, 'gemini-2.5-flash'
      );

      expect(mockGeminiCreate).toHaveBeenCalledTimes(1);
      expect(mockGetBedrockClient).not.toHaveBeenCalled();
      expect(result).toBe('Gemini says hi');
    });

    it('does NOT call Bedrock for a gemini model', async () => {
      seedSessionMocks();
      mockGeminiCreate.mockResolvedValue(makeCompletion());

      await generateChatResponse(
        'sess-1', 'Hi', undefined, undefined, 'customer', 'user-1',
        undefined, undefined, 'gemini-2.5-pro'
      );

      expect(mockGetBedrockClient).not.toHaveBeenCalled();
    });
  });

  // ── Claude ────────────────────────────────────────────────────────────────

  describe('Claude / Bedrock model', () => {
    it('calls agentModeService.getBedrockClient with the model ID', async () => {
      seedSessionMocks();
      // Bedrock client returns a completion with no tool calls
      mockBedrockClientCreate.mockResolvedValue(makeCompletion('Claude says hi'));

      await generateChatResponse(
        'sess-1', 'Hello', undefined, undefined, 'customer', 'user-1',
        undefined, undefined, 'anthropic.claude-sonnet-4-6'
      );

      expect(mockGetBedrockClient).toHaveBeenCalledWith('anthropic.claude-sonnet-4-6');
    });

    it('does NOT call the Gemini client path for a Claude model', async () => {
      seedSessionMocks();
      mockBedrockClientCreate.mockResolvedValue(makeCompletion('Claude'));

      await generateChatResponse(
        'sess-1', 'Hi', undefined, undefined, 'customer', 'user-1',
        undefined, undefined, 'anthropic.claude-sonnet-4-6'
      );

      // mockGeminiCreate is the create fn on the OpenAI mock instance used as Gemini client.
      // It should NOT have been called because Claude takes the Bedrock path.
      // (The OpenAI constructor IS called once for the default openai client at module init,
      //  but mockGeminiCreate should not be called for Claude requests.)
      expect(mockGeminiCreate).not.toHaveBeenCalled();
    });

    it('returns the assistant message from the Bedrock completion', async () => {
      seedSessionMocks();
      mockBedrockClientCreate.mockResolvedValue(makeCompletion('Bedrock response'));

      const result = await generateChatResponse(
        'sess-1', 'Hi', undefined, undefined, 'customer', 'user-1',
        undefined, undefined, 'anthropic.claude-sonnet-4-6'
      );

      // Result is a string (no tool calls) or an object with content
      const content = typeof result === 'string' ? result : (result as any).content;
      expect(content).toBe('Bedrock response');
    });

    it('routes claude-* models (not just anthropic. prefix) to Bedrock', async () => {
      seedSessionMocks();
      mockBedrockClientCreate.mockResolvedValue(makeCompletion('ok'));

      await generateChatResponse(
        'sess-1', 'Hi', undefined, undefined, 'customer', 'user-1',
        undefined, undefined, 'claude-opus-4'
      );

      expect(mockGetBedrockClient).toHaveBeenCalledWith('claude-opus-4');
    });

    it('does NOT route generic model named "sonnet-x" to Bedrock (fragile-match guard)', async () => {
      // A hypothetical model named "sonnet-v2" that is NOT Claude should use Azure OpenAI,
      // not the Bedrock client. The isClaudeModel check no longer matches on 'sonnet' alone.
      seedSessionMocks();
      // The Azure OpenAI client will throw (not configured in test), but getBedrockClient should never be called.
      // We check the call counts before any error propagates.
      try {
        await generateChatResponse(
          'sess-1', 'Hi', undefined, undefined, 'customer', 'user-1',
          undefined, undefined, 'sonnet-v2-custom'
        );
      } catch {
        // Expected — Azure OpenAI is not configured in tests
      }

      expect(mockGetBedrockClient).not.toHaveBeenCalled();
    });
  });
});
