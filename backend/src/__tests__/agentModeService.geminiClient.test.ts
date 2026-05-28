jest.mock('../services/db', () => ({
  getSession: jest.fn(),
  saveMessage: jest.fn(),
  updateSession: jest.fn(),
  getTask: jest.fn(),
  getTaskExecution: jest.fn(),
  getUserById: jest.fn(),
}));

jest.mock('aws-sdk', () => ({
  DynamoDB: {
    DocumentClient: jest.fn().mockImplementation(() => ({
      get: jest.fn(),
      put: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      scan: jest.fn(),
      query: jest.fn(),
    })),
  },
  SecretsManager: jest.fn(),
  S3: jest.fn().mockImplementation(() => ({
    upload: jest.fn().mockReturnValue({
      promise: jest.fn().mockResolvedValue({ Location: 'mock-url', Key: 'mock-key' }),
    }),
  })),
}));

jest.mock('../services/chatbotService');
jest.mock('../services/settingsService');
jest.mock('../utils/secretsManager');

jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  ConverseCommand: jest.fn(),
}));

jest.mock('openai', () => jest.fn().mockImplementation((config: any) => ({ _config: config })));

import { AgentModeService } from '../services/agentModeService';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const MockOpenAI = require('openai') as jest.Mock;

describe('AgentModeService - Gemini client initialization', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.GEMINI_API_KEY = 'test-gemini-key';
  });

  afterEach(() => {
    delete process.env.GEMINI_API_KEY;
  });

  it('uses OpenAI-compat base URL with /openai/ suffix', async () => {
    const service = new AgentModeService();
    await (service as any).getGeminiClient();

    const config = MockOpenAI.mock.calls.find(
      (call: any[]) => call[0]?.baseURL?.includes('generativelanguage')
    )?.[0];

    expect(config?.baseURL).toBe('https://generativelanguage.googleapis.com/v1beta/openai/');
  });

  it('passes GEMINI_API_KEY to client', async () => {
    const service = new AgentModeService();
    await (service as any).getGeminiClient();

    const config = MockOpenAI.mock.calls.find(
      (call: any[]) => call[0]?.baseURL?.includes('generativelanguage')
    )?.[0];

    expect(config?.apiKey).toBe('test-gemini-key');
  });

  it('throws if GEMINI_API_KEY is missing', async () => {
    delete process.env.GEMINI_API_KEY;
    const service = new AgentModeService();
    await expect((service as any).getGeminiClient()).rejects.toThrow(/api key/i);
  });
});
