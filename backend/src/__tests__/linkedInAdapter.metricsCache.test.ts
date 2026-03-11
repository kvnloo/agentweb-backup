const mockDocumentClientMethods = {
  put: jest.fn(),
  get: jest.fn(),
  query: jest.fn().mockReturnValue({ promise: () => Promise.resolve({ Items: [] }) }),
  scan: jest.fn(),
  update: jest.fn().mockReturnValue({ promise: () => Promise.resolve({}) }),
  delete: jest.fn(),
  batchWrite: jest.fn(),
};

jest.mock('aws-sdk', () => ({
  config: { update: jest.fn() },
  DynamoDB: {
    DocumentClient: jest.fn(() => mockDocumentClientMethods),
  },
  S3: jest.fn(() => ({
    upload: jest.fn(),
    getObject: jest.fn(),
    deleteObject: jest.fn(),
  })),
}));

jest.mock('../services/linkedInService', () => ({
  linkedInService: {
    getPersonalPostAnalytics: jest.fn(),
  },
}));

jest.mock('../services/connectedAccountsDb', () => ({
  updateAccountTokens: jest.fn(),
}));

jest.mock('../config/integrations', () => ({
  getLinkedInConfig: jest.fn().mockReturnValue({
    clientId: 'test',
    clientSecret: 'test',
    redirectUri: 'http://localhost',
  }),
}));

import { LinkedInAdapter } from '../services/adapters/linkedInAdapter';
import { linkedInService } from '../services/linkedInService';
import { ConnectedAccount } from '../services/connectedAccountsDb';

const mockGetPersonalPostAnalytics = linkedInService.getPersonalPostAnalytics as jest.Mock;

function makePersonalAccount(overrides: Record<string, any> = {}): ConnectedAccount {
  return {
    platform: 'linkedin',
    account_id: 'urn:li:person:abc123',
    account_name: 'Test User',
    config: {
      account_type: 'personal',
      access_token: 'valid-token',
      token_expires_at: Date.now() + 3600000,
      refresh_token: 'refresh-tok',
      ...overrides,
    },
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  } as ConnectedAccount;
}

describe('LinkedInAdapter metrics cache', () => {
  let adapter: LinkedInAdapter;

  beforeEach(() => {
    jest.clearAllMocks();
    adapter = new LinkedInAdapter();
    // Mock getValidToken to skip actual token validation
    (adapter as any).getValidToken = jest.fn().mockResolvedValue({ token: 'valid-token', refreshed: false });
  });

  describe('getPostMetrics - personal account caching', () => {
    test('returns cached metrics when fresh (< 24h old)', async () => {
      const account = makePersonalAccount();
      const freshTimestamp = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2 hours ago

      // Mock stored posts with fresh cached metrics
      mockDocumentClientMethods.query.mockReturnValueOnce({
        promise: () => Promise.resolve({
          Items: [{
            userId: 'user-1',
            postId: 'urn:li:share:111',
            accountId: account.account_id,
            content: 'test',
            createdAt: '2026-03-08T10:00:00Z',
            metrics: {
              impressionCount: 500,
              likeCount: 20,
              commentCount: 5,
              shareCount: 2,
              clickCount: 10,
              engagement: 27,
            },
            metricsFetchedAt: freshTimestamp,
          }],
        }),
      });

      const result = await adapter.getPostMetrics(account, ['urn:li:share:111'], 'user-1');

      // Should return cached metrics without calling LinkedIn API
      expect(mockGetPersonalPostAnalytics).not.toHaveBeenCalled();
      expect(result).toHaveLength(1);
      expect(result[0].impressions).toBe(500);
      expect(result[0].likes).toBe(20);
      expect(result[0].comments).toBe(5);
      expect(result[0].shares).toBe(2);
    });

    test('fetches from API when metrics are stale (> 24h old)', async () => {
      const account = makePersonalAccount();
      const staleTimestamp = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(); // 25 hours ago

      // Mock stored posts with stale cached metrics
      mockDocumentClientMethods.query.mockReturnValueOnce({
        promise: () => Promise.resolve({
          Items: [{
            userId: 'user-1',
            postId: 'urn:li:share:111',
            accountId: account.account_id,
            content: 'test',
            createdAt: '2026-03-08T10:00:00Z',
            metrics: {
              impressionCount: 100, // old cached value
              likeCount: 5,
              commentCount: 1,
              shareCount: 0,
              clickCount: 2,
              engagement: 6,
            },
            metricsFetchedAt: staleTimestamp,
          }],
        }),
      });

      // Mock fresh API response
      mockGetPersonalPostAnalytics.mockResolvedValue({
        impression: 800,
        reaction: 30,
        comment: 10,
        reshare: 5,
      });

      const result = await adapter.getPostMetrics(account, ['urn:li:share:111'], 'user-1');

      // Should call LinkedIn API for stale post
      expect(mockGetPersonalPostAnalytics).toHaveBeenCalledTimes(1);
      expect(result).toHaveLength(1);
      expect(result[0].impressions).toBe(800);
      expect(result[0].likes).toBe(30);

      // Should update cache in DB
      expect(mockDocumentClientMethods.update).toHaveBeenCalledWith(
        expect.objectContaining({
          Key: { userId: 'user-1', postId: 'urn:li:share:111' },
          UpdateExpression: 'SET metrics = :m, metricsFetchedAt = :ts',
        })
      );
    });

    test('fetches from API when no cached metrics exist', async () => {
      const account = makePersonalAccount();

      // Mock stored posts without metrics
      mockDocumentClientMethods.query.mockReturnValueOnce({
        promise: () => Promise.resolve({
          Items: [{
            userId: 'user-1',
            postId: 'urn:li:share:111',
            accountId: account.account_id,
            content: 'test',
            createdAt: '2026-03-08T10:00:00Z',
            // No metrics or metricsFetchedAt
          }],
        }),
      });

      mockGetPersonalPostAnalytics.mockResolvedValue({
        impression: 200,
        reaction: 10,
        comment: 3,
        reshare: 1,
      });

      const result = await adapter.getPostMetrics(account, ['urn:li:share:111'], 'user-1');

      expect(mockGetPersonalPostAnalytics).toHaveBeenCalledTimes(1);
      expect(result).toHaveLength(1);
      expect(result[0].impressions).toBe(200);
      expect(mockDocumentClientMethods.update).toHaveBeenCalled();
    });

    test('handles mix of fresh and stale posts', async () => {
      const account = makePersonalAccount();
      const freshTimestamp = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(); // 1 hour ago
      const staleTimestamp = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString(); // 30 hours ago

      mockDocumentClientMethods.query.mockReturnValueOnce({
        promise: () => Promise.resolve({
          Items: [
            {
              userId: 'user-1',
              postId: 'urn:li:share:fresh',
              accountId: account.account_id,
              content: 'fresh post',
              createdAt: '2026-03-08T10:00:00Z',
              metrics: { impressionCount: 100, likeCount: 5, commentCount: 1, shareCount: 0, clickCount: 2, engagement: 6 },
              metricsFetchedAt: freshTimestamp,
            },
            {
              userId: 'user-1',
              postId: 'urn:li:share:stale',
              accountId: account.account_id,
              content: 'stale post',
              createdAt: '2026-03-07T10:00:00Z',
              metrics: { impressionCount: 50, likeCount: 2, commentCount: 0, shareCount: 0, clickCount: 1, engagement: 2 },
              metricsFetchedAt: staleTimestamp,
            },
          ],
        }),
      });

      mockGetPersonalPostAnalytics.mockResolvedValue({
        impression: 300,
        reaction: 15,
        comment: 4,
        reshare: 2,
      });

      const result = await adapter.getPostMetrics(
        account,
        ['urn:li:share:fresh', 'urn:li:share:stale'],
        'user-1'
      );

      // Should only call API for the stale post
      expect(mockGetPersonalPostAnalytics).toHaveBeenCalledTimes(1);
      expect(result).toHaveLength(2);

      // Fresh post returns cached values
      const freshResult = result.find(r => r.share === 'urn:li:share:fresh');
      expect(freshResult?.impressions).toBe(100);

      // Stale post returns fresh API values
      const staleResult = result.find(r => r.share === 'urn:li:share:stale');
      expect(staleResult?.impressions).toBe(300);
    });
  });
});
