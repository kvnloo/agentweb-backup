/**
 * SettingsService.claimSetMember / releaseSetMember — the atomic per-item claim
 * behind ship-notify idempotency. Claim = DynamoDB ADD on a string set with
 * ReturnValues UPDATED_OLD (true only when the member was not already present);
 * release = DELETE from the set. No read-modify-write anywhere.
 */
describe('SettingsService — claim/release set member', () => {
  let settingsService: any;
  let mockUpdate: jest.Mock;
  let mockPromise: jest.Mock;

  beforeAll(() => {
    jest.resetModules();

    mockPromise = jest.fn();
    mockUpdate = jest.fn(() => ({ promise: mockPromise }));

    jest.doMock('aws-sdk', () => ({
      DynamoDB: {
        DocumentClient: jest.fn(() => ({
          update: mockUpdate,
          createSet: (arr: string[]) => ({ values: arr, type: 'String' }),
        })),
      },
    }));

    settingsService = require('../services/settingsService').settingsService;
  });

  beforeEach(() => jest.clearAllMocks());

  it('first claim (no attribute yet) -> true, via an ADD update with UPDATED_OLD', async () => {
    mockPromise.mockResolvedValue({ Attributes: {} });
    await expect(settingsService.claimSetMember('ship-notify:post-1', 'u@e.com')).resolves.toBe(true);
    const params = mockUpdate.mock.calls[0][0];
    expect(params.Key).toEqual({ settingName: 'ship-notify:post-1' });
    expect(params.UpdateExpression).toContain('ADD settingMembers');
    expect(params.ReturnValues).toBe('UPDATED_OLD');
    expect(params.ExpressionAttributeValues[':m'].values).toEqual(['u@e.com']);
  });

  it('member already in the set -> false (lost the claim)', async () => {
    mockPromise.mockResolvedValue({ Attributes: { settingMembers: { values: ['u@e.com', 'x@e.com'] } } });
    await expect(settingsService.claimSetMember('ship-notify:post-1', 'u@e.com')).resolves.toBe(false);
  });

  it('other members present but not this one -> true', async () => {
    mockPromise.mockResolvedValue({ Attributes: { settingMembers: { values: ['other@e.com'] } } });
    await expect(settingsService.claimSetMember('ship-notify:post-1', 'u@e.com')).resolves.toBe(true);
  });

  it('release issues a DELETE-from-set update', async () => {
    mockPromise.mockResolvedValue({});
    await settingsService.releaseSetMember('ship-notify:post-1', 'u@e.com');
    const params = mockUpdate.mock.calls[0][0];
    expect(params.UpdateExpression).toContain('DELETE settingMembers');
    expect(params.ExpressionAttributeValues[':m'].values).toEqual(['u@e.com']);
  });

  it('dynamo failure propagates (caller — shipNotifyService — owns the catch)', async () => {
    mockPromise.mockRejectedValue(new Error('dynamo down'));
    await expect(settingsService.claimSetMember('k', 'm')).rejects.toThrow('dynamo down');
  });
});
