// Tests for userDb.getRegistrationStatusByEmails — batch email→registration
// status lookup over AW-Users (email is the table's HASH primary key, so a
// BatchGetItem keyed on { email } is exact and efficient).
//
// Backs the "signup/premium data not joined" funnel gap: the funnel report can
// hand a list of CRM lead emails to this method and learn which ones registered
// and which became paying/premium users — without duplicating user data onto
// lead records.

const batchGetPromiseMock = jest.fn();
const batchGetSpy: jest.Mock = jest.fn(() => ({ promise: batchGetPromiseMock }));

jest.mock('aws-sdk', () => ({
  config: { update: jest.fn() },
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      query: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({ Items: [] }) })),
      get: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
      put: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
      update: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
      delete: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
      scan: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({ Items: [] }) })),
      batchGet: batchGetSpy,
      batchWrite: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
    })),
  },
  S3: jest.fn(() => ({
    upload: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({ Location: '', Key: '' }) }),
    getObject: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
    getSignedUrl: jest.fn(),
  })),
  SecretsManager: jest.fn(() => ({
    getSecretValue: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({ SecretString: '{}' }) }),
  })),
}));

import { userDb } from '../services/db';

const USERS_TABLE = 'AW-Users';

describe('userDb.getRegistrationStatusByEmails', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns [] without calling DynamoDB when emails is empty', async () => {
    const result = await userDb.getRegistrationStatusByEmails([]);
    expect(result).toEqual([]);
    expect(batchGetSpy).not.toHaveBeenCalled();
  });

  it('marks a registered paying user and an unregistered email correctly', async () => {
    batchGetPromiseMock.mockResolvedValueOnce({
      Responses: {
        [USERS_TABLE]: [
          {
            email: 'paid@x.com',
            userId: 'u-1',
            createdAt: '2026-01-01T00:00:00Z',
            subscription_status: 'active',
            subscriptionType: 'Pro',
          },
        ],
      },
    });

    const result = await userDb.getRegistrationStatusByEmails(['paid@x.com', 'ghost@x.com']);

    const byEmail = Object.fromEntries(result.map((r) => [r.email, r]));
    expect(byEmail['paid@x.com']).toEqual({
      email: 'paid@x.com',
      registered: true,
      userId: 'u-1',
      createdAt: '2026-01-01T00:00:00Z',
      subscriptionType: 'Pro',
      subscriptionStatus: 'active',
      isPremium: true,
    });
    expect(byEmail['ghost@x.com']).toEqual({
      email: 'ghost@x.com',
      registered: false,
      isPremium: false,
    });
  });

  it('treats trialing as premium and canceled as registered-but-not-premium', async () => {
    batchGetPromiseMock.mockResolvedValueOnce({
      Responses: {
        [USERS_TABLE]: [
          { email: 'trial@x.com', userId: 'u-2', subscription_status: 'trialing' },
          { email: 'churned@x.com', userId: 'u-3', subscription_status: 'canceled' },
          { email: 'free@x.com', userId: 'u-4' },
        ],
      },
    });

    const result = await userDb.getRegistrationStatusByEmails([
      'trial@x.com',
      'churned@x.com',
      'free@x.com',
    ]);
    const byEmail = Object.fromEntries(result.map((r) => [r.email, r]));

    expect(byEmail['trial@x.com'].isPremium).toBe(true);
    expect(byEmail['churned@x.com']).toMatchObject({ registered: true, isPremium: false });
    expect(byEmail['free@x.com']).toMatchObject({ registered: true, isPremium: false });
  });

  it('lowercases and de-duplicates emails before querying (matches base-table key casing)', async () => {
    batchGetPromiseMock.mockResolvedValueOnce({
      Responses: { [USERS_TABLE]: [{ email: 'a@x.com', userId: 'u-1' }] },
    });

    await userDb.getRegistrationStatusByEmails(['A@X.com', 'a@x.com', '  a@x.com  ']);

    expect(batchGetSpy).toHaveBeenCalledTimes(1);
    const keys = (batchGetSpy.mock.calls[0][0] as any).RequestItems[USERS_TABLE].Keys;
    expect(keys).toEqual([{ email: 'a@x.com' }]);
  });

  it('excludes soft-deleted (tombstoned) users — they read as unregistered', async () => {
    batchGetPromiseMock.mockResolvedValueOnce({
      Responses: {
        [USERS_TABLE]: [
          { email: 'gone@x.com', userId: 'deleted_u-9', subscription_status: 'active' },
        ],
      },
    });

    const result = await userDb.getRegistrationStatusByEmails(['gone@x.com']);
    expect(result[0]).toMatchObject({ email: 'gone@x.com', registered: false, isPremium: false });
  });

  it('chunks into multiple BatchGetItem calls beyond the per-batch cap', async () => {
    const emails = Array.from({ length: 60 }, (_, i) => `u${i + 1}@x.com`);
    batchGetPromiseMock
      .mockResolvedValueOnce({ Responses: { [USERS_TABLE]: [] } })
      .mockResolvedValueOnce({ Responses: { [USERS_TABLE]: [] } })
      .mockResolvedValueOnce({ Responses: { [USERS_TABLE]: [] } });

    const result = await userDb.getRegistrationStatusByEmails(emails);

    expect(batchGetSpy).toHaveBeenCalledTimes(3);
    expect(result).toHaveLength(60);
    expect(result.every((r) => r.registered === false)).toBe(true);
  });

  it('ignores blank/invalid email entries', async () => {
    batchGetPromiseMock.mockResolvedValueOnce({
      Responses: { [USERS_TABLE]: [{ email: 'real@x.com', userId: 'u-1' }] },
    });

    const result = await userDb.getRegistrationStatusByEmails(['', '   ', 'real@x.com']);
    expect(result).toHaveLength(1);
    expect(result[0].email).toBe('real@x.com');
  });
});
