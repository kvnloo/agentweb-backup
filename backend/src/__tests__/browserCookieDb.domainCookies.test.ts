import AWS from 'aws-sdk';

jest.mock('aws-sdk', () => {
  const mockDynamoDB = {
    get: jest.fn(),
    put: jest.fn(),
    delete: jest.fn(),
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
    config: { update: jest.fn() },
  };
});

jest.mock('../utils/crypto', () => ({
  encryptPassword: jest.fn((plaintext: string, userId: string) => `ENC(${userId}:${plaintext})`),
  decryptPassword: jest.fn((ciphertext: string) => {
    const match = /^ENC\([^:]+:(.*)\)$/s.exec(ciphertext);
    if (!match) throw new Error('Failed to decrypt password');
    return { password: match[1], userId: 'irrelevant' };
  }),
}));

import { browserCookieDb } from '../services/db';

describe('browserCookieDb — manual per-domain cookie import', () => {
  let mockDynamoDB: any;

  beforeEach(() => {
    jest.clearAllMocks();
    const DocumentClient = AWS.DynamoDB.DocumentClient as any;
    mockDynamoDB = new DocumentClient();
  });

  const cookies = [{ name: 'session', value: 'abc123', domain: '.rankai.ai', path: '/', secure: true, expires: 9999999999 }];

  describe('saveDomainCookies', () => {
    it('encrypts the cookie array and writes it with a cookieCount', async () => {
      mockDynamoDB.put.mockReturnValue({ promise: jest.fn().mockResolvedValue({}) });

      await browserCookieDb.saveDomainCookies('user-1', 'rankai.ai', cookies);

      expect(mockDynamoDB.put).toHaveBeenCalledWith(
        expect.objectContaining({
          TableName: expect.stringContaining('AW-BrowserCookies'),
          Item: expect.objectContaining({
            userId: 'user-1',
            domain: 'rankai.ai',
            cookieCount: 1,
            encryptedCookies: `ENC(user-1:${JSON.stringify(cookies)})`,
          }),
        })
      );
    });

    it('derives expiresAt from the earliest cookie expiry in the set', async () => {
      mockDynamoDB.put.mockReturnValue({ promise: jest.fn().mockResolvedValue({}) });
      const nowSeconds = Math.floor(Date.now() / 1000);
      const twoCookies = [
        { name: 'a', value: '1', domain: '.rankai.ai', path: '/', secure: true, expires: nowSeconds + 1000 },
        { name: 'b', value: '2', domain: '.rankai.ai', path: '/', secure: true, expires: nowSeconds + 500 },
      ];

      await browserCookieDb.saveDomainCookies('user-1', 'rankai.ai', twoCookies);

      const item = mockDynamoDB.put.mock.calls[0][0].Item;
      expect(item.expiresAt).toBe(new Date((nowSeconds + 500) * 1000).toISOString());
    });
  });

  describe('listDomainCookies', () => {
    it('returns metadata only, excluding "__all__" and never including encryptedCookies', async () => {
      mockDynamoDB.query.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Items: [
            { userId: 'user-1', domain: '__all__', cookies: [{ name: 'x', value: 'y' }] },
            {
              userId: 'user-1',
              domain: 'rankai.ai',
              cookieCount: 1,
              encryptedCookies: 'secret',
              createdAt: '2026-01-01T00:00:00.000Z',
              expiresAt: '2026-04-01T00:00:00.000Z',
            },
          ],
        }),
      });

      const result = await browserCookieDb.listDomainCookies('user-1');

      expect(result).toEqual([
        { domain: 'rankai.ai', cookieCount: 1, createdAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-04-01T00:00:00.000Z' },
      ]);
      expect(result[0]).not.toHaveProperty('encryptedCookies');
    });

    it('paginates past DynamoDB\'s per-response page limit instead of silently dropping later domains (Greptile P1, PR #2201)', async () => {
      mockDynamoDB.query
        .mockReturnValueOnce({
          promise: jest.fn().mockResolvedValue({
            Items: [{ userId: 'user-1', domain: 'page1.com', cookieCount: 1, createdAt: '2026-01-01T00:00:00.000Z' }],
            LastEvaluatedKey: { userId: 'user-1', domain: 'page1.com' },
          }),
        })
        .mockReturnValueOnce({
          promise: jest.fn().mockResolvedValue({
            Items: [{ userId: 'user-1', domain: 'page2.com', cookieCount: 1, createdAt: '2026-01-02T00:00:00.000Z' }],
          }),
        });

      const result = await browserCookieDb.listDomainCookies('user-1');

      expect(result.map((r) => r.domain)).toEqual(['page1.com', 'page2.com']);
      expect(mockDynamoDB.query).toHaveBeenCalledTimes(2);
      expect(mockDynamoDB.query.mock.calls[1][0]).toEqual(
        expect.objectContaining({ ExclusiveStartKey: { userId: 'user-1', domain: 'page1.com' } })
      );
    });

    it('returns an empty array when only "__all__" exists', async () => {
      mockDynamoDB.query.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Items: [{ userId: 'user-1', domain: '__all__', cookies: [] }],
        }),
      });

      const result = await browserCookieDb.listDomainCookies('user-1');
      expect(result).toEqual([]);
    });

    it('surfaces lastFailedAt when present, so the UI can warn the user', async () => {
      mockDynamoDB.query.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Items: [{
            userId: 'user-1',
            domain: 'rankai.ai',
            cookieCount: 1,
            createdAt: '2026-01-01T00:00:00.000Z',
            lastFailedAt: '2026-02-01T00:00:00.000Z',
          }],
        }),
      });

      const result = await browserCookieDb.listDomainCookies('user-1');
      expect(result[0].lastFailedAt).toBe('2026-02-01T00:00:00.000Z');
    });

    it('omits lastFailedAt when not present (never failed, or re-imported since)', async () => {
      mockDynamoDB.query.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Items: [{ userId: 'user-1', domain: 'rankai.ai', cookieCount: 1, createdAt: '2026-01-01T00:00:00.000Z' }],
        }),
      });

      const result = await browserCookieDb.listDomainCookies('user-1');
      expect(result[0]).not.toHaveProperty('lastFailedAt');
    });
  });

  describe('deleteDomainCookies', () => {
    it('deletes by userId + domain composite key', async () => {
      mockDynamoDB.delete.mockReturnValue({ promise: jest.fn().mockResolvedValue({}) });

      await browserCookieDb.deleteDomainCookies('user-1', 'rankai.ai');

      expect(mockDynamoDB.delete).toHaveBeenCalledWith(
        expect.objectContaining({
          TableName: expect.stringContaining('AW-BrowserCookies'),
          Key: { userId: 'user-1', domain: 'rankai.ai' },
        })
      );
    });
  });

  describe('markDomainCookiesFailed', () => {
    it('sets lastFailedAt on the existing item without touching the stored cookies', async () => {
      mockDynamoDB.update.mockReturnValue({ promise: jest.fn().mockResolvedValue({}) });

      await browserCookieDb.markDomainCookiesFailed('user-1', 'rankai.ai');

      expect(mockDynamoDB.update).toHaveBeenCalledWith(
        expect.objectContaining({
          TableName: expect.stringContaining('AW-BrowserCookies'),
          Key: { userId: 'user-1', domain: 'rankai.ai' },
          UpdateExpression: expect.stringContaining('lastFailedAt'),
        })
      );
    });

    it('is a no-op (does not throw) if the domain was already deleted out from under it', async () => {
      mockDynamoDB.update.mockReturnValue({
        promise: jest.fn().mockRejectedValue({ code: 'ConditionalCheckFailedException' }),
      });

      await expect(browserCookieDb.markDomainCookiesFailed('user-1', 'gone.com')).resolves.toBeUndefined();
    });
  });

  describe('getAllCookiesForUser', () => {
    it('paginates past DynamoDB\'s per-response page limit instead of silently dropping later domains\' cookies from injection (Greptile P1, PR #2201)', async () => {
      const page1Cookies = [{ name: 'session', value: 'page1-val' }];
      const page2Cookies = [{ name: 'session', value: 'page2-val' }];
      mockDynamoDB.query
        .mockReturnValueOnce({
          promise: jest.fn().mockResolvedValue({
            Items: [{ userId: 'user-1', domain: 'page1.com', encryptedCookies: `ENC(user-1:${JSON.stringify(page1Cookies)})` }],
            LastEvaluatedKey: { userId: 'user-1', domain: 'page1.com' },
          }),
        })
        .mockReturnValueOnce({
          promise: jest.fn().mockResolvedValue({
            Items: [{ userId: 'user-1', domain: 'page2.com', encryptedCookies: `ENC(user-1:${JSON.stringify(page2Cookies)})` }],
          }),
        });

      const result = await browserCookieDb.getAllCookiesForUser('user-1');

      expect(result).toEqual([...page1Cookies, ...page2Cookies]);
      expect(mockDynamoDB.query).toHaveBeenCalledTimes(2);
    });

    it('falls back to the simple get()-based getCookies path if the query itself throws entirely (e.g. throttling), instead of failing the whole load', async () => {
      // Defense in depth: users who never touch the manual-import feature (the
      // overwhelming majority, day one) should not regress just because the read
      // path changed from a single get() to a query() to support it.
      mockDynamoDB.query.mockReturnValue({ promise: jest.fn().mockRejectedValue(new Error('ProvisionedThroughputExceededException')) });
      const allCookies = [{ name: 'auto', value: 'auto-val' }];
      mockDynamoDB.get.mockReturnValue({ promise: jest.fn().mockResolvedValue({ Item: { userId: 'user-1', domain: '__all__', cookies: allCookies } }) });

      const result = await browserCookieDb.getAllCookiesForUser('user-1');

      expect(result).toEqual(allCookies);
      expect(mockDynamoDB.get).toHaveBeenCalledWith(
        expect.objectContaining({ Key: { userId: 'user-1', domain: '__all__' } })
      );
    });

    it('still throws (does not silently swallow) if BOTH the query and the get() fallback fail — a real infra outage should stay visible, not masquerade as "no cookies saved"', async () => {
      mockDynamoDB.query.mockReturnValue({ promise: jest.fn().mockRejectedValue(new Error('down')) });
      mockDynamoDB.get.mockReturnValue({ promise: jest.fn().mockRejectedValue(new Error('also down')) });

      await expect(browserCookieDb.getAllCookiesForUser('user-1')).rejects.toThrow();
    });

    it('returns "__all__" cookies followed by decrypted per-domain cookies (human session wins on dedup)', async () => {
      const allCookies = [{ name: 'auto', value: 'auto-val' }];
      const domainCookies = [{ name: 'session', value: 'human-val' }];
      mockDynamoDB.query.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Items: [
            { userId: 'user-1', domain: '__all__', cookies: allCookies },
            { userId: 'user-1', domain: 'rankai.ai', encryptedCookies: `ENC(user-1:${JSON.stringify(domainCookies)})` },
          ],
        }),
      });

      const result = await browserCookieDb.getAllCookiesForUser('user-1');

      expect(result).toEqual([...allCookies, ...domainCookies]);
    });

    it('succeeds with only per-domain cookies when "__all__" was never saved', async () => {
      const domainCookies = [{ name: 'session', value: 'human-val' }];
      mockDynamoDB.query.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Items: [{ userId: 'user-1', domain: 'rankai.ai', encryptedCookies: `ENC(user-1:${JSON.stringify(domainCookies)})` }],
        }),
      });

      const result = await browserCookieDb.getAllCookiesForUser('user-1');
      expect(result).toEqual(domainCookies);
    });

    it('returns an empty array when nothing is saved', async () => {
      mockDynamoDB.query.mockReturnValue({ promise: jest.fn().mockResolvedValue({ Items: [] }) });

      const result = await browserCookieDb.getAllCookiesForUser('user-1');
      expect(result).toEqual([]);
    });

    it('skips a per-domain entry whose expiresAt is in the past, without dropping valid entries', async () => {
      const expiredCookies = [{ name: 'session', value: 'dead-val' }];
      const validCookies = [{ name: 'session', value: 'live-val' }];
      mockDynamoDB.query.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Items: [
            {
              userId: 'user-1',
              domain: 'expired.com',
              encryptedCookies: `ENC(user-1:${JSON.stringify(expiredCookies)})`,
              expiresAt: '2020-01-01T00:00:00.000Z',
            },
            {
              userId: 'user-1',
              domain: 'rankai.ai',
              encryptedCookies: `ENC(user-1:${JSON.stringify(validCookies)})`,
              expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString(),
            },
          ],
        }),
      });

      const result = await browserCookieDb.getAllCookiesForUser('user-1');
      expect(result).toEqual(validCookies);
    });

    it('does not skip a per-domain entry with no expiresAt field (backward compatibility)', async () => {
      const cookiesNoExpiry = [{ name: 'session', value: 'still-valid' }];
      mockDynamoDB.query.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Items: [
            { userId: 'user-1', domain: 'rankai.ai', encryptedCookies: `ENC(user-1:${JSON.stringify(cookiesNoExpiry)})` },
          ],
        }),
      });

      const result = await browserCookieDb.getAllCookiesForUser('user-1');
      expect(result).toEqual(cookiesNoExpiry);
    });

    it('skips a single corrupted per-domain entry without dropping other valid entries', async () => {
      const goodCookies = [{ name: 'session', value: 'good-val' }];
      mockDynamoDB.query.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Items: [
            { userId: 'user-1', domain: 'corrupted.com', encryptedCookies: 'not-valid-ciphertext' },
            { userId: 'user-1', domain: 'rankai.ai', encryptedCookies: `ENC(user-1:${JSON.stringify(goodCookies)})` },
          ],
        }),
      });

      const result = await browserCookieDb.getAllCookiesForUser('user-1');
      expect(result).toEqual(goodCookies);
    });
  });
});
