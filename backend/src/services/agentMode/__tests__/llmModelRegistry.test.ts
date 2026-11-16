jest.mock('../../db', () => ({
  agentModeDb: {},
  userDb: { getUserById: jest.fn() },
  scheduleDb: {},
  scheduleTemplateDb: {},
}));

jest.mock('aws-sdk', () => ({
  DynamoDB: { DocumentClient: jest.fn(() => ({})) },
  S3: jest.fn(() => ({})),
  SecretsManager: jest.fn(() => ({})),
  config: { update: jest.fn() },
}));

import { AgentModeService } from '../../agentModeService';
import { LLM_MODEL_REGISTRY, createLlmModelRegistry } from '../llmModelRegistry';
import { cleanModelName } from '../modelCatalogRefresh';
import { buildModelMentionIndex, findModelMention } from '../../../utils/modelMentionRequest';

describe('LLM model registry module (ENG-1831)', () => {
  it('is what AgentModeService serves', () => {
    expect((new AgentModeService() as any).llmModels).toEqual(LLM_MODEL_REGISTRY);
  });

  it('gives every service instance its own entries', () => {
    const first = new AgentModeService() as any;
    const second = new AgentModeService() as any;
    const model = 'gpt-5.5';

    first.llmModels[model].client = { chat: { completions: { create: jest.fn() } } };
    first.llmModels['test-only-model'] = { client: null, supportsTemperature: true };

    expect(second.llmModels[model].client).toBeNull();
    expect(second.llmModels).not.toHaveProperty('test-only-model');
    expect(LLM_MODEL_REGISTRY[model].client).toBeNull();
    expect(LLM_MODEL_REGISTRY).not.toHaveProperty('test-only-model');
  });

  it('copies are equal to, but not the same objects as, the shared registry', () => {
    const copy = createLlmModelRegistry();
    expect(copy).toEqual(LLM_MODEL_REGISTRY);
    for (const modelId of Object.keys(LLM_MODEL_REGISTRY)) {
      expect(copy[modelId]).not.toBe(LLM_MODEL_REGISTRY[modelId]);
    }
  });
});

// Model-upgrade audit 2026-11-15 (docs/model-upgrade-audit-2026-11-15.md): Claude Sonnet 5.5 metadata completed from
// the OpenRouter record (reasoning.supported_efforts) while it stays admin-only — customer exposure is an ENG-1606
// roster decision, and vision needs a live describe_image smoke this change did not run.
describe('Claude Sonnet 5.5 registry entry (model-upgrade audit 2026-11-15)', () => {
  const id = 'openrouter/anthropic/claude-sonnet-5.5';
  const sonnet = LLM_MODEL_REGISTRY[id];

  it('keeps its pinned id and stays admin-only', () => {
    expect(sonnet).toBeDefined();
    expect(sonnet.adminOnly).toBe(true);
  });

  it('records the provider-published reasoning efforts without setting an effort default', () => {
    expect(sonnet.supportedReasoningEfforts).toEqual(['max', 'xhigh', 'high', 'medium', 'low']);
    expect(sonnet.reasoningEffort).toBeUndefined();
  });

  it('does not claim vision or carry the unreviewed auto-added placeholder description', () => {
    expect(sonnet.supportsVision).toBeUndefined();
    expect(sonnet.description).not.toMatch(/Auto-added from OpenRouter/);
  });
});

// ENG-2646: `name` is the model's one display name in every client (the portal resolves every model label from it).
// Seven OpenRouter auto-additions predated cleanModelName and kept OpenRouter's "<Vendor>: <Model>" form, so the
// picker listed "Z.ai: GLM 5.3 Flash" beside "GLM 5.2" and "Anthropic: Claude Sonnet 5.5" beside "Claude Sonnet 5".
describe('LLM model registry display names (ENG-2646)', () => {
  const named = Object.entries(LLM_MODEL_REGISTRY).filter(([, config]) => typeof config.name === 'string');

  it('are in house style: no OpenRouter "<Vendor>: " prefix', () => {
    const prefixed = named.filter(([, config]) => cleanModelName(config.name as string) !== config.name);
    expect(prefixed.map(([id, config]) => `${id}: ${config.name}`)).toEqual([]);
  });

  it('are unique, so two models never read the same in a picker', () => {
    const byName = new Map<string, string[]>();
    for (const [id, config] of named) byName.set(config.name as string, [...(byName.get(config.name as string) ?? []), id]);
    expect([...byName].filter(([, ids]) => ids.length > 1)).toEqual([]);
  });

  // Emma's "use <model>" detection indexes these names (agentModeService.getModelMentionCatalog). Dropping the
  // vendor word from a name must not stop a message that still says it from resolving to that model.
  it('still resolve a request that names the model with or without its vendor', () => {
    const index = buildModelMentionIndex(Object.entries(LLM_MODEL_REGISTRY)
      .filter(([, c]) => !c.internalOnly && !c.isLive)
      .map(([id, c]) => ({ id, name: c.name, family: c.family })));
    expect(findModelMention('use Anthropic: Claude Sonnet 5.5 for this', index)?.modelId).toBe('openrouter/anthropic/claude-sonnet-5.5');
    expect(findModelMention('use Claude Sonnet 5.5 for this', index)?.modelId).toBe('openrouter/anthropic/claude-sonnet-5.5');
    expect(findModelMention('switch to Z.ai: GLM 5.3 Flash', index)?.modelId).toBe('openrouter/z-ai/glm-5.3-flash');
    expect(findModelMention('switch to GLM 5.3', index)?.modelId).toBe('openrouter/z-ai/glm-5.3');
  });
});
