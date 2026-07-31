/**
 * Unit tests for the Meta Custom Audience membership snapshot store
 * (ENG-600 Greptile finding: reusing an audience for a fresh source upload
 * never removed members no longer present in the new source). The store
 * persists the hashed row-keys uploaded to a given Meta audience on the last
 * sync so agentModeService can diff the new source against them and issue
 * removals for anything no longer present.
 *
 * Reuses the existing AW-Configs table (keyed userId+configId) rather than a
 * new table, per CLAUDE.md's "Database/data-plane work requires Harsha
 * before merge" gate — this is a new logical use of an existing table/schema,
 * not a schema change.
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
  getAudienceSnapshotRowKeys,
  saveAudienceSnapshotRowKeys,
} from '../services/metaAudienceSnapshotStore';

describe('metaAudienceSnapshotStore', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getAudienceSnapshotRowKeys', () => {
    it('returns null when no snapshot has ever been saved for this audience', async () => {
      mockGet.mockResolvedValueOnce({});

      const result = await getAudienceSnapshotRowKeys('user1', 'aud_123');

      expect(result).toBeNull();
      expect(mockGet).toHaveBeenCalledWith(
        expect.objectContaining({
          Key: { userId: 'user1', configId: 'metaAudienceSnapshot:aud_123' },
        })
      );
    });

    it('returns the stored rowKeys array when a snapshot exists', async () => {
      mockGet.mockResolvedValueOnce({ Item: { rowKeys: ['abc|def', 'ghi|jkl'] } });

      const result = await getAudienceSnapshotRowKeys('user1', 'aud_123');

      expect(result).toEqual(['abc|def', 'ghi|jkl']);
    });

    it('treats a malformed stored row (rowKeys not an array) as no snapshot rather than throwing', async () => {
      mockGet.mockResolvedValueOnce({ Item: { rowKeys: 'not-an-array' } });

      const result = await getAudienceSnapshotRowKeys('user1', 'aud_123');

      expect(result).toBeNull();
    });
  });

  describe('saveAudienceSnapshotRowKeys', () => {
    it('writes rowKeys keyed by userId + a metaAudienceSnapshot:<audienceId> configId', async () => {
      mockPut.mockResolvedValueOnce({});

      await saveAudienceSnapshotRowKeys('user1', 'aud_123', ['abc|def']);

      expect(mockPut).toHaveBeenCalledWith(
        expect.objectContaining({
          Item: expect.objectContaining({
            userId: 'user1',
            configId: 'metaAudienceSnapshot:aud_123',
            rowKeys: ['abc|def'],
          }),
        })
      );
    });
  });
});
