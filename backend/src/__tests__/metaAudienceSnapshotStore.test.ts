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
 *
 * Sharded across multiple items (an index item + N chunk items) rather than
 * one flat array in one item — DynamoDB caps a single item at 400KB, which a
 * large audience's row-keys could exceed if stored as one array.
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

    it('reads a single chunk and returns its rowKeys', async () => {
      mockGet
        .mockResolvedValueOnce({ Item: { chunkCount: 1 } }) // index
        .mockResolvedValueOnce({ Item: { rowKeys: ['abc|def', 'ghi|jkl'] } }); // chunk 0

      const result = await getAudienceSnapshotRowKeys('user1', 'aud_123');

      expect(result).toEqual(['abc|def', 'ghi|jkl']);
      expect(mockGet).toHaveBeenNthCalledWith(2, expect.objectContaining({
        Key: { userId: 'user1', configId: 'metaAudienceSnapshot:aud_123:chunk:0' },
      }));
    });

    it('reads and concatenates multiple chunks in order', async () => {
      mockGet.mockImplementation((params: any) => {
        if (params.Key.configId === 'metaAudienceSnapshot:aud_123') {
          return Promise.resolve({ Item: { chunkCount: 3 } });
        }
        const idx = Number(params.Key.configId.split(':').pop());
        return Promise.resolve({ Item: { rowKeys: [`key${idx}`] } });
      });

      const result = await getAudienceSnapshotRowKeys('user1', 'aud_123');

      expect(result).toEqual(['key0', 'key1', 'key2']);
    });

    it('treats a missing/malformed chunk as contributing no rows rather than throwing', async () => {
      mockGet
        .mockResolvedValueOnce({ Item: { chunkCount: 2 } }) // index
        .mockResolvedValueOnce({}) // chunk 0 missing
        .mockResolvedValueOnce({ Item: { rowKeys: ['key1'] } }); // chunk 1

      const result = await getAudienceSnapshotRowKeys('user1', 'aud_123');

      expect(result).toEqual(['key1']);
    });

    it('treats an index item with neither chunkCount nor rowKeys as no snapshot', async () => {
      mockGet.mockResolvedValueOnce({ Item: { updatedAt: '2026-01-01' } });

      const result = await getAudienceSnapshotRowKeys('user1', 'aud_123');

      expect(result).toBeNull();
    });

    it('backward-compat: returns rowKeys directly if the index item stores them un-chunked', async () => {
      mockGet.mockResolvedValueOnce({ Item: { rowKeys: ['legacy1', 'legacy2'] } });

      const result = await getAudienceSnapshotRowKeys('user1', 'aud_123');

      expect(result).toEqual(['legacy1', 'legacy2']);
      expect(mockGet).toHaveBeenCalledTimes(1);
    });
  });

  describe('saveAudienceSnapshotRowKeys', () => {
    it('writes a single chunk plus an index item with chunkCount 1 for a small rowKeys array', async () => {
      mockPut.mockResolvedValue({});

      await saveAudienceSnapshotRowKeys('user1', 'aud_123', ['abc|def']);

      expect(mockPut).toHaveBeenCalledWith(expect.objectContaining({
        Item: expect.objectContaining({
          userId: 'user1', configId: 'metaAudienceSnapshot:aud_123:chunk:0', rowKeys: ['abc|def'],
        }),
      }));
      expect(mockPut).toHaveBeenCalledWith(expect.objectContaining({
        Item: expect.objectContaining({
          userId: 'user1', configId: 'metaAudienceSnapshot:aud_123', chunkCount: 1,
        }),
      }));
    });

    it('splits a large rowKeys array across multiple chunk items, capped well under the DynamoDB 400KB item limit', async () => {
      mockPut.mockResolvedValue({});
      const rowKeys = Array.from({ length: 4500 }, (_, i) => `row${i}`);

      await saveAudienceSnapshotRowKeys('user1', 'aud_123', rowKeys);

      const chunkPuts = mockPut.mock.calls.filter(([p]) => /:chunk:\d+$/.test(p.Item.configId));
      expect(chunkPuts.length).toBeGreaterThan(1);
      const totalWritten = chunkPuts.reduce((sum, [p]) => sum + p.Item.rowKeys.length, 0);
      expect(totalWritten).toBe(4500);
      for (const [p] of chunkPuts) {
        expect(p.Item.rowKeys.length).toBeLessThanOrEqual(2000);
      }

      const indexPut = mockPut.mock.calls.find(([p]) => p.Item.configId === 'metaAudienceSnapshot:aud_123');
      expect(indexPut![0].Item.chunkCount).toBe(chunkPuts.length);
    });

    it('writes chunk items before the index item, so a partial failure never leaves the index pointing at a chunk that was never written', async () => {
      const order: string[] = [];
      mockPut.mockImplementation((params: any) => {
        order.push(params.Item.configId);
        return Promise.resolve({});
      });

      await saveAudienceSnapshotRowKeys('user1', 'aud_123', ['abc|def']);

      expect(order.indexOf('metaAudienceSnapshot:aud_123:chunk:0')).toBeLessThan(
        order.indexOf('metaAudienceSnapshot:aud_123')
      );
    });

    it('writes one empty chunk and chunkCount 1 for an empty rowKeys array (zero-member audience)', async () => {
      mockPut.mockResolvedValue({});

      await saveAudienceSnapshotRowKeys('user1', 'aud_123', []);

      expect(mockPut).toHaveBeenCalledWith(expect.objectContaining({
        Item: expect.objectContaining({ configId: 'metaAudienceSnapshot:aud_123:chunk:0', rowKeys: [] }),
      }));
      expect(mockPut).toHaveBeenCalledWith(expect.objectContaining({
        Item: expect.objectContaining({ configId: 'metaAudienceSnapshot:aud_123', chunkCount: 1 }),
      }));
    });
  });
});
