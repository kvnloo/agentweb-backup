/**
 * Unit tests for the single-use preview-token consumption store (ENG-600
 * Greptile finding: an HMAC-valid preview token was never consumed/invalidated
 * after use, so replaying the same confirmed call would silently re-execute —
 * e.g. creating a second ad set under the same campaign with no new user
 * confirmation).
 *
 * Reuses the existing AW-Configs table (keyed userId+configId) rather than a
 * new table, per CLAUDE.md's "Database/data-plane work requires Harsha
 * before merge" gate.
 */

const mockGet = jest.fn();
const mockPut = jest.fn();

jest.mock('aws-sdk', () => ({
  DynamoDB: {
    DocumentClient: jest.fn().mockImplementation(() => ({
      get: (params: any) => ({ promise: () => mockGet(params) }),
      put: (params: any) => ({ promise: () => mockPut(params) }),
    })),
  },
}));

import {
  isPreviewTokenConsumed,
  markPreviewTokenConsumed,
} from '../services/metaAudienceCampaignTokenStore';

describe('metaAudienceCampaignTokenStore', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('isPreviewTokenConsumed', () => {
    it('returns false when the token has never been marked consumed', async () => {
      mockGet.mockResolvedValueOnce({});

      const result = await isPreviewTokenConsumed('user1', 'abc123token');

      expect(result).toBe(false);
      expect(mockGet).toHaveBeenCalledWith(
        expect.objectContaining({
          Key: { userId: 'user1', configId: 'metaAudienceCampaignConfirmToken:abc123token' },
        })
      );
    });

    it('returns true when the token was previously marked consumed', async () => {
      mockGet.mockResolvedValueOnce({ Item: { consumedAt: '2026-07-31T00:00:00.000Z' } });

      const result = await isPreviewTokenConsumed('user1', 'abc123token');

      expect(result).toBe(true);
    });

    // Different users confirming the exact same args (thus same digest, since
    // the digest doesn't include userId) must not collide — each user's
    // confirm is tracked independently.
    it('scopes consumption per userId, not just per token', async () => {
      mockGet.mockResolvedValueOnce({});

      await isPreviewTokenConsumed('user2', 'abc123token');

      expect(mockGet).toHaveBeenCalledWith(
        expect.objectContaining({ Key: { userId: 'user2', configId: 'metaAudienceCampaignConfirmToken:abc123token' } })
      );
    });
  });

  describe('markPreviewTokenConsumed', () => {
    it('writes a record keyed by userId + the token', async () => {
      mockPut.mockResolvedValueOnce({});

      await markPreviewTokenConsumed('user1', 'abc123token');

      expect(mockPut).toHaveBeenCalledWith(
        expect.objectContaining({
          Item: expect.objectContaining({
            userId: 'user1',
            configId: 'metaAudienceCampaignConfirmToken:abc123token',
          }),
        })
      );
    });
  });
});
