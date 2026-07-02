import { AgentModeService } from '../services/agentModeService';

// Minimal AWS/dependency mocks so the service can be instantiated without real creds.
jest.mock('../services/db', () => ({
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

describe('AgentModeService - Generation model validation (ENG-46)', () => {
  let agentModeService: AgentModeService;

  beforeEach(() => {
    agentModeService = new AgentModeService();
    jest.clearAllMocks();
  });

  it('passes a valid model through unchanged', () => {
    const result = agentModeService.resolveGenerationModel('gpt-5.5');
    expect(result.model).toBe('gpt-5.5');
    expect(result.fellBack).toBe(false);
    expect(result.requestedModel).toBe('gpt-5.5');
  });

  it('normalizes a legacy/renamed model id forward', () => {
    const result = agentModeService.resolveGenerationModel('claude-opus-4-8');
    expect(result.model).toBe('anthropic.claude-opus-4-8');
    expect(result.fellBack).toBe(false);
  });

  it('falls back to the default model for a removed/invalid id instead of throwing', () => {
    // 'gpt-5.1' was removed from the allow-list — the smoke-test config still pins it.
    const result = agentModeService.resolveGenerationModel('gpt-5.1');
    expect(result.fellBack).toBe(true);
    expect(result.model).toBe(agentModeService.default_model);
    expect(result.requestedModel).toBe('gpt-5.1');
    // The fallback target must itself be a valid, servable model.
    expect(agentModeService.getSupportedModels(true)).resolves.toContain(result.model);
  });

  it('falls back to the default model for an undefined/empty model id', () => {
    const resultUndefined = agentModeService.resolveGenerationModel(undefined as unknown as string);
    expect(resultUndefined.fellBack).toBe(true);
    expect(resultUndefined.model).toBe(agentModeService.default_model);

    const resultEmpty = agentModeService.resolveGenerationModel('');
    expect(resultEmpty.fellBack).toBe(true);
    expect(resultEmpty.model).toBe(agentModeService.default_model);
  });
});
