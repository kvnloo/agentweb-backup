/**
 * Unit tests for the single-use preview-token consumption store (ENG-600
 * Greptile findings: (1) an HMAC-valid preview token was never consumed or
 * invalidated after use, so replaying the same confirmed call would silently
 * re-execute — e.g. creating a second ad set under the same campaign with no
 * new user confirmation; (2) a separate check-then-mark (isConsumed, then
 * markConsumed) was non-atomic — two concurrent requests with the same valid
 * token could both read "not yet consumed" before either write became
 * visible, both then executing from a single user confirmation).
 *
 * claimPreviewToken uses a single conditional DynamoDB put
 * (attribute_not_exists) to claim the token atomically — only one concurrent
 * caller can ever win, mirroring the same conditional-put pattern already
 * used elsewhere in this codebase (see enrichSoServiceFactory.ts's
 * safeIncrement race-safe day-rollover).
 *
 * Reuses the existing AW-Configs table (keyed userId+configId) rather than a
 * new table, per CLAUDE.md's "Database/data-plane work requires Harsha
 * before merge" gate.
 */

const mockPut = jest.fn();
const mockDelete = jest.fn();

jest.mock('aws-sdk', () => ({
  DynamoDB: {
    DocumentClient: jest.fn().mockImplementation(() => ({
      put: (params: any) => ({ promise: () => mockPut(params) }),
      delete: (params: any) => ({ promise: () => mockDelete(params) }),
    })),
  },
}));

import { claimPreviewToken, releasePreviewToken } from '../services/metaAudienceCampaignTokenStore';

describe('metaAudienceCampaignTokenStore', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('claimPreviewToken', () => {
    it('returns true (claimed) when the token has never been claimed before', async () => {
      mockPut.mockResolvedValueOnce({});

      const result = await claimPreviewToken('user1', 'abc123token');

      expect(result).toBe(true);
      expect(mockPut).toHaveBeenCalledWith(
        expect.objectContaining({
          Item: expect.objectContaining({ userId: 'user1', configId: 'metaAudienceCampaignConfirmToken:abc123token' }),
          ConditionExpression: 'attribute_not_exists(userId)',
        })
      );
    });

    it('returns false (already claimed) when the conditional put fails because the token was already claimed', async () => {
      const err: any = new Error('The conditional request failed');
      err.code = 'ConditionalCheckFailedException';
      mockPut.mockRejectedValueOnce(err);

      const result = await claimPreviewToken('user1', 'abc123token');

      expect(result).toBe(false);
    });

    it('propagates an unrelated DynamoDB error rather than treating it as already-claimed', async () => {
      mockPut.mockRejectedValueOnce(new Error('ProvisionedThroughputExceededException'));

      await expect(claimPreviewToken('user1', 'abc123token')).rejects.toThrow(
        'ProvisionedThroughputExceededException'
      );
    });

    // Different users confirming the exact same args (thus same digest, since
    // the digest doesn't include userId) must not collide — each user's
    // confirm is claimed independently.
    it('scopes the claim per userId, not just per token', async () => {
      mockPut.mockResolvedValueOnce({});

      await claimPreviewToken('user2', 'abc123token');

      expect(mockPut).toHaveBeenCalledWith(
        expect.objectContaining({ Item: expect.objectContaining({ userId: 'user2' }) })
      );
    });
  });

  // Greptile finding: once a token is claimed, a failure anywhere in the
  // actual launch (reconciliation, lookalike, ad-set creation) left it
  // permanently consumed — since the digest is deterministic given the same
  // args, re-previewing unchanged arguments produces the SAME token, which
  // is already claimed forever, so the user could never retry the exact
  // approved arguments. releasePreviewToken lets a failed launch free the
  // claim so a legitimate retry works, while the atomic claim itself still
  // fully prevents concurrent double-execution.
  describe('releasePreviewToken', () => {
    it('deletes the claim record for this user + token', async () => {
      mockDelete.mockResolvedValueOnce({});

      await releasePreviewToken('user1', 'abc123token');

      expect(mockDelete).toHaveBeenCalledWith(
        expect.objectContaining({
          Key: { userId: 'user1', configId: 'metaAudienceCampaignConfirmToken:abc123token' },
        })
      );
    });

    // Greptile follow-up finding: swallowing the delete failure on the FIRST
    // attempt defeated the whole point of releasing — a transient DynamoDB
    // blip would leave the token permanently consumed just as before this
    // fix existed. Retries (mirroring the same pattern already used by
    // saveAudienceSnapshotRowKeys) make that the rare case instead of the
    // common one.
    it('retries and succeeds if an earlier delete attempt fails', async () => {
      mockDelete
        .mockRejectedValueOnce(new Error('ProvisionedThroughputExceededException'))
        .mockResolvedValueOnce({});

      await releasePreviewToken('user1', 'abc123token');

      expect(mockDelete).toHaveBeenCalledTimes(2);
    });

    it('does not throw even after exhausting all retry attempts (best-effort release)', async () => {
      mockDelete.mockRejectedValue(new Error('DynamoDB unavailable'));

      await expect(releasePreviewToken('user1', 'abc123token')).resolves.toBeUndefined();
      expect(mockDelete.mock.calls.length).toBeGreaterThan(1);
    });
  });
});
