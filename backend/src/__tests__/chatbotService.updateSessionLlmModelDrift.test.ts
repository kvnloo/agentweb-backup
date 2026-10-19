/**
 * Reproduces a real production incident: session.llmModel read "gemini-3.8-flash"
 * while llmUsagePolicyDecision still claimed "openrouter/deepseek/deepseek-v4-flash"
 * was "honored" — the model every turn had actually run on. A 2-arg
 * updateSessionLlmModel call (task-type model override, admin/plan model swap, or
 * the picker PATCH endpoint) had overwritten llmModel without a matching decision,
 * leaving the OLD decision stranded and silently describing a model it no longer
 * applied to.
 *
 * updateSessionLlmModel must never persist that contradiction: a decision not
 * accompanied by llmModel is stale by definition and must be cleared, not kept.
 */

const updatePromiseMock = jest.fn().mockResolvedValue({ Attributes: {} });

jest.mock('aws-sdk', () => ({
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      update: jest.fn((params: any) => ({ promise: () => updatePromiseMock(params) })),
    })),
  },
  S3: jest.fn(() => ({
    upload: jest.fn().mockReturnThis(),
    promise: jest.fn(),
  })),
  config: { update: jest.fn() },
}));

jest.mock('openai', () => jest.fn(() => ({})));
jest.mock('@google-cloud/discoveryengine', () => ({
  EngineServiceClient: jest.fn(),
  SearchServiceClient: jest.fn(),
}));
jest.mock('@google-cloud/storage', () => ({ Storage: jest.fn() }));
jest.mock('../controllers/guide', () => ({ getGuide: jest.fn() }));
jest.mock('../controllers/release', () => ({ getReleases: jest.fn() }));
jest.mock('../controllers/docsController', () => ({ getUserReleaseNotes: jest.fn() }));
jest.mock('../services/db', () => ({ taskDb: {} }));
jest.mock('../utils/secretsManager', () => ({ getGCSPPrivateKey: jest.fn() }));

import { chatbotDb } from '../services/chatbotService';

describe('chatbotDb.updateSessionLlmModel — llmModel/llmUsagePolicyDecision must never drift apart', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    updatePromiseMock.mockResolvedValue({ Attributes: {} });
  });

  it('clears any existing llmUsagePolicyDecision when llmModel changes without a fresh decision', async () => {
    await chatbotDb.updateSessionLlmModel('session-1', 'gemini-3.8-flash');

    const params = updatePromiseMock.mock.calls[0][0];
    expect(params.UpdateExpression).toContain('SET llmModel = :llmModel');
    expect(params.UpdateExpression).toContain('REMOVE llmUsagePolicyDecision');
    expect(params.ExpressionAttributeValues[':llmModel']).toBe('gemini-3.8-flash');
    expect(params.ExpressionAttributeValues).not.toHaveProperty(':policyDecision');
  });

  it('writes llmModel and llmUsagePolicyDecision together — never one without the other', async () => {
    const decision = {
      requestedModel: 'openrouter/deepseek/deepseek-v4-flash',
      effectiveModel: 'openrouter/deepseek/deepseek-v4-flash',
      backupModel: null,
      backupSource: null,
      modelSelection: 'honored' as const,
      modelSelectionReason: 'requested_model_allowed',
      usageMode: 'full_choice' as const,
      usagePolicyVersion: 'policy-1',
      recordedAt: '2026-09-24T11:42:03.407Z',
    };

    await chatbotDb.updateSessionLlmModel(
      'session-1',
      'openrouter/deepseek/deepseek-v4-flash',
      decision,
    );

    const params = updatePromiseMock.mock.calls[0][0];
    expect(params.UpdateExpression).toContain('SET llmModel = :llmModel, llmUsagePolicyDecision = :policyDecision');
    expect(params.UpdateExpression).not.toContain('REMOVE llmUsagePolicyDecision');
    // ENG-669: a write that does not say who chose the model drops any stale source (same rule as the decision).
    expect(params.UpdateExpression).toContain('REMOVE llmModelSource');
    expect(params.ExpressionAttributeValues[':policyDecision']).toEqual(decision);
    expect(params.ExpressionAttributeValues[':llmModel']).toBe('openrouter/deepseek/deepseek-v4-flash');
  });
});
