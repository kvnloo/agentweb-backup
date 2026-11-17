import { analyzePostPerformance, engagementRate, PerformancePostInput } from '../socialPostPerformance';

function post(id: string, platform: string, likes: number, impressions: number | undefined, extra: Partial<PerformancePostInput> = {}): PerformancePostInput {
  return {
    id,
    platform,
    content: 'hello',
    createdAt: '2026-11-02T15:00:00.000Z',
    metrics: { likeCount: likes, commentCount: 0, shareCount: 0, impressionCount: impressions },
    ...extra,
  };
}

describe('socialPostPerformance (ENG-3123)', () => {
  it('AC2: rate = (likes+comments+shares)/impressions', () => {
    const p: PerformancePostInput = {
      id: 'a', platform: 'linkedin',
      metrics: { likeCount: 5, commentCount: 3, shareCount: 2, impressionCount: 100 },
    };
    expect(engagementRate(p)).toBeCloseTo(0.1);
  });

  it('AC2: zero/missing impressions or metrics are skipped, never NaN', () => {
    const res = analyzePostPerformance([
      post('z', 'linkedin', 10, 0),
      post('m', 'linkedin', 10, undefined),
      { id: 'n', platform: 'linkedin', metrics: null },
      post('ok', 'linkedin', 1, 10),
    ]);
    expect(res.skipped).toBe(3);
    expect(res.combined.eligible).toBe(1);
    const rates = res.combined.ranked.map(p => p.engagementRate);
    expect(rates.every(Number.isFinite)).toBe(true);
  });

  it('AC4: fewer than 4 eligible posts -> insufficientData without quartiles', () => {
    const res = analyzePostPerformance([post('a', 'x', 1, 10), post('b', 'x', 2, 10), post('c', 'x', 3, 10)]);
    expect(res.combined.insufficientData).toBe(true);
    expect(res.combined.topQuartile).toBeUndefined();
    expect(res.byPlatform.x.insufficientData).toBe(true);
    expect(res.featureDeltas).toEqual([]);
  });

  it('AC3: ranks within platform; combined never compares raw rates across platforms', () => {
    // LinkedIn rates 0.01..0.04; X rates 0.5..0.8 (much higher raw).
    const li = [1, 2, 3, 4].map(n => post(`li${n}`, 'linkedin', n, 100));
    const x = [5, 6, 7, 8].map(n => post(`x${n}`, 'x', n, 10));
    const res = analyzePostPerformance([...li, ...x]);

    expect(res.byPlatform.linkedin.ranked.map(p => p.id)).toEqual(['li4', 'li3', 'li2', 'li1']);
    expect(res.byPlatform.x.ranked.map(p => p.id)).toEqual(['x8', 'x7', 'x6', 'x5']);
    // Each platform's best is at the top of the combined ranking; raw-rate order would put all X first.
    const topTwo = res.combined.ranked.slice(0, 2).map(p => p.id).sort();
    expect(topTwo).toEqual(['li4', 'x8']);
    const bottomTwo = res.combined.ranked.slice(-2).map(p => p.id).sort();
    expect(bottomTwo).toEqual(['li1', 'x5']);
  });

  it('AC5: deterministic fixture -> expected top/bottom quartile and feature deltas', () => {
    const fixture = [
      post('p1', 'linkedin', 9, 100, { hasMedia: true }),
      post('p2', 'linkedin', 7, 100, { hasMedia: true }),
      post('p3', 'linkedin', 5, 100),
      post('p4', 'linkedin', 4, 100),
      post('p5', 'linkedin', 3, 100),
      post('p6', 'linkedin', 2, 100),
      post('p7', 'linkedin', 1, 100),
      post('p8', 'linkedin', 0, 100),
    ];
    const res = analyzePostPerformance(fixture);
    expect(res.combined.insufficientData).toBe(false);
    expect(res.combined.topQuartile!.map(p => p.id)).toEqual(['p1', 'p2']);
    expect(res.combined.bottomQuartile!.map(p => p.id)).toEqual(['p7', 'p8']);
    const media = res.featureDeltas.find(d => d.feature === 'hasMedia' && d.value === 'true')!;
    expect(media.count).toBe(2);
    expect(media.delta).toBeGreaterThan(0);
    const weekday = res.featureDeltas.find(d => d.feature === 'weekday')!;
    expect(weekday.value).toBe('1'); // 2026-11-02 is a Monday
  });
});
