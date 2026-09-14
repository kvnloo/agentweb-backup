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
