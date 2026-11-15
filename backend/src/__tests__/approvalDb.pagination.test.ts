const mockQuery = jest.fn();
jest.mock('aws-sdk', () => ({
  __esModule: true,
  default: { DynamoDB: { DocumentClient: jest.fn().mockImplementation(() => ({
    query: (params: any) => ({ promise: () => mockQuery(params) }),
  })) } },
}));

import { approvalDb } from '../services/approvalDb';
import { getWorkspaceApprovalStatusByUrl, resolveWorkspaceMembers } from '../utils/workspaceAssets';

beforeEach(() => mockQuery.mockReset());

it('reads all pages newest-first with the same user key and continuation', async () => {
  mockQuery.mockResolvedValueOnce({ Items: [{ assetUrl: 'new' }], LastEvaluatedKey: { assetUrl: 'new' } })
    .mockResolvedValueOnce({ Items: [{ assetUrl: 'old', status: 'approved' }] });
  expect((await approvalDb.getApprovalsByUserId('alice')).map(a => a.assetUrl)).toEqual(['new', 'old']);
  expect(mockQuery.mock.calls[1][0]).toMatchObject({
    IndexName: 'UserApprovalsIndex', ExclusiveStartKey: { assetUrl: 'new' },
    KeyConditionExpression: 'userId = :userId', ExpressionAttributeValues: { ':userId': 'alice' }, ScanIndexForward: false,
  });
});

it('continues through an empty intermediate page', async () => {
  mockQuery.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: { assetUrl: 'empty' } })
    .mockResolvedValueOnce({ LastEvaluatedKey: { assetUrl: 'also-empty' } })
    .mockResolvedValueOnce({ Items: [{ assetUrl: 'old' }] });
  expect(await approvalDb.getApprovalsByUserId('alice')).toEqual([{ assetUrl: 'old' }]);
  expect(mockQuery).toHaveBeenCalledTimes(3);
});

it('fills an explicit limit across pages without returning or fetching extra rows', async () => {
  mockQuery.mockResolvedValueOnce({ Items: [{ assetUrl: 'new' }], LastEvaluatedKey: { assetUrl: 'new' } })
    .mockResolvedValueOnce({ Items: [{ assetUrl: 'old' }], LastEvaluatedKey: { assetUrl: 'old' } });
  expect(await approvalDb.getApprovalsByUserId('alice', 2)).toHaveLength(2);
  expect(mockQuery.mock.calls.map(([p]) => p.Limit)).toEqual([2, 1]);
  expect(mockQuery).toHaveBeenCalledTimes(2);
});

it('does not fetch another page when the first page satisfies the limit', async () => {
  mockQuery.mockResolvedValue({ Items: [{ assetUrl: 'new' }], LastEvaluatedKey: { assetUrl: 'new' } });
  expect(await approvalDb.getApprovalsByUserId('alice', 1)).toEqual([{ assetUrl: 'new' }]);
  expect(mockQuery).toHaveBeenCalledTimes(1);
});

it('keeps page-two approvals visible while excluding foreign-org members', async () => {
  mockQuery.mockImplementation(async (p: any) => {
    const id = p.ExpressionAttributeValues[':userId'];
    if (!p.ExclusiveStartKey) return { Items: [], LastEvaluatedKey: { assetUrl: id } };
    return { Items: [{ assetUrl: `${id}/old.png`, status: 'approved' }] };
  });
  const members = await resolveWorkspaceMembers({ userId: 'alice', orgId: 'a' }, {
    getOrgMembers: async () => [{ userId: 'alice', orgId: 'a' }, { userId: 'bob', orgId: 'a' }, { userId: 'mallory', orgId: 'b' }],
  });
  const map = await getWorkspaceApprovalStatusByUrl(members, id => approvalDb.getApprovalsByUserId(id));
  expect(map).toEqual({ 'alice/old.png': 'approved', 'bob/old.png': 'approved' });
  expect(mockQuery.mock.calls.map(([p]) => p.ExpressionAttributeValues[':userId']).sort()).toEqual(['alice', 'alice', 'bob', 'bob']);
});

it('queries only self when the caller has no organization', async () => {
  mockQuery.mockResolvedValue({ Items: [{ assetUrl: 'own', status: 'approved' }] });
  const getOrgMembers = jest.fn();
  const members = await resolveWorkspaceMembers({ userId: 'alice' }, { getOrgMembers });
  expect(await getWorkspaceApprovalStatusByUrl(members, id => approvalDb.getApprovalsByUserId(id))).toEqual({ own: 'approved' });
  expect(getOrgMembers).not.toHaveBeenCalled();
  expect(mockQuery).toHaveBeenCalledTimes(1);
  expect(mockQuery.mock.calls[0][0].ExpressionAttributeValues).toEqual({ ':userId': 'alice' });
});
