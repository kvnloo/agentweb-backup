import { AgentModeService } from '../services/agentModeService';
import { settingsService } from '../services/settingsService';
import { isTransientLLMError } from '../utils/agentModeErrors';

// Mock the dependencies
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

// Mock Bedrock modules
const mockBedrockInvoke = jest.fn();
jest.mock('@langchain/aws', () => ({
  ChatBedrockConverse: jest.fn().mockImplementation(() => ({
    invoke: mockBedrockInvoke,
  })),
}));

jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('@langchain/core/messages', () => ({
  HumanMessage: jest.fn().mockImplementation((content: string) => ({ role: 'user', content })),
  AIMessage: jest.fn().mockImplementation((content: string | object) => ({ role: 'assistant', ...(typeof content === 'string' ? { content } : content) })),
  SystemMessage: jest.fn().mockImplementation((content: string) => ({ role: 'system', content })),
  ToolMessage: jest.fn().mockImplementation((content: string) => ({ role: 'tool', content })),
}));

describe('AgentModeService - Backup Model Fallback', () => {
  let agentModeService: AgentModeService;

  beforeEach(() => {
    agentModeService = new AgentModeService();
    jest.clearAllMocks();
    process.env.AWS_REGION = 'us-west-2';
    process.env.AWS_ACCESS_KEY_ID = 'test-key';
    process.env.AWS_SECRET_ACCESS_KEY = 'test-secret';
  });

  afterEach(() => {
    delete process.env.AWS_REGION;
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
  });

  describe('getBackupModel()', () => {
    it('uses the policy-approved fallback instead of the global premium backup', async () => {
      (settingsService.getSetting as jest.Mock).mockResolvedValue({
        settingValue: 'anthropic.claude-sonnet-4-6'
      });

      const backup = await agentModeService.getBackupModel(
        'gemini-3.1-flash-lite',
        'anthropic.claude-haiku-4-5-20251001-v1:0'
      );

      expect(backup).toBe('anthropic.claude-haiku-4-5-20251001-v1:0');
      expect(settingsService.getSetting).not.toHaveBeenCalled();
    });

    it('disables transient fallback when optimized policy has no second approved model', async () => {
      (settingsService.getSetting as jest.Mock).mockResolvedValue({
        settingValue: 'anthropic.claude-sonnet-4-6'
      });

      const backup = await agentModeService.getBackupModel('gemini-3.1-flash-lite', null);

      expect(backup).toBeNull();
      expect(settingsService.getSetting).not.toHaveBeenCalled();
    });

    it('should return admin-configured backup model when setting exists and is valid', async () => {
      (settingsService.getSetting as jest.Mock).mockResolvedValue({
        settingValue: 'anthropic.claude-sonnet-4-6'
      });

      const backup = await agentModeService.getBackupModel('gpt-5-chat-2');
      expect(backup).toBe('anthropic.claude-sonnet-4-6');
    });

    it('should return null when no admin setting exists (no backup by default)', async () => {
      (settingsService.getSetting as jest.Mock).mockResolvedValue(null);

      const backup = await agentModeService.getBackupModel('gpt-5-chat-2');
      expect(backup).toBeNull();
    });

    it('should return null when admin setting is empty string', async () => {
      (settingsService.getSetting as jest.Mock).mockResolvedValue({
        settingValue: '  '
      });

      const backup = await agentModeService.getBackupModel('gpt-5-chat-2');
      expect(backup).toBeNull();
    });

    it('should skip admin-configured backup that matches primary model', async () => {
      (settingsService.getSetting as jest.Mock).mockResolvedValue({
        settingValue: 'gpt-5-chat-2'
      });

      const backup = await agentModeService.getBackupModel('gpt-5-chat-2');
      expect(backup).toBeNull();
    });

    it('should handle settings service errors gracefully and return null', async () => {
      (settingsService.getSetting as jest.Mock).mockRejectedValue(new Error('DB error'));

      const backup = await agentModeService.getBackupModel('gpt-5-chat-2');
      expect(backup).toBeNull();
    });

    it('should skip admin-configured backup that is not a supported model', async () => {
      (settingsService.getSetting as jest.Mock).mockResolvedValue({
        settingValue: 'unsupported-model-xyz'
      });

      const backup = await agentModeService.getBackupModel('gpt-5-chat-2');
      expect(backup).toBeNull();
    });

    it('should return valid backup model for any primary model', async () => {
      (settingsService.getSetting as jest.Mock).mockResolvedValue({
        settingValue: 'gpt-5-chat-2'
      });

      const backup = await agentModeService.getBackupModel('anthropic.claude-sonnet-4-6');
      expect(backup).toBe('gpt-5-chat-2');
    });
  });
});
