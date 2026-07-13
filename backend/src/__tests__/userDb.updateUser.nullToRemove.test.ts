// Tests for userDb.updateUser: null values must produce a REMOVE clause, not
// SET ... = null (ENG-288 follow-up).
//
// orgId is the key attribute for the OrgIdIndex GSI. org.ts's leave/removeMember/
// deleteOrg routes clear membership via updateUser(id, { orgId: null, orgRole: null }).
// DynamoDB rejects SET-ing a GSI key attribute to a NULL type with:
//   ValidationException: Type mismatch for Index Key orgId Expected: S Actual: NULL
// which made every leave/remove/delete-org call 500 and left orgId in place —
// silently breaking the auto-revocation guarantee the ENG-288 tier-inheritance
// fix depends on (a departed member kept the owner's tier forever, since they
// could never actually leave).

jest.mock('aws-sdk', () => {
  const mockDynamoDB = {
    get: jest.fn(),
    query: jest.fn(),
    update: jest.fn(),
  };

  const mockS3 = {
    putObject: jest.fn().mockReturnThis(),
    getObject: jest.fn().mockReturnThis(),
    deleteObject: jest.fn().mockReturnThis(),
    promise: jest.fn().mockResolvedValue({}),
  };

  return {
    DynamoDB: {
      DocumentClient: jest.fn(() => mockDynamoDB),
    },
    S3: jest.fn(() => mockS3),
    config: {
      update: jest.fn(),
    },
  };
});

import AWS from 'aws-sdk';
import { userDb } from '../services/db';

describe('userDb.updateUser — null fields must REMOVE, not SET null', () => {
  let mockDynamoDB: any;

  beforeEach(() => {
    jest.clearAllMocks();
    const DocumentClient = AWS.DynamoDB.DocumentClient as any;
    mockDynamoDB = new DocumentClient();
    mockDynamoDB.query.mockReturnValue({
      promise: jest.fn().mockResolvedValue({
        Items: [{ userId: 'member-1', email: 'member@example.com', orgId: 'org-1', orgRole: 'member' }],
      }),
    });
  });

  it('should throw when the user does not exist', async () => {
    mockDynamoDB.query.mockReturnValueOnce({
      promise: jest.fn().mockResolvedValue({ Items: [] }),
    });

    await expect(userDb.updateUser('missing-user', { orgId: null as any })).rejects.toThrow();
    expect(mockDynamoDB.update).not.toHaveBeenCalled();
  });

  it('should return the user unchanged when updates is an empty object', async () => {
    const result = await userDb.updateUser('member-1', {});

    expect(mockDynamoDB.update).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({ userId: 'member-1' }));
  });

  it('should ignore undefined fields (neither SET nor REMOVE)', async () => {
    mockDynamoDB.update.mockReturnValue({
      promise: jest.fn().mockResolvedValue({ Attributes: { userId: 'member-1', displayName: 'New Name' } }),
    });

    await userDb.updateUser('member-1', { displayName: 'New Name', orgId: undefined as any });

    const call = mockDynamoDB.update.mock.calls[0][0];
    expect(call.UpdateExpression).not.toMatch(/orgId/);
    expect(call.ExpressionAttributeNames).not.toHaveProperty('#orgId');
  });

  it('should REMOVE orgId and orgRole (both null) instead of SET-ing them to null — leave-org path', async () => {
    mockDynamoDB.update.mockReturnValue({
      promise: jest.fn().mockResolvedValue({ Attributes: { userId: 'member-1', email: 'member@example.com' } }),
    });

    await userDb.updateUser('member-1', { orgId: null as any, orgRole: null as any });

    const call = mockDynamoDB.update.mock.calls[0][0];
    expect(call.UpdateExpression).toBe('REMOVE #orgId, #orgRole');
    expect(call.ExpressionAttributeNames).toEqual({ '#orgId': 'orgId', '#orgRole': 'orgRole' });
    // No SET clause at all here, so ExpressionAttributeValues must be omitted
    // entirely — DynamoDB rejects an empty ExpressionAttributeValues map.
    expect(call.ExpressionAttributeValues).toBeUndefined();
    expect(call.Key).toEqual({ email: 'member@example.com' });
  });

  it('should combine SET and REMOVE in one UpdateExpression when both null and non-null fields are updated', async () => {
    mockDynamoDB.update.mockReturnValue({
      promise: jest.fn().mockResolvedValue({ Attributes: { userId: 'member-1' } }),
    });

    await userDb.updateUser('member-1', { orgId: null as any, displayName: 'Solo Again' } as any);

    const call = mockDynamoDB.update.mock.calls[0][0];
    expect(call.UpdateExpression).toBe('SET #displayName = :displayName REMOVE #orgId');
    expect(call.ExpressionAttributeValues).toEqual({ ':displayName': 'Solo Again' });
  });

  it('should still SET non-null fields as before (no regression)', async () => {
    mockDynamoDB.update.mockReturnValue({
      promise: jest.fn().mockResolvedValue({ Attributes: { userId: 'member-1', orgId: 'org-2', orgRole: 'owner' } }),
    });

    await userDb.updateUser('member-1', { orgId: 'org-2', orgRole: 'owner' });

    const call = mockDynamoDB.update.mock.calls[0][0];
    expect(call.UpdateExpression).toBe('SET #orgId = :orgId, #orgRole = :orgRole');
    expect(call.ExpressionAttributeValues).toEqual({ ':orgId': 'org-2', ':orgRole': 'owner' });
  });
});
