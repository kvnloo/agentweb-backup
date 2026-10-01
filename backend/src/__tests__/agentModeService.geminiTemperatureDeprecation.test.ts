/**
 * ENG-1713 — Google's Gemini 3.6+ family deprecates temperature/top_p/top_k
 * (ai.google.dev/gemini-api/docs/latest-model, "Remove deprecated sampling
 * parameters", confirmed live 2026-09-03 for both gemini-3.7-flash and
 * gemini-3.8-flash). Google currently ignores the param on these models
 * (soft no-op) but states a future model generation will hard-400 on it —
 * `supportsTemperature: false` on the audited registry entries is what
 * makes `AgentModeService.callLLM` omit `temperature` from the upstream
 * OpenRouter request before that rollout lands.
 *
 * Raised by CodeRabbit on PR #2736 (Gemini 3.8 Flash addition): neither
 * gemini-3.7-flash nor the new gemini-3.8-flash had been fixed, to avoid
 * diverging siblings inconsistently — this is the one coherent pass across
 * the family the issue asked for, not a per-model patch.
 */
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

describe('ENG-1713: Gemini 3.6+ supportsTemperature audit', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
  });

  afterEach(() => {
    delete process.env.OPENROUTER_API_KEY;
  });

  // Registry flags: the deprecated-family models must be marked false, and
  // the still-supported models below the 3.6 cutoff must be left untouched
  // (this is the "one coherent pass, not per-model" contract — flipping the
  // whole family instead of just the audited ones would be its own bug).
  describe('registry flags', () => {
    it.each(['gemini-3.7-flash', 'gemini-3.8-flash'])(
      'marks %s supportsTemperature: false (Google-deprecated)',
      (modelId) => {
        const service = new AgentModeService();
        expect((service as any).llmModels[modelId].supportsTemperature).toBe(false);
      }
    );

    it.each([
      'gemini-3-flash-preview',
      'gemini-3.1-pro-preview',
      'gemini-3.1-flash-lite',
      'gemini-3.5-flash',
    ])('leaves pre-3.6 %s supportsTemperature: true (still honored by Google)', (modelId) => {
      const service = new AgentModeService();
      expect((service as any).llmModels[modelId].supportsTemperature).toBe(true);
    });
  });

  // Request-construction proof: temperature must never reach the upstream
  // OpenRouter payload for a deprecated-family model, even when a caller
  // explicitly passes one.
  describe('request construction omits temperature for the deprecated family', () => {
    it.each(['gemini-3.7-flash', 'gemini-3.8-flash'])(
      'omits temperature from the OpenRouter request for %s',
      async (modelId) => {
        const service = new AgentModeService();
        const create = jest.fn().mockResolvedValue({ choices: [], usage: {} });
        jest.spyOn(service, 'getOpenRouterClient').mockResolvedValue({
          chat: { completions: { create } },
        } as any);

        await service.callLLM(
          modelId,
          [{ role: 'user', content: 'Hello' }],
          { temperature: 0.7 } as any,
        );

        const request = create.mock.calls[0][0];
        expect(request).not.toHaveProperty('temperature');
      }
    );

    it('still sends temperature for a pre-3.6 Gemini model that honors it', async () => {
      const service = new AgentModeService();
      const create = jest.fn().mockResolvedValue({ choices: [], usage: {} });
      jest.spyOn(service, 'getOpenRouterClient').mockResolvedValue({
        chat: { completions: { create } },
      } as any);

      await service.callLLM(
        'gemini-3.5-flash',
        [{ role: 'user', content: 'Hello' }],
        { temperature: 0.7 } as any,
      );

      const request = create.mock.calls[0][0];
      expect(request).toEqual(expect.objectContaining({ temperature: 0.7 }));
    });
  });
});
