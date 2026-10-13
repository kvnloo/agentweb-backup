/**
 * approvalDb.answerIfOpen — the atomic "answer once" write behind WhatsApp taps (ENG-273).
 */
const mockUpdate = jest.fn();
const mockGet = jest.fn();
jest.mock('aws-sdk', () => ({
  __esModule: true,
  default: {
    DynamoDB: {
      DocumentClient: jest.fn().mockImplementation(() => ({
        update: (p: any) => ({ promise: () => mockUpdate(p) }),
        get: (p: any) => ({ promise: () => mockGet(p) }),
      })),
    },
  },
}));

import { approvalDb } from '../services/approvalDb';

const ASSET = 'https://assets.example.com/a.png';
const conditionalFailure = () => Object.assign(new Error('cond'), { code: 'ConditionalCheckFailedException' });

beforeEach(() => {
  jest.resetAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

describe('answerIfOpen', () => {
  it('answers an open approval and returns the updated record', async () => {
    mockUpdate.mockResolvedValue({ Attributes: { assetUrl: ASSET, status: 'approved' } });
    const result = await approvalDb.answerIfOpen(ASSET, 'approved', 'whatsapp:u1');
    expect(result).toEqual({ answered: true, approval: { assetUrl: ASSET, status: 'approved' } });
  });

  it('writes the condition in the same operation as the update', async () => {
    mockUpdate.mockResolvedValue({ Attributes: {} });
    await approvalDb.answerIfOpen(ASSET, 'rejected', 'whatsapp:u1');
    const params = mockUpdate.mock.calls[0][0];
    // A separate read-then-write would let two taps both pass the read.
    expect(params.ConditionExpression).toContain('attribute_exists(assetUrl)');
    expect(params.ConditionExpression).toContain('#status = :pending');
    expect(params.ExpressionAttributeValues[':status']).toBe('rejected');
    expect(params.ExpressionAttributeValues[':pending']).toBe('pending');
  });

  it('requires the record to belong to the stated owner when one is given', async () => {
    mockUpdate.mockResolvedValue({ Attributes: {} });
    await approvalDb.answerIfOpen(ASSET, 'approved', 'whatsapp:u1', 'u1');
    const params = mockUpdate.mock.calls[0][0];
    expect(params.ConditionExpression).toContain('userId = :owner');
    expect(params.ExpressionAttributeValues[':owner']).toBe('u1');
  });

  it('adds no owner condition when none is given (portal and Slack paths unchanged)', async () => {
    mockUpdate.mockResolvedValue({ Attributes: {} });
    await approvalDb.answerIfOpen(ASSET, 'approved', 'whatsapp:u1');
    const params = mockUpdate.mock.calls[0][0];
    expect(params.ConditionExpression).not.toContain('userId');
    expect(params.ExpressionAttributeValues).not.toHaveProperty(':owner');
  });

  it('treats needs_changes as still open, as Slack does', async () => {
    mockUpdate.mockResolvedValue({ Attributes: {} });
    await approvalDb.answerIfOpen(ASSET, 'approved', 'whatsapp:u1');
    const params = mockUpdate.mock.calls[0][0];
    expect(params.ConditionExpression).toContain(':needsChanges');
    expect(params.ExpressionAttributeValues[':needsChanges']).toBe('needs_changes');
  });

  it('reports the standing verdict when the approval was already answered', async () => {
    mockUpdate.mockRejectedValue(conditionalFailure());
    mockGet.mockResolvedValue({ Item: { assetUrl: ASSET, status: 'approved' } });
    await expect(approvalDb.answerIfOpen(ASSET, 'rejected', 'whatsapp:u1')).resolves.toEqual({
      answered: false,
      current: 'approved',
    });
  });

  it('reports null — and creates nothing — when the approval does not exist', async () => {
    mockUpdate.mockRejectedValue(conditionalFailure());
    mockGet.mockResolvedValue({});
    await expect(approvalDb.answerIfOpen(ASSET, 'approved', 'whatsapp:u1')).resolves.toEqual({
      answered: false,
      current: null,
    });
  });

  it('reports the standing verdict as UNKNOWN, not gone, when the follow-up read fails', async () => {
    // null means the approval does not exist; a failed read must not be reported as that.
    mockUpdate.mockRejectedValue(conditionalFailure());
    mockGet.mockRejectedValue(new Error('dynamo down'));
    await expect(approvalDb.answerIfOpen(ASSET, 'approved', 'whatsapp:u1')).resolves.toEqual({
      answered: false,
      current: 'unknown',
    });
  });

  it('throws on a real failure rather than pretending the approval was answered', async () => {
    mockUpdate.mockRejectedValue(Object.assign(new Error('x'), { code: 'ProvisionedThroughputExceededException' }));
    await expect(approvalDb.answerIfOpen(ASSET, 'approved', 'whatsapp:u1')).rejects.toThrow(
      'Failed to answer approval',
    );
  });
});
