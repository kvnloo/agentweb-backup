/**
 * setSetting()'s optional DynamoDB TTL attribute.
 *
 * Bug context (Greptile, ENG-266 PR review): oauthTokenSessionStore rows hold live
 * OAuth refresh tokens and are only pruned by *application code* on the next read/write
 * for that same user+provider. If a user abandons the flow and never retries, the row
 * (and its refresh token) sits in DynamoDB forever — there was no way to ask DynamoDB
 * itself to expire the row.
 *
 * Fix: setSetting() accepts an optional epoch-second `ttl`, written as the `ttl`
 * attribute DynamoDB's Time To Live feature is configured against. Omitting it (every
 * existing caller) preserves current behavior exactly — no attribute is written, so
 * DynamoDB never auto-expires those rows, same as today.
 */

let mockDbPut: jest.Mock;
let mockDbPromise: jest.Mock;
let settingsService: any;

beforeAll(() => {
  jest.resetModules();

  mockDbPromise = jest.fn().mockResolvedValue({});
  mockDbPut = jest.fn(() => ({ promise: mockDbPromise }));

  jest.doMock('aws-sdk', () => ({
    DynamoDB: {
      DocumentClient: jest.fn(() => ({
        put: mockDbPut,
      })),
    },
  }));

  settingsService = require('../services/settingsService').settingsService;
});

beforeEach(() => jest.clearAllMocks());

describe('setSetting — ttl parameter', () => {
  it('does not include a ttl attribute when omitted (existing callers unaffected)', async () => {
    await settingsService.setSetting('some_setting', 'value', 'desc', 'system');
    const item = mockDbPut.mock.calls[0][0].Item;
    expect(item.ttl).toBeUndefined();
    expect('ttl' in item).toBe(false);
  });

  it('does not include a ttl attribute when explicitly undefined', async () => {
    await settingsService.setSetting('some_setting', 'value', 'desc', 'system', undefined);
    const item = mockDbPut.mock.calls[0][0].Item;
    expect('ttl' in item).toBe(false);
  });

  it('writes a numeric epoch-second ttl attribute when provided', async () => {
    const ttl = Math.floor(Date.now() / 1000) + 600;
    await settingsService.setSetting('oauth_token_session_gmail_u1', '{}', 'desc', 'system', ttl);
    const item = mockDbPut.mock.calls[0][0].Item;
    expect(item.ttl).toBe(ttl);
  });

  it('rejects a non-finite ttl rather than writing garbage DynamoDB would reject', async () => {
    await expect(
      settingsService.setSetting('oauth_token_session_gmail_u1', '{}', 'desc', 'system', NaN),
    ).rejects.toThrow();
    expect(mockDbPut).not.toHaveBeenCalled();
  });
});
