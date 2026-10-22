/**
 * approvalDb undo operations — the writes that take back an approval that was never
 * delivered, without trampling a concurrent request or a customer's tap (ENG-273).
 */
const mockPut = jest.fn();
const mockDelete = jest.fn();
const mockQuery = jest.fn();
jest.mock('aws-sdk', () => ({
  __esModule: true,
  default: {
    DynamoDB: {
      DocumentClient: jest.fn().mockImplementation(() => ({
        put: (p: any) => ({ promise: () => mockPut(p) }),
        delete: (p: any) => ({ promise: () => mockDelete(p) }),
        query: (p: any) => ({ promise: () => mockQuery(p) }),
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

describe('getPendingApprovalsByUserId', () => {
  it('follows the index to the end instead of stopping at the first page', async () => {
    mockQuery
      .mockResolvedValueOnce({ Items: [{ assetUrl: 'a' }], LastEvaluatedKey: { k: 1 } })
      .mockResolvedValueOnce({ Items: [{ assetUrl: 'b' }], LastEvaluatedKey: { k: 2 } })
      .mockResolvedValueOnce({ Items: [{ assetUrl: 'c' }] });
    const items = await approvalDb.getPendingApprovalsByUserId('u1');
    expect(items.map((i: any) => i.assetUrl)).toEqual(['a', 'b', 'c']);
    expect(mockQuery).toHaveBeenCalledTimes(3);
    expect(mockQuery.mock.calls[1][0].ExclusiveStartKey).toEqual({ k: 1 });
    expect(mockQuery.mock.calls[2][0].ExclusiveStartKey).toEqual({ k: 2 });
  });

  it('asks the index only for this user\'s pending rows (filter applied before paging)', async () => {
    mockQuery.mockResolvedValue({ Items: [] });
    await approvalDb.getPendingApprovalsByUserId('u1');
    const p = mockQuery.mock.calls[0][0];
    expect(p.IndexName).toBe('UserApprovalsIndex');
    expect(p.FilterExpression).toBe('#status = :pending');
    expect(p.ExpressionAttributeValues).toEqual({ ':userId': 'u1', ':pending': 'pending' });
  });

  it('surfaces a storage error so the STOP can be redelivered', async () => {
    mockQuery.mockRejectedValue(new Error('throttled'));
    await expect(approvalDb.getPendingApprovalsByUserId('u1')).rejects.toThrow('Failed to get pending approvals');
  });
});
