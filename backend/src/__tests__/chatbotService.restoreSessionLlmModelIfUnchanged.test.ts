/**
 * ENG-903: conditional restore of a plan-launch model write. Existing attributes, a
 * ConditionExpression only - no schema change.
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

describe('chatbotDb.restoreSessionLlmModelIfUnchanged', () => {
  const DECISION = { requestedModel: 'old-m', modelSelection: 'honored' } as any;
  beforeEach(() => {
    jest.clearAllMocks();
    updatePromiseMock.mockResolvedValue({ Attributes: {} });
  });

  it('previous model + decision: conditional SET of both, exact expression', async () => {
    await expect(chatbotDb.restoreSessionLlmModelIfUnchanged('s1', 'plan-m', { llmModel: 'old-m', llmUsagePolicyDecision: DECISION })).resolves.toBe(true);
    const p = updatePromiseMock.mock.calls[0][0];
    expect(p.Key).toEqual({ sessionId: 's1' });
    expect(p.ConditionExpression).toBe('llmModel = :planModel');
    expect(p.UpdateExpression).toBe('SET llmModel = :prevModel, llmUsagePolicyDecision = :prevDecision, adminListPartition = :adminListPartition');
    expect(p.ExpressionAttributeValues).toEqual({ ':planModel': 'plan-m', ':prevModel': 'old-m', ':prevDecision': DECISION, ':adminListPartition': 'all' });
  });

  it('previous model, no decision: decision is removed', async () => {
    await chatbotDb.restoreSessionLlmModelIfUnchanged('s1', 'plan-m', { llmModel: 'old-m' });
    const p = updatePromiseMock.mock.calls[0][0];
    expect(p.ConditionExpression).toBe('llmModel = :planModel');
    expect(p.UpdateExpression).toBe('SET llmModel = :prevModel, adminListPartition = :adminListPartition REMOVE llmUsagePolicyDecision');
    expect(p.ExpressionAttributeValues).toEqual({ ':planModel': 'plan-m', ':prevModel': 'old-m', ':adminListPartition': 'all' });
  });

  it('NO previous explicit model: llmModel is REMOVEd (session returns to its prior state, not a stored default)', async () => {
    await chatbotDb.restoreSessionLlmModelIfUnchanged('s1', 'plan-m', {});
    const p = updatePromiseMock.mock.calls[0][0];
    expect(p.ConditionExpression).toBe('llmModel = :planModel');
    expect(p.UpdateExpression).toBe('SET adminListPartition = :adminListPartition REMOVE llmModel, llmUsagePolicyDecision');
    expect(p.ExpressionAttributeValues).toEqual({ ':planModel': 'plan-m', ':adminListPartition': 'all' });
  });

  it('ConditionalCheckFailed resolves false (someone changed it) and does not throw or log an error', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    updatePromiseMock.mockRejectedValueOnce(Object.assign(new Error('cond'), { code: 'ConditionalCheckFailedException' }));
    await expect(chatbotDb.restoreSessionLlmModelIfUnchanged('s1', 'plan-m', { llmModel: 'old-m' })).resolves.toBe(false);
    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('any other failure rethrows', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    updatePromiseMock.mockRejectedValueOnce(new Error('throttled'));
    await expect(chatbotDb.restoreSessionLlmModelIfUnchanged('s1', 'plan-m', { llmModel: 'old-m' })).rejects.toThrow('throttled');
    errSpy.mockRestore();
  });
});
