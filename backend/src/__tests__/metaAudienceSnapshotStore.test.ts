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
 * Sharded across an index item (holding a per-save generationId + chunkCount)
 * plus N chunk items namespaced under that generationId — DynamoDB caps a
 * single item at 400KB, which a large audience's row-keys could exceed if
 * stored as one array. The generation namespacing (Greptile finding) means a
 * failed save's partially-written chunks are never mixed into a read: every
 * save writes to brand-new keys, and a read only ever touches the single
 * generation the index currently points at.
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

// Chunk configIds now embed a random generationId
// (metaAudienceSnapshot:<audienceId>:gen:<generationId>:chunk:<i>), so tests
// match by pattern rather than an exact string.
const CHUNK_CONFIG_ID_RE = /^metaAudienceSnapshot:aud_123:gen:[^:]+:chunk:(\d+)$/;

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

    it('reads a single chunk (at the index-recorded generation) and returns its rowKeys', async () => {
      mockGet
        .mockResolvedValueOnce({ Item: { chunkCount: 1, generationId: 'gen-A' } }) // index
        .mockResolvedValueOnce({ Item: { rowKeys: ['abc|def', 'ghi|jkl'] } }); // chunk 0

      const result = await getAudienceSnapshotRowKeys('user1', 'aud_123');

      expect(result).toEqual(['abc|def', 'ghi|jkl']);
      expect(mockGet).toHaveBeenNthCalledWith(2, expect.objectContaining({
        Key: { userId: 'user1', configId: 'metaAudienceSnapshot:aud_123:gen:gen-A:chunk:0' },
      }));
    });

    it('reads and concatenates multiple chunks (at the index-recorded generation) in order', async () => {
      mockGet.mockImplementation((params: any) => {
        if (params.Key.configId === 'metaAudienceSnapshot:aud_123') {
          return Promise.resolve({ Item: { chunkCount: 3, generationId: 'gen-B' } });
        }
        const idx = Number(params.Key.configId.split(':').pop());
        return Promise.resolve({ Item: { rowKeys: [`key${idx}`] } });
      });

      const result = await getAudienceSnapshotRowKeys('user1', 'aud_123');

      expect(result).toEqual(['key0', 'key1', 'key2']);
    });

    // Greptile finding: a mixed-generation read was possible when the same
    // static chunk keys were reused across saves — a failed save could
    // overwrite some low-numbered chunks with fresh data while the index
    // stayed pointing at the OLD chunkCount, silently blending stale
    // untouched high chunks with newly-overwritten low ones. Generation
    // namespacing makes this structurally impossible: this test proves a
    // read for generation "gen-CURRENT" never touches keys under a
    // DIFFERENT generation ("gen-OLD"), even though both exist in the table.
    it('never reads chunks from a different (orphaned) generation, even if they still exist in the table', async () => {
      const requestedConfigIds: string[] = [];
      mockGet.mockImplementation((params: any) => {
        requestedConfigIds.push(params.Key.configId);
        if (params.Key.configId === 'metaAudienceSnapshot:aud_123') {
          return Promise.resolve({ Item: { chunkCount: 1, generationId: 'gen-CURRENT' } });
        }
        if (params.Key.configId === 'metaAudienceSnapshot:aud_123:gen:gen-CURRENT:chunk:0') {
          return Promise.resolve({ Item: { rowKeys: ['fresh1'] } });
        }
        // An orphaned chunk from an earlier failed/superseded save — must never be requested.
        if (params.Key.configId === 'metaAudienceSnapshot:aud_123:gen:gen-OLD:chunk:0') {
          return Promise.resolve({ Item: { rowKeys: ['stale1', 'stale2'] } });
        }
        return Promise.resolve({});
      });

      const result = await getAudienceSnapshotRowKeys('user1', 'aud_123');

      expect(result).toEqual(['fresh1']);
      expect(requestedConfigIds).not.toContain('metaAudienceSnapshot:aud_123:gen:gen-OLD:chunk:0');
    });

    it('throws when the index has a chunkCount but no generationId (malformed index)', async () => {
      mockGet.mockResolvedValueOnce({ Item: { chunkCount: 1 } }); // no generationId

      await expect(getAudienceSnapshotRowKeys('user1', 'aud_123')).rejects.toThrow(/generationId/);
    });

    // Greptile finding: a missing/malformed chunk used to be silently
    // treated as contributing zero rows, returning a SHORT baseline as if
    // it were complete — reconciliation would then never issue DELETE_USERS
    // for the stale contacts the omitted chunk actually represented,
    // leaving them targetable forever with no signal anything was wrong.
    // Throws instead so this is treated as a read failure — which
    // agentModeService already blocks the whole launch on (Greptile's
    // earlier "snapshot READ failure" fix), rather than silently proceeding
    // with an incomplete baseline.
    it('throws when a chunk the index says should exist is missing or malformed, rather than silently omitting it', async () => {
      mockGet
        .mockResolvedValueOnce({ Item: { chunkCount: 2, generationId: 'gen-C' } }) // index
        .mockResolvedValueOnce({}) // chunk 0 missing
        .mockResolvedValueOnce({ Item: { rowKeys: ['key1'] } }); // chunk 1

      await expect(getAudienceSnapshotRowKeys('user1', 'aud_123')).rejects.toThrow(/chunk 0/);
    });

    it('throws when a chunk item exists but its rowKeys field is malformed (not an array)', async () => {
      mockGet
        .mockResolvedValueOnce({ Item: { chunkCount: 1, generationId: 'gen-D' } }) // index
        .mockResolvedValueOnce({ Item: { rowKeys: 'not-an-array' } }); // chunk 0 malformed

      await expect(getAudienceSnapshotRowKeys('user1', 'aud_123')).rejects.toThrow(/chunk 0/);
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
    it('writes a single chunk (namespaced under a generation id) plus an index item recording that generation and chunkCount 1', async () => {
      mockPut.mockResolvedValue({});

      await saveAudienceSnapshotRowKeys('user1', 'aud_123', ['abc|def']);

      const chunkPut = mockPut.mock.calls.find(([p]) => CHUNK_CONFIG_ID_RE.test(p.Item.configId));
      expect(chunkPut).toBeDefined();
      expect(chunkPut![0].Item.rowKeys).toEqual(['abc|def']);

      const indexPut = mockPut.mock.calls.find(([p]) => p.Item.configId === 'metaAudienceSnapshot:aud_123');
      expect(indexPut).toBeDefined();
      expect(indexPut![0].Item.chunkCount).toBe(1);
      expect(typeof indexPut![0].Item.generationId).toBe('string');
      expect(indexPut![0].Item.generationId.length).toBeGreaterThan(0);

      // The chunk's generation segment matches the index's recorded generationId.
      expect(chunkPut![0].Item.configId).toBe(`metaAudienceSnapshot:aud_123:gen:${indexPut![0].Item.generationId}:chunk:0`);
    });

    it('uses a DIFFERENT generation id on each save, so consecutive saves never share (or overwrite) chunk keys', async () => {
      mockPut.mockResolvedValue({});

      await saveAudienceSnapshotRowKeys('user1', 'aud_123', ['row1']);
      const firstIndexPut = mockPut.mock.calls.find(([p]) => p.Item.configId === 'metaAudienceSnapshot:aud_123');
      const firstGeneration = firstIndexPut![0].Item.generationId;

      mockPut.mockClear();
      await saveAudienceSnapshotRowKeys('user1', 'aud_123', ['row2']);
      const secondIndexPut = mockPut.mock.calls.find(([p]) => p.Item.configId === 'metaAudienceSnapshot:aud_123');
      const secondGeneration = secondIndexPut![0].Item.generationId;

      expect(secondGeneration).not.toBe(firstGeneration);
    });

    it('splits a large rowKeys array across multiple chunk items, capped well under the DynamoDB 400KB item limit', async () => {
      mockPut.mockResolvedValue({});
      const rowKeys = Array.from({ length: 4500 }, (_, i) => `row${i}`);

      await saveAudienceSnapshotRowKeys('user1', 'aud_123', rowKeys);

      const chunkPuts = mockPut.mock.calls.filter(([p]) => CHUNK_CONFIG_ID_RE.test(p.Item.configId));
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

      const chunkIdx = order.findIndex((id) => CHUNK_CONFIG_ID_RE.test(id));
      const indexIdx = order.indexOf('metaAudienceSnapshot:aud_123');
      expect(chunkIdx).toBeGreaterThanOrEqual(0);
      expect(chunkIdx).toBeLessThan(indexIdx);
    });

    it('writes one empty chunk and chunkCount 1 for an empty rowKeys array (zero-member audience)', async () => {
      mockPut.mockResolvedValue({});

      await saveAudienceSnapshotRowKeys('user1', 'aud_123', []);

      const chunkPut = mockPut.mock.calls.find(([p]) => CHUNK_CONFIG_ID_RE.test(p.Item.configId));
      expect(chunkPut![0].Item.rowKeys).toEqual([]);
      expect(mockPut).toHaveBeenCalledWith(expect.objectContaining({
        Item: expect.objectContaining({ configId: 'metaAudienceSnapshot:aud_123', chunkCount: 1 }),
      }));
    });

    // Greptile P1 finding: a snapshot-save failure was purely non-fatal with
    // no retry — the next sync would see no prior baseline at all, silently
    // abandoning stale-member reconciliation. Retrying a few times covers the
    // common transient-failure case without a bigger atomic-rewrite of the
    // storage format.
    it('retries and succeeds if an earlier attempt fails', async () => {
      mockPut
        .mockRejectedValueOnce(new Error('ProvisionedThroughputExceededException'))
        .mockResolvedValue({});

      await saveAudienceSnapshotRowKeys('user1', 'aud_123', ['abc|def']);

      // 1 failed chunk write (attempt 1) + 1 successful chunk write + 1 successful index write (attempt 2)
      expect(mockPut).toHaveBeenCalledTimes(3);
    });

    it('throws only after exhausting all retry attempts', async () => {
      mockPut.mockRejectedValue(new Error('ProvisionedThroughputExceededException'));

      await expect(saveAudienceSnapshotRowKeys('user1', 'aud_123', ['abc|def'])).rejects.toThrow(
        'ProvisionedThroughputExceededException'
      );
      expect(mockPut.mock.calls.length).toBeGreaterThan(1);
    });
  });
});
