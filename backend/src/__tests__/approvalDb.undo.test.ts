/**
 * approvalDb undo operations — the writes that take back an approval that was never
 * delivered, without trampling a concurrent request or a customer's tap (ENG-273).
 */
const mockPut = jest.fn();
const mockDelete = jest.fn();
jest.mock('aws-sdk', () => ({
  __esModule: true,
  default: {
    DynamoDB: {
      DocumentClient: jest.fn().mockImplementation(() => ({
        put: (p: any) => ({ promise: () => mockPut(p) }),
        delete: (p: any) => ({ promise: () => mockDelete(p) }),
      })),
    },
  },
}));

import { approvalDb } from '../services/approvalDb';

const ASSET = 'https://assets.example.com/a.png';
const conditionalFailure = () => Object.assign(new Error('cond'), { code: 'ConditionalCheckFailedException' });
const earlier: any = { assetUrl: ASSET, userId: 'u1', status: 'approved', createdAt: 'T0' };

beforeEach(() => {
  jest.resetAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

describe('restoreApproval', () => {
  it('only overwrites the record this request wrote, and only while it is still pending', async () => {
    mockPut.mockResolvedValue({});
    await approvalDb.restoreApproval(earlier, 'T-OURS');
    const p = mockPut.mock.calls[0][0];
    expect(p.Item).toBe(earlier);
    expect(p.ConditionExpression).toContain('createdAt = :ours');
    expect(p.ConditionExpression).toContain('#status = :pending');
    expect(p.ExpressionAttributeValues).toEqual({ ':ours': 'T-OURS', ':pending': 'pending' });
  });

  it('is a silent no-op when a newer request or a tap changed the record', async () => {
    mockPut.mockRejectedValue(conditionalFailure());
    await expect(approvalDb.restoreApproval(earlier, 'T-OURS')).resolves.toBeUndefined();
  });

  it('surfaces a real storage error', async () => {
    mockPut.mockRejectedValue(new Error('throttled'));
    await expect(approvalDb.restoreApproval(earlier, 'T-OURS')).rejects.toThrow('Failed to restore approval');
  });
});

describe('deleteApprovalIfUnanswered', () => {
  it('deletes only our own record, and only while it is still pending', async () => {
    mockDelete.mockResolvedValue({});
    await approvalDb.deleteApprovalIfUnanswered(ASSET, 'T-OURS');
    const p = mockDelete.mock.calls[0][0];
    expect(p.Key).toEqual({ assetUrl: ASSET });
    expect(p.ConditionExpression).toContain('createdAt = :ours');
    expect(p.ConditionExpression).toContain('#status = :pending');
    expect(p.ExpressionAttributeValues[':ours']).toBe('T-OURS');
  });

  it('leaves a concurrent request’s record alone', async () => {
    mockDelete.mockRejectedValue(conditionalFailure());
    await expect(approvalDb.deleteApprovalIfUnanswered(ASSET, 'T-OURS')).resolves.toBeUndefined();
  });

  it('surfaces a real storage error', async () => {
    mockDelete.mockRejectedValue(new Error('throttled'));
    await expect(approvalDb.deleteApprovalIfUnanswered(ASSET, 'T-OURS')).rejects.toThrow('Failed to delete approval');
  });
});
