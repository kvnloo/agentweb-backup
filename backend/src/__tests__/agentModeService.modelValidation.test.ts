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

  // 2026-08-19: gpt-5-chat-2 and gpt-5.2-chat were removed from the registry
  // during the Rui-owned Azure resource migration (gpt-5-chat-2 dropped from
  // Azure's deployable catalog entirely; gpt-5.2-chat's Azure inference cutoff
  // already passed). A paused schedule/session/setting still holding either id
  // must resolve forward to gpt-5.5, not throw or silently fall back to the
  // generic default.
  it.each(['gpt-5-chat-2', 'gpt-5.2-chat'])(
    'normalizes the retired %s to gpt-5.5 instead of falling back',
    (retiredId) => {
      const result = agentModeService.resolveGenerationModel(retiredId);
      expect(result.model).toBe('gpt-5.5');
      expect(result.fellBack).toBe(false);
      expect(result.requestedModel).toBe(retiredId);
    }
  );

  it('falls back to the default model for a removed/invalid id instead of throwing', async () => {
    // 'gpt-5.1' was removed from the allow-list — the smoke-test config still pins it.
    const result = agentModeService.resolveGenerationModel('gpt-5.1');
    expect(result.fellBack).toBe(true);
    expect(result.model).toBe(agentModeService.default_model);
    expect(result.requestedModel).toBe('gpt-5.1');
    // The fallback target must itself be a valid, servable model.
    await expect(agentModeService.getSupportedModels(true)).resolves.toContain(result.model);
  });

  it('falls back to the default model for an undefined/empty model id', () => {
    const resultUndefined = agentModeService.resolveGenerationModel(undefined as unknown as string);
    expect(resultUndefined.fellBack).toBe(true);
    expect(resultUndefined.model).toBe(agentModeService.default_model);

    const resultEmpty = agentModeService.resolveGenerationModel('');
    expect(resultEmpty.fellBack).toBe(true);
    expect(resultEmpty.model).toBe(agentModeService.default_model);
  });

  it('does not treat inherited Object.prototype keys as valid models', () => {
    // Without a hasOwnProperty guard, 'constructor'/'toString' would resolve
    // truthily off the prototype chain and masquerade as a valid allow-list id.
    for (const protoKey of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
      const result = agentModeService.resolveGenerationModel(protoKey);
      expect(result.fellBack).toBe(true);
      expect(result.model).not.toBe(protoKey);
      // The fallback target must itself be a real, servable model.
      expect(Object.prototype.hasOwnProperty.call((agentModeService as any).llmModels, result.model)).toBe(true);
    }
  });

  it('falls back to a known-good model when the configured default is itself unavailable', () => {
    // Simulate a stale AZURE_OPENAI_DEPLOYMENT_AGENT_MODE pinning a retired id.
    agentModeService.default_model = 'gpt-retired-does-not-exist';
    const result = agentModeService.resolveGenerationModel('gpt-5.1');
    expect(result.fellBack).toBe(true);
    // Must NOT return the invalid default (which would re-throw inside callLLM)…
    expect(result.model).not.toBe('gpt-retired-does-not-exist');
    // …and must return a real, servable model instead.
    expect(Object.prototype.hasOwnProperty.call((agentModeService as any).llmModels, result.model)).toBe(true);
  });

  it('routes an invalid model through up-front resolution in generateMarketingResponse (no opaque "Unknown Error")', async () => {
    // Capture the REAL resolver before spying so we can assert the genuine fallback.
    const realResolve = agentModeService.resolveGenerationModel.bind(agentModeService);
    let captured: { model: string; fellBack: boolean; requestedModel: string } | undefined;
    const resolveSpy = jest
      .spyOn(agentModeService, 'resolveGenerationModel')
      .mockImplementation((m: string) => {
        captured = realResolve(m);
        // Halt right after the up-front resolution so we exercise generateMarketingResponse's
        // changed call path without driving the full generation engine (which would spawn
        // unmockable downstream work). callLLM is never reached with the invalid id.
        throw new Error('STOP_AFTER_RESOLVE');
      });

    let thrown: any;
    try {
      await agentModeService.generateMarketingResponse(
        'edit my landing page',
        [],
        'user-1',
        'gpt-5.1',
        'session-1',
        true
      );
    } catch (err) {
      thrown = err;
    }

    // generateMarketingResponse must route the requested id through resolveGenerationModel…
    expect(resolveSpy).toHaveBeenCalledWith('gpt-5.1');
    // …and the removed id must resolve to a valid fallback rather than reaching callLLM.
    expect(captured).toBeDefined();
    expect(captured!.fellBack).toBe(true);
    expect(captured!.model).not.toBe('gpt-5.1');
    expect(Object.prototype.hasOwnProperty.call((agentModeService as any).llmModels, captured!.model)).toBe(true);
    // The failure is our controlled halt — NOT an opaque "Invalid model 'gpt-5.1'" from callLLM.
    const rawMessage = thrown?.originalMessage || thrown?.message || '';
    expect(rawMessage).toBe('STOP_AFTER_RESOLVE');
    expect(rawMessage).not.toMatch(/Invalid model/i);
  });

  // --- Stale-default guard (ENG-46 caveat 1) -------------------------------
  // The runtime fallback masks a stale requested model, but the SHIPPED default
  // must itself always be a served model — otherwise every fallback would target
  // an invalid id and re-throw inside callLLM. These pin that invariant in CI so
  // the repo can never ship a stale `default_model` (e.g. after a model is
  // retired from the allow-list) without this test failing first.
  it('ships a default_model that is an actually-served allow-list model', async () => {
    const servedModels = await agentModeService.getSupportedModels(true);
    expect(servedModels).toContain(agentModeService.default_model);
  });

  it('resolves the configured default model without ever falling back', () => {
    const result = agentModeService.resolveGenerationModel(agentModeService.default_model);
    expect(result.fellBack).toBe(false);
    expect(result.model).toBe(agentModeService.default_model);
  });
});
