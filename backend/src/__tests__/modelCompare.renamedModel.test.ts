import { AgentModeService } from '../services/agentModeService';
import { LLM_MODEL_REGISTRY } from '../services/agentMode/llmModelRegistry';
import { getModelPrice } from '../utils/llmPricing';
import { isSameServedModel } from '../services/agentMode/modelComparison';
import { resolveOpenRouterUpstreamModelId } from '../utils/openRouterGatewayContract';

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
jest.mock('../utils/agentModeAlerts', () => ({
  sendAgentModeOncallAlert: jest.fn().mockResolvedValue(undefined),
  __resetAgentModeAlertDedupeForTests: jest.fn(),
}));

jest.mock('@langchain/aws', () => ({
  ChatBedrockConverse: jest.fn().mockImplementation(() => ({ invoke: jest.fn() })),
}));

jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('@langchain/core/messages', () => ({
  HumanMessage: jest.fn(),
  AIMessage: jest.fn(),
  SystemMessage: jest.fn(),
  ToolMessage: jest.fn(),
}));


// ENG-55 follow-up (2026-10-09): OpenRouter retired the bare id `qwen/qwen3.8-max`
// from its public catalog (only `qwen/qwen3.8-max-0902` -> canonical
// `qwen/qwen3.8-max-20260902` and `-prime` remain) but kept routing the old id as
// an alias. Compare therefore saw a served slug that is a registered sibling's
// snapshot and (correctly) refused it for the stale base id: model_mismatch.
// The registry entry is renamed to the real id and the old id is a legacy alias,
// so pins keep working on the right model and the identity check stays strict.
const STALE_ID = 'openrouter/qwen/qwen3.8-max';
const CURRENT_ID = 'openrouter/qwen/qwen3.8-max-0902';

describe('renamed OpenRouter model: qwen3.8-max -> qwen3.8-max-0902', () => {
  const registry = LLM_MODEL_REGISTRY as Record<string, unknown>;
  const registeredUpstreamIds = () => Object.keys(registry).flatMap((id) => {
    try { return [resolveOpenRouterUpstreamModelId(id)]; } catch { return []; }
  });

  it('the registry holds the id OpenRouter actually lists, priced; the retired id is only a priced deprecated alias', () => {
    expect(registry[STALE_ID]).toBeUndefined();
    expect(registry[CURRENT_ID]).toBeDefined();
    expect(getModelPrice(CURRENT_ID)).not.toBeNull();
    // Deprecated alias stays priced (same $2/$6) so late usage rows still meter.
    expect(getModelPrice(STALE_ID)).toEqual(getModelPrice(CURRENT_ID));
  });

  it('existing pins (sessions, schedules, settings) resolve forward to the current id without falling back', () => {
    const service = new AgentModeService();
    expect(service.normalizeModelId(STALE_ID)).toBe(CURRENT_ID);
    expect(service.resolveGenerationModel(STALE_ID)).toEqual({ model: CURRENT_ID, fellBack: false, requestedModel: STALE_ID });
    expect(service.normalizeModelId(CURRENT_ID)).toBe(CURRENT_ID);
  });

  it('Compare accepts the model OpenRouter reports for the renamed id (dated canonical slug and bare id)', () => {
    const known = registeredUpstreamIds();
    const upstream = resolveOpenRouterUpstreamModelId(new AgentModeService().normalizeModelId(STALE_ID));
    expect(upstream).toBe('qwen/qwen3.8-max-0902');
    for (const served of ['qwen/qwen3.8-max-20260902', 'qwen/qwen3.8-max-0902']) {
      expect(isSameServedModel(upstream, served, known)).toBe(true);
      // ...and also once the daily catalog refresh has auto-added every catalog sibling.
      expect(isSameServedModel(upstream, served, [...known, 'qwen/qwen3.8-max-prime', 'qwen/qwen3.8-max'])).toBe(true);
    }
  });

  it('a genuinely different served model is still a mismatch', () => {
    const known = registeredUpstreamIds();
    for (const served of [
      'qwen/qwen3.8-max-prime-20260923', // different SKU
      'qwen/qwen3.8-max-prime',
      'qwen/qwen3.8-max-20260923', // other snapshot date
      'qwen/qwen3.8-max', // undated bare alias is not the pinned snapshot
      'qwen/qwen3.8-27b',
      'openai/gpt-5.5',
    ]) {
      expect(isSameServedModel('qwen/qwen3.8-max-0902', served, known)).toBe(false);
    }
  });
});
