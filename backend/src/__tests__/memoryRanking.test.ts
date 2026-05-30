import { cosineSimilarity, rankMemoriesByRelevance } from '../utils/memoryRanking';

describe('cosineSimilarity', () => {
  it('returns ~1 for identical vectors', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 6);
  });

  it('returns 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 6);
  });

  it('returns 0 (no NaN) for a zero vector', () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });

  it('returns 0 for mismatched dimensions instead of throwing', () => {
    expect(cosineSimilarity([1, 2], [1])).toBe(0);
  });

  it('returns 0 for empty input', () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });
});

describe('rankMemoriesByRelevance', () => {
  it('returns [] for empty input', () => {
    expect(rankMemoriesByRelevance([], [1, 0], 5)).toEqual([]);
  });

  it('when count <= limit, returns all sorted newest-first (no scoring needed)', () => {
    const mems = [
      { memoryId: 'a', createdAt: '2026-01-01T00:00:00Z', embedding: [0, 1] },
      { memoryId: 'b', createdAt: '2026-03-01T00:00:00Z', embedding: [1, 0] },
    ];
    const result = rankMemoriesByRelevance(mems, [0, 1], 5);
    expect(result.map((m) => m.memoryId)).toEqual(['b', 'a']); // newest first
  });

  it('when count > limit, retrieves the semantically relevant memory even if it is older', () => {
    const mems = [
      { memoryId: 'old-relevant', createdAt: '2026-01-01T00:00:00Z', embedding: [1, 0] },
      { memoryId: 'new-irrelevant', createdAt: '2026-05-01T00:00:00Z', embedding: [0, 1] },
    ];
    const result = rankMemoriesByRelevance(mems, [1, 0], 1); // query matches old-relevant
    expect(result.map((m) => m.memoryId)).toEqual(['old-relevant']);
  });

  it('does not silently lose memories that lack an embedding (graceful), preferring a real match', () => {
    const mems = [
      { memoryId: 'recent-no-embedding', createdAt: '2026-05-01T00:00:00Z' },
      { memoryId: 'old-match', createdAt: '2026-01-01T00:00:00Z', embedding: [1, 0] },
    ];
    const result = rankMemoriesByRelevance(mems, [1, 0], 1);
    expect(result.map((m) => m.memoryId)).toEqual(['old-match']);
  });

  it('uses recency as a tie-breaker when relevance is equal', () => {
    const mems = [
      { memoryId: 'older', createdAt: '2026-01-01T00:00:00Z', embedding: [1, 0] },
      { memoryId: 'newer', createdAt: '2026-05-01T00:00:00Z', embedding: [1, 0] },
    ];
    const result = rankMemoriesByRelevance(mems, [1, 0], 1); // equal similarity
    expect(result.map((m) => m.memoryId)).toEqual(['newer']);
  });

  it('returns [] for null/undefined memories', () => {
    expect(rankMemoriesByRelevance(null as any, [1, 0], 5)).toEqual([]);
  });

  it('honors a provided recencyWeight in the scoring path', () => {
    const mems = [
      { memoryId: 'a', createdAt: '2026-01-01T00:00:00Z', embedding: [1, 0] },
      { memoryId: 'b', createdAt: '2026-05-01T00:00:00Z', embedding: [1, 0] },
      { memoryId: 'c', createdAt: '2026-03-01T00:00:00Z', embedding: [0, 1] },
    ];
    const res = rankMemoriesByRelevance(mems, [1, 0], 2, { recencyWeight: 0.5 });
    expect(res.map((m) => m.memoryId)).toEqual(['b', 'a']);
  });

  it('handles the single-memory scoring path (limit 0)', () => {
    const res = rankMemoriesByRelevance(
      [{ memoryId: 'x', createdAt: '2026-01-01T00:00:00Z', embedding: [1, 0] }],
      [1, 0],
      0
    );
    expect(res).toEqual([]);
  });

  it('does not throw when createdAt is missing/equal', () => {
    const res = rankMemoriesByRelevance([{ memoryId: 'a' }, { memoryId: 'b' }], [1, 0], 5);
    expect(res).toHaveLength(2);
  });
});

describe('cosineSimilarity — additional branches', () => {
  it('returns 0 for a null vector', () => {
    expect(cosineSimilarity(null as any, [1])).toBe(0);
  });

  it('returns 0 when the second vector is all zeros', () => {
    expect(cosineSimilarity([1, 1], [0, 0])).toBe(0);
  });
});
