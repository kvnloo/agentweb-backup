/**
 * ENG-2141: rubric score vs settled ad CTR/CPA — aggregation, settling-window exclusion, and the
 * read-only loader. Rows are synthetic ad rows in the AdsMetricsAdRow shape.
 */
import { spearmanRho } from '../loops/eval/agreement';
import {
  aggregateCreative,
  creativePerformanceReport,
  readRubricScore,
  type AdDayMetrics,
  type CreativeObservation,
} from '../loops/eval/creativePerformance';
import { formatReport, loadCreativeObservations, parseArgs, type ReadOnlyReader } from '../scripts/creativePerformanceCorrelation';

/** Settled: captured 40 days after the reporting date. */
function settledRow(date: string, over: Partial<AdDayMetrics> = {}): AdDayMetrics {
  const captured = new Date(`${date}T09:00:00.000Z`);
  captured.setUTCDate(captured.getUTCDate() + 40);
  return { date, capturedAt: captured.toISOString(), currency: 'USD', spend: 10, impressions: 1000, clicks: 10, platformLeadCount: 1, ...over };
}

/** Unsettled: captured 5 days after the reporting date (still inside Meta's revision window). */
function unsettledRow(date: string, over: Partial<AdDayMetrics> = {}): AdDayMetrics {
  const captured = new Date(`${date}T09:00:00.000Z`);
  captured.setUTCDate(captured.getUTCDate() + 5);
  return { ...settledRow(date, over), capturedAt: captured.toISOString() };
}

function creative(id: string, rubricScore: number | null, rows: AdDayMetrics[], linkedAt = '2026-07-01T10:00:00.000Z'): CreativeObservation {
  return { creativeId: id, rubricScore, ads: [{ adId: `ad-${id}`, via: 'create_ad', linkedAt, rows }] };
}

describe('aggregateCreative', () => {
  it('sums settled rows across the creative\'s ads and counts unsettled rows separately', () => {
    const obs: CreativeObservation = {
      creativeId: 'c',
      rubricScore: 5,
      ads: [
        { adId: 'a1', via: 'create_ad', linkedAt: '2026-07-01T10:00:00.000Z', rows: [settledRow('2026-07-01'), settledRow('2026-07-02', { clicks: 30 })] },
        { adId: 'a2', via: 'copy_ad', linkedAt: '2026-07-03T10:00:00.000Z', rows: [settledRow('2026-07-03', { spend: 5, platformLeadCount: 0 }), unsettledRow('2026-07-04')] },
      ],
    };
    expect(aggregateCreative(obs)).toEqual({
      creativeId: 'c', rubricScore: 5, impressions: 3000, clicks: 50, spend: 25, leads: 2, currency: 'USD', settledRows: 3, unsettledRows: 1,
    });
  });

  it('ignores days before the ad carried the creative, and a swap\'s shared link day', () => {
    const rows = [settledRow('2026-06-30'), settledRow('2026-07-01'), settledRow('2026-07-02')];
    expect(aggregateCreative(creative('new', 3, rows)).settledRows).toBe(2);
    const swapped: CreativeObservation = { creativeId: 's', rubricScore: 3, ads: [{ adId: 'a', via: 'swap_creative', linkedAt: '2026-07-01T10:00:00.000Z', rows }] };
    expect(aggregateCreative(swapped).settledRows).toBe(1);
  });

  it('reports no single currency when settled rows span several', () => {
    const obs = creative('m', 4, [settledRow('2026-07-01'), settledRow('2026-07-02', { currency: 'INR' })]);
    expect(aggregateCreative(obs).currency).toBeNull();
  });
});

describe('creativePerformanceReport', () => {
  // CTR = clicks / 1000 per day, rising with score except one swap; CPA = 10 / leads.
  const data = [
    creative('c1', 1, [settledRow('2026-07-01', { clicks: 5, platformLeadCount: 1 })]),
    creative('c2', 3, [settledRow('2026-07-01', { clicks: 12, platformLeadCount: 2 })]),
    creative('c3', 4, [settledRow('2026-07-01', { clicks: 9, platformLeadCount: 4 })]),
    creative('c4', 6, [settledRow('2026-07-01', { clicks: 20, platformLeadCount: 5 })]),
    creative('c5', 7, [settledRow('2026-07-01', { clicks: 25, platformLeadCount: 10 })]),
  ];

  it('correlates score with CTR and CPA on exactly the pairs a hand computation uses', () => {
    const report = creativePerformanceReport(data, { iterations: 200, seed: 3 });
    const scores = [1, 3, 4, 6, 7];
    expect(report.ctr.n).toBe(5);
    expect(report.ctr.result!.rho).toBeCloseTo(spearmanRho(scores.map((x, i) => ({ x, y: [5, 12, 9, 20, 25][i] / 1000 }))), 12);
    expect(report.ctr.result!.rho).toBeCloseTo(0.9, 12);
    expect(report.cpaByCurrency.USD.n).toBe(5);
    // CPA falls strictly as the score rises: rho = -1.
    expect(report.cpaByCurrency.USD.result!.rho).toBeCloseTo(-1, 12);
  });

  it('excludes creatives whose linked ads have only unsettled rows (settling-window exclusion)', () => {
    const withUnsettled = [...data, creative('late', 7, [unsettledRow('2026-09-20', { clicks: 1 }), unsettledRow('2026-09-21', { clicks: 1 })])];
    const report = creativePerformanceReport(withUnsettled, { iterations: 200, seed: 3 });
    expect(report.excluded.noSettledRows).toBe(1);
    expect(report.unsettledRowsExcluded).toBe(2);
    expect(report.ctr.n).toBe(5);
    expect(report.ctr.result!.rho).toBeCloseTo(0.9, 12);
  });

  it('counts every other exclusion and keeps CPA per currency', () => {
    const report = creativePerformanceReport([
      ...data,
      creative('unscored', null, [settledRow('2026-07-01')]),
      creative('thin', 5, [settledRow('2026-07-01', { impressions: 50, clicks: 1 })]),
      creative('noLeads', 5, [settledRow('2026-07-01', { platformLeadCount: 0 })]),
      creative('mixed', 5, [settledRow('2026-07-01'), settledRow('2026-07-02', { currency: 'INR' })]),
      creative('inr', 2, [settledRow('2026-07-01', { currency: 'INR' })]),
    ], { minImpressions: 100 });
    expect(report.excluded).toEqual({ noRubricScore: 1, noSettledRows: 0, belowMinImpressions: 1, noConversions: 1, mixedCurrency: 1 });
    expect(report.cpaByCurrency.INR).toEqual({ n: 1, result: null });
    expect(report.cpaByCurrency.USD.n).toBe(6);
  });

  it('does not compute a correlation below n = 3', () => {
    expect(creativePerformanceReport(data.slice(0, 2)).ctr).toEqual({ n: 2, result: null });
  });
});

describe('readRubricScore', () => {
  it('reads passedCount only from an ok single-mode rubric result', () => {
    expect(readRubricScore({ mode: 'single', status: 'ok', passedCount: 6 })).toBe(6);
    expect(readRubricScore({ mode: 'single', status: 'skipped', reason: 'gates failed' })).toBeNull();
    expect(readRubricScore({ mode: 'single', status: 'error' })).toBeNull();
    expect(readRubricScore({ mode: 'pairwise', status: 'ok', passedCount: 6 })).toBeNull();
    expect(readRubricScore(undefined)).toBeNull();
  });
});

describe('creativePerformanceCorrelation loader (read-only)', () => {
  const tables = { lineage: 'L', humanEval: 'H', adsMetrics: 'M' };

  function reader(): jest.Mocked<ReadOnlyReader> {
    return {
      scan: jest.fn().mockResolvedValue({
        Items: [
          {
            creativeId: 'cr_1',
            humanEvalCandidateId: 'cand-1',
            metaAdLinks: [{ accountId: '1000', adId: 'ad-1', metaCreativeId: 'mc', via: 'create_ad', linkedAt: '2026-07-01T10:00:00.000Z' }],
          },
          { creativeId: 'cr_2', metaAdLinks: [] },
        ],
      }),
      query: jest.fn().mockResolvedValue({ Items: [settledRow('2026-07-01')] }),
      get: jest.fn().mockResolvedValue({ Item: { creativeRubric: { mode: 'single', status: 'ok', passedCount: 5 } } }),
    };
  }

  it('reads linked creatives, their candidate\'s rubric score and each ad\'s rows from the link date', async () => {
    const r = reader();
    const { observations, truncatedAds } = await loadCreativeObservations(r, tables);

    expect(truncatedAds).toBe(0);
    expect(r.scan).toHaveBeenCalledWith(expect.objectContaining({ TableName: 'L', FilterExpression: 'attribute_exists(metaAdLinks)' }));
    expect(r.get).toHaveBeenCalledWith({ TableName: 'H', Key: { candidateId: 'cand-1' }, ProjectionExpression: 'creativeRubric' });
    expect(r.query).toHaveBeenCalledWith(expect.objectContaining({
      TableName: 'M',
      ExpressionAttributeValues: { ':entityKey': 'meta#1000#ad#ad-1', ':since': '2026-07-01' },
    }));
    expect(observations).toEqual([
      { creativeId: 'cr_1', rubricScore: 5, ads: [{ adId: 'ad-1', via: 'create_ad', linkedAt: '2026-07-01T10:00:00.000Z', rows: [settledRow('2026-07-01')] }] },
      { creativeId: 'cr_2', rubricScore: null, ads: [] },
    ]);
  });

  it('leaves out a creative whose ad series hit the read cap rather than under-counting it', async () => {
    const r = reader();
    r.query.mockResolvedValue({ Items: [{ ...settledRow('2026-07-01') }], LastEvaluatedKey: { entityKey: 'k' } });
    const { observations, truncatedAds } = await loadCreativeObservations(r, tables);
    expect(truncatedAds).toBe(1);
    expect(observations.map((o) => o.creativeId)).toEqual(['cr_2']);
  });

  it('parses flags and prints n, rho and CI', () => {
    expect(() => parseArgs(['--min-impressions'])).toThrow(/needs a value/);
    expect(() => parseArgs(['--min-impressions', '-1'])).toThrow(/non-negative/);
    const opts = parseArgs(['--min-impressions', '500', '--json']);
    expect(opts).toEqual({ table: undefined, minImpressions: 500, minConversions: 1, perCreative: false, json: true });
    const lines = formatReport(creativePerformanceReport([
      creative('a', 1, [settledRow('2026-07-01', { clicks: 1 })]),
      creative('b', 2, [settledRow('2026-07-01', { clicks: 2 })]),
      creative('c', 3, [settledRow('2026-07-01', { clicks: 3 })]),
    ], { iterations: 50 }), 0, opts);
    expect(lines.find((l) => l.startsWith('Rubric score vs CTR'))).toMatch(/rho=1\.000 {2}n=3 {2}95% CI \[/);
  });
});
