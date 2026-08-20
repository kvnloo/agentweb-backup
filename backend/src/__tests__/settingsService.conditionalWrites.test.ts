/**
 * SettingsService.setSettingIfValueMatches / deleteSettingIfValueMatches (ENG-965) — the
 * compare-and-swap primitives oauthTokenSessionStore's one-time-use consume path relies on.
 * Same pattern as settingsService.setMembers.test.ts (claimSetMember/releaseSetMember):
 * mock the DynamoDB DocumentClient directly and assert on the real call shape, rather than
 * mocking settingsService itself (which is what every *Auth.test.ts file does, and which
 * never exercises this file's actual implementation).
 */
describe('SettingsService — compare-and-swap set/delete', () => {
  let settingsService: any;
  let mockPut: jest.Mock;
  let mockDelete: jest.Mock;
  let putPromise: jest.Mock;
  let deletePromise: jest.Mock;

  beforeAll(() => {
    jest.resetModules();

    putPromise = jest.fn();
    deletePromise = jest.fn();
    mockPut = jest.fn(() => ({ promise: putPromise }));
    mockDelete = jest.fn(() => ({ promise: deletePromise }));

    jest.doMock('aws-sdk', () => ({
      DynamoDB: {
        DocumentClient: jest.fn(() => ({
          put: mockPut,
          delete: mockDelete,
        })),
      },
    }));

    settingsService = require('../services/settingsService').settingsService;
  });

  beforeEach(() => jest.clearAllMocks());

  describe('setSettingIfValueMatches', () => {
    it('issues a conditional put, conditioned on the exact expected raw value', async () => {
      putPromise.mockResolvedValue({});

      await settingsService.setSettingIfValueMatches(
        'oauth_token_session_gmail_u1',
        '{"sessions":[]}',
        '{"sessions":[{"sessionId":"x"}]}',
        'Transient gmail OAuth token session',
        'system',
        1234567,
      );

      const params = mockPut.mock.calls[0][0];
      expect(params.Item.settingName).toBe('oauth_token_session_gmail_u1');
      expect(params.Item.settingValue).toBe('{"sessions":[]}');
      expect(params.Item.ttl).toBe(1234567);
      expect(params.ConditionExpression).toBe('settingValue = :expected');
      expect(params.ExpressionAttributeValues[':expected']).toBe('{"sessions":[{"sessionId":"x"}]}');
    });

    it('omits ttl entirely when not provided (no stray undefined attribute)', async () => {
      putPromise.mockResolvedValue({});
      await settingsService.setSettingIfValueMatches('k', 'new', 'old');
      const params = mockPut.mock.calls[0][0];
      expect('ttl' in params.Item).toBe(false);
    });

    it('rejects a non-finite ttl before ever calling DynamoDB', async () => {
      await expect(
        settingsService.setSettingIfValueMatches('k', 'new', 'old', undefined, 'system', NaN),
      ).rejects.toThrow(/finite epoch-second number/);
      expect(mockPut).not.toHaveBeenCalled();
    });

    it('propagates a ConditionalCheckFailedException so the caller can tell a lost race apart from any other failure', async () => {
      const conflict: any = new Error('The conditional request failed');
      conflict.code = 'ConditionalCheckFailedException';
      putPromise.mockRejectedValue(conflict);

      await expect(settingsService.setSettingIfValueMatches('k', 'new', 'old')).rejects.toMatchObject({
        code: 'ConditionalCheckFailedException',
      });
    });

    it('propagates a genuine store failure unchanged', async () => {
      putPromise.mockRejectedValue(new Error('ProvisionedThroughputExceededException'));
      await expect(settingsService.setSettingIfValueMatches('k', 'new', 'old')).rejects.toThrow(
        'ProvisionedThroughputExceededException',
      );
    });
  });

  describe('deleteSettingIfValueMatches', () => {
    it('issues a conditional delete, conditioned on the exact expected raw value', async () => {
      deletePromise.mockResolvedValue({});

      await settingsService.deleteSettingIfValueMatches(
        'oauth_token_session_outlook_u1',
        '{"sessions":[{"sessionId":"x"}]}',
      );

      const params = mockDelete.mock.calls[0][0];
      expect(params.Key).toEqual({ settingName: 'oauth_token_session_outlook_u1' });
      expect(params.ConditionExpression).toBe('settingValue = :expected');
      expect(params.ExpressionAttributeValues[':expected']).toBe('{"sessions":[{"sessionId":"x"}]}');
    });

    it('propagates a ConditionalCheckFailedException (row already changed/gone) rather than swallowing it', async () => {
      const conflict: any = new Error('The conditional request failed');
      conflict.code = 'ConditionalCheckFailedException';
      deletePromise.mockRejectedValue(conflict);

      await expect(settingsService.deleteSettingIfValueMatches('k', 'old')).rejects.toMatchObject({
        code: 'ConditionalCheckFailedException',
      });
    });

    it('propagates a genuine store failure unchanged', async () => {
      deletePromise.mockRejectedValue(new Error('dynamo down'));
      await expect(settingsService.deleteSettingIfValueMatches('k', 'old')).rejects.toThrow('dynamo down');
    });
  });
});
