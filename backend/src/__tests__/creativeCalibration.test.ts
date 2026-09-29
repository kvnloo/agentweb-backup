/**
 * ENG-2142: the weekly creative calibration sampler — ISO-week seeding, pairing, the judge-signal
 * preference, deterministic stratified selection and the judge-vs-human agreement math.
 */

import { cohensKappa, wilsonInterval } from '../loops/eval/agreement';
import {
  buildCalibrationPairs,
  calibrationWindow,
  isoWeekOf,
  isoWeekStart,
  pairCaseKey,
  pairSignal,
  pairwiseAgreement,
  priorFor,
  selectCalibrationPairs,
  toCalibrationCases,
  type CalibrationCandidate,
  type CalibrationPair,
  type PairwiseComparison,
} from '../loops/eval/creativeCalibration';
import { parseGoldenCase, type PairSignal } from '../loops/eval/goldenSet';
import { CREATIVE_GATES_GRADER_ID, type CreativeGateResult } from '../services/creativeGates';
import { CREATIVE_RUBRIC_GRADER_ID, RUBRIC_CRITERIA, type CreativeRubricResult, type RubricCriterionResult, type RubricCriterionId } from '../services/creativeRubricJudge';

function gates(placement?: CreativeGateResult['placement']): CreativeGateResult {
  return {
    graderId: CREATIVE_GATES_GRADER_ID,
    version: 'test',
    advisory: true,
    passed: true,
    checks: [],
    bytes: 1,
    fitsPlacements: [],
    evaluatedAt: '2026-09-15T00:00:00Z',
    ...(placement ? { placement } : {}),
  };
}

function rubric(passedCount: number): CreativeRubricResult {
  const criteria = Object.fromEntries(
    RUBRIC_CRITERIA.map((id, i) => [id, { rationale: 'r', verdict: i < passedCount ? 'pass' : 'fail' }]),
  ) as Record<RubricCriterionId, RubricCriterionResult>;
  return {
    graderId: CREATIVE_RUBRIC_GRADER_ID,
    version: 'test',
    promptVersion: 'test',
    advisory: true,
    model: 'test',
    evaluatedAt: '2026-09-15T00:00:00Z',
    mode: 'single',
    status: 'ok',
    criteria,
    passedCount,
    passed: passedCount === RUBRIC_CRITERIA.length,
  };
}

function cand(id: string, userId: string, createdAt: string, extra: Partial<CalibrationCandidate> = {}): CalibrationCandidate {
  return { candidateId: id, userId, reviewType: 'creative_image', artifactUrl: `https://img.test/${id}.png`, createdAt, category: 'ad', ...extra };
}

describe('ISO weeks', () => {
  it('names the ISO week in UTC, including year boundaries', () => {
    expect(isoWeekOf(new Date('2026-09-25T12:00:00Z'))).toBe('2026-W39');
    expect(isoWeekOf(new Date('2026-09-21T00:00:00Z'))).toBe('2026-W39');
    expect(isoWeekOf(new Date('2026-09-20T23:59:59Z'))).toBe('2026-W38');
    expect(isoWeekOf(new Date('2021-01-03T00:00:00Z'))).toBe('2020-W53');
    expect(isoWeekOf(new Date('2024-12-30T00:00:00Z'))).toBe('2025-W01');
  });

  it('round-trips a week to its Monday and rejects weeks that do not exist', () => {
    expect(isoWeekStart('2026-W39').toISOString()).toBe('2026-09-21T00:00:00.000Z');
    expect(isoWeekStart('2020-W53').toISOString()).toBe('2020-12-28T00:00:00.000Z');
    expect(isoWeekStart('2025-W01').toISOString()).toBe('2024-12-30T00:00:00.000Z');
    expect(isoWeekStart('2026-W53').toISOString()).toBe('2026-12-28T00:00:00.000Z');
    expect(() => isoWeekStart('2025-W53')).toThrow(/not a week of 2025/);
    expect(() => isoWeekStart('2026-W00')).toThrow();
    expect(() => isoWeekStart('2026-39')).toThrow(/ISO week/);
  });

  it('draws a batch from the closed week before it', () => {
    const w = calibrationWindow('2026-W39');
    expect(w.start.toISOString()).toBe('2026-09-14T00:00:00.000Z');
    expect(w.end.toISOString()).toBe('2026-09-21T00:00:00.000Z');
  });
});

describe('pairing', () => {
  const window = calibrationWindow('2026-W39');

  it('pairs a creative from the window with the prior best of the same account and placement', () => {
    const olderSame = cand('b1', 'u1', '2026-09-01T00:00:00Z', { creativeGates: gates('meta_feed_portrait'), creativeRubric: rubric(5) });
    const olderBetter = cand('b2', 'u1', '2026-08-01T00:00:00Z', { creativeGates: gates('meta_feed_portrait'), creativeRubric: rubric(6) });
    const otherPlacement = cand('b3', 'u1', '2026-09-10T00:00:00Z', { creativeGates: gates('meta_feed_square') });
    const a = cand('a1', 'u1', '2026-09-15T00:00:00Z', { creativeGates: gates('meta_feed_portrait'), creativeRubric: rubric(6) });
    const pairs = buildCalibrationPairs([olderSame, olderBetter, otherPlacement, a], window);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ userId: 'u1', category: 'ad', placement: 'meta_feed_portrait', signal: 'uncertain' });
    expect(pairs[0].a.candidateId).toBe('a1');
    expect(pairs[0].b.candidateId).toBe('b2');
  });

  it('falls back, when the placement is unknown, to the latest earlier creative of the same account and category with none either', () => {
    const pool = [
      cand('old', 'u1', '2026-08-01T00:00:00Z'),
      cand('recent', 'u1', '2026-09-10T00:00:00Z'),
      cand('organic', 'u1', '2026-09-12T00:00:00Z', { category: 'organic_post' }),
      cand('placed', 'u1', '2026-09-13T00:00:00Z', { creativeGates: gates('meta_feed_square') }),
      cand('otherUser', 'u2', '2026-09-13T00:00:00Z'),
    ];
    const a = cand('a', 'u1', '2026-09-15T00:00:00Z');
    expect(priorFor(a, [...pool, a])?.candidateId).toBe('recent');
    const pairs = buildCalibrationPairs([...pool, a], window);
    expect(pairs.map((p) => [p.a.candidateId, p.b.candidateId, p.placement])).toEqual([['a', 'recent', 'unknown']]);
  });

  it('leaves out creatives outside the window, evaluation accounts, creatives with no prior and non-images', () => {
    const pairs = buildCalibrationPairs(
      [
        cand('p', 'u1', '2026-09-01T00:00:00Z'),
        cand('tooLate', 'u1', '2026-09-21T00:00:00Z'),
        cand('tooEarly', 'u1', '2026-09-13T23:59:59Z'),
        cand('evalPrior', 'eval_bot', '2026-09-01T00:00:00Z'),
        cand('evalA', 'eval_bot', '2026-09-15T00:00:00Z'),
        cand('lonely', 'u3', '2026-09-15T00:00:00Z'),
        { ...cand('lp', 'u1', '2026-09-16T00:00:00Z'), reviewType: 'landing_page' },
        cand('inside', 'u1', '2026-09-20T23:00:00Z'),
      ],
      window,
    );
    expect(pairs.map((p) => p.a.candidateId)).toEqual(['inside']);
  });

  it('pairs a landing page with the account\'s previous landing page, never with an image (ENG-2192)', () => {
    const lp = (id: string, createdAt: string) => cand(id, 'u1', createdAt, { reviewType: 'landing_page', category: undefined, artifactUrl: `https://lp.test/${id}` });
    const pairs = buildCalibrationPairs(
      [lp('lp-old', '2026-08-01T00:00:00Z'), lp('lp-prev', '2026-09-10T00:00:00Z'), cand('img', 'u1', '2026-09-12T00:00:00Z'), lp('lp-new', '2026-09-16T00:00:00Z')],
      window,
    );

    expect(pairs.map((p) => [p.a.candidateId, p.b.candidateId, p.category, p.placement])).toEqual([['lp-new', 'lp-prev', 'landing_page', 'unknown']]);
  });

  it('ranks the judge signal: passed-but-a-reviewer-replied, then close scores, then unscored, then clear', () => {
    const at = '2026-09-15T00:00:00Z';
    expect(pairSignal(cand('a', 'u', at, { creativeRubric: rubric(7), feedback: [{}] }), cand('b', 'u', at, { creativeRubric: rubric(2) }))).toBe('disagree');
    expect(pairSignal(cand('a', 'u', at, { creativeRubric: rubric(7) }), cand('b', 'u', at, { creativeRubric: rubric(6) }))).toBe('uncertain');
    expect(pairSignal(cand('a', 'u', at, { creativeRubric: rubric(7) }), cand('b', 'u', at))).toBe('unscored');
    expect(pairSignal(cand('a', 'u', at, { creativeRubric: rubric(7) }), cand('b', 'u', at, { creativeRubric: rubric(4) }))).toBe('clear');
    // A reviewer reply alone is not a disagreement: the judge has to have passed that creative.
    expect(pairSignal(cand('a', 'u', at, { creativeRubric: rubric(3), feedback: [{}] }), cand('b', 'u', at, { creativeRubric: rubric(6) }))).toBe('clear');
  });
});

function pair(n: number, userId: string, category: string, placement: string, signal: PairSignal = 'unscored'): CalibrationPair {
  const at = '2026-09-15T00:00:00Z';
  return { a: cand(`a${n}`, userId, at), b: cand(`b${n}`, userId, at), userId, category, placement, signal };
}

function countBy<T>(items: readonly T[], key: (item: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) out[key(item)] = (out[key(item)] ?? 0) + 1;
  return out;
}

describe('stratified selection', () => {
  const pool = (): CalibrationPair[] => {
    const pairs: CalibrationPair[] = [];
    let n = 0;
    // Deliberately lopsided: one big stratum, two small ones; one big account.
    for (let i = 0; i < 30; i++) pairs.push(pair(n++, i % 3 === 0 ? 'u2' : 'u1', 'ad', 'meta_feed_portrait'));
    for (let i = 0; i < 6; i++) pairs.push(pair(n++, 'u3', 'ad', 'unknown'));
    for (let i = 0; i < 6; i++) pairs.push(pair(n++, 'u4', 'organic_post', 'unknown'));
    return pairs;
  };

  it('draws the same batch for the same week whatever order the rows arrive in', () => {
    const forward = selectCalibrationPairs(pool(), { batch: '2026-W39' });
    const reversed = selectCalibrationPairs([...pool()].reverse(), { batch: '2026-W39' });
    expect(reversed.map(pairCaseKey)).toEqual(forward.map(pairCaseKey));
    expect(forward).toHaveLength(20);
  });

  it('draws a different batch in another week', () => {
    const w39 = selectCalibrationPairs(pool(), { batch: '2026-W39' }).map(pairCaseKey);
    const w40 = selectCalibrationPairs(pool(), { batch: '2026-W40' }).map(pairCaseKey);
    expect(w40).not.toEqual(w39);
  });

  it('spreads the batch over strata and accounts instead of following the biggest one', () => {
    const picked = selectCalibrationPairs(pool(), { batch: '2026-W39', target: 12 });
    // cap = ceil(12 / 4 accounts) = 3: the two small strata each belong to one account, so they
    // stop at 3 and the rest comes from the big stratum's two accounts, 3 each.
    expect(countBy(picked, (p) => p.userId)).toEqual({ u1: 3, u2: 3, u3: 3, u4: 3 });
    expect(countBy(picked, (p) => `${p.category}|${p.placement}`)).toEqual({ 'ad|meta_feed_portrait': 6, 'ad|unknown': 3, 'organic_post|unknown': 3 });
    // Round-robin: the first three picks come from three different strata.
    expect(new Set(picked.slice(0, 3).map((p) => `${p.category}|${p.placement}`)).size).toBe(3);
  });

  it('fills past the account cap when the pool is too narrow to reach the target otherwise', () => {
    const narrow = [pair(1, 'u1', 'ad', 'x'), pair(2, 'u1', 'ad', 'x'), pair(3, 'u1', 'ad', 'x'), pair(4, 'u2', 'ad', 'x')];
    expect(selectCalibrationPairs(narrow, { batch: '2026-W39', target: 4 })).toHaveLength(4);
    expect(selectCalibrationPairs(narrow, { batch: '2026-W39', target: 10 })).toHaveLength(4);
  });

  it('prefers disagreement and close calls over unscored and clear pairs', () => {
    const pairs = [
      ...Array.from({ length: 10 }, (_, i) => pair(i, `u${i}`, 'ad', 'x', 'clear')),
      ...Array.from({ length: 10 }, (_, i) => pair(10 + i, `u${10 + i}`, 'ad', 'x', 'unscored')),
      pair(90, 'u90', 'ad', 'x', 'uncertain'),
      pair(91, 'u91', 'ad', 'x', 'disagree'),
      pair(92, 'u92', 'ad', 'x', 'uncertain'),
    ];
    const picked = selectCalibrationPairs(pairs, { batch: '2026-W39', target: 5 });
    expect(picked.map((p) => p.signal)).toEqual(['disagree', 'uncertain', 'uncertain', 'unscored', 'unscored']);
  });

  it('never draws a pair that an earlier batch already holds', () => {
    const all = pool();
    const excludeCaseIds = new Set(all.slice(0, 35).map(pairCaseKey));
    const picked = selectCalibrationPairs(all, { batch: '2026-W39', excludeCaseIds });
    expect(picked).toHaveLength(7);
    expect(picked.some((p) => excludeCaseIds.has(pairCaseKey(p)))).toBe(false);
  });

  it('turns the draw into valid pairwise golden cases in draw order', () => {
    const picked = selectCalibrationPairs(pool(), { batch: '2026-W39', target: 3 });
    const cases = toCalibrationCases(picked, '2026-W39', new Date('2026-09-21T06:00:00Z'));
    expect(cases.map((c) => c.pair?.position)).toEqual([0, 1, 2]);
    expect(cases.every((c) => c.pair?.batchSize === 3 && c.pair.batch === '2026-W39')).toBe(true);
    expect(cases.map((c) => c.caseId)).toEqual(picked.map(pairCaseKey));
    for (const c of cases) expect(parseGoldenCase(c)).toEqual(c);
  });
});

describe('judge-vs-human pairwise agreement', () => {
  const rows = (): PairwiseComparison[] => [
    ...Array.from({ length: 3 }, (): PairwiseComparison => ({ human: 'A', judge: 'A' })),
    ...Array.from({ length: 2 }, (): PairwiseComparison => ({ human: 'B', judge: 'B' })),
    { human: 'tie', judge: 'tie' },
    ...Array.from({ length: 2 }, (): PairwiseComparison => ({ human: 'A', judge: 'B' })),
    { human: 'B', judge: 'A' },
    { human: 'tie', judge: 'A' },
  ];

  it('reports n, agreement with a Wilson CI, kappa, decisive-only agreement and both win rates', () => {
    const r = pairwiseAgreement(rows(), { iterations: 200 });
    expect(r.n).toBe(10);
    expect(r.agreement.rate).toBeCloseTo(0.6, 10);
    expect(r.agreement.ci).toEqual(wilsonInterval(6, 10));
    expect(r.kappa.n).toBe(10);
    expect(r.kappa.kappa).toBeCloseTo(cohensKappa(rows().map((x) => ({ truth: x.human, predicted: x.judge }))), 10);
    expect(r.kappa.kappaCI.low).toBeLessThanOrEqual(r.kappa.kappa);
    expect(r.kappa.kappaCI.high).toBeGreaterThanOrEqual(r.kappa.kappa);
    // Decisive: drop every row with a tie on either side -> 8 rows, 5 agree.
    expect(r.decisive).toEqual({ n: 8, rate: 5 / 8, ci: wilsonInterval(5, 8) });
    // Human: A 5, B 3, tie 2 -> (5 + 1) / 10. Judge: A 5, B 4, tie 1 -> (5 + 0.5) / 10.
    expect(r.humanWinRateA).toBeCloseTo(0.6, 10);
    expect(r.judgeWinRateA).toBeCloseTo(0.55, 10);
  });

  it('has no decisive agreement when every row has a tie, and needs at least one row', () => {
    expect(pairwiseAgreement([{ human: 'tie', judge: 'A' }], { iterations: 10 }).decisive).toBeNull();
    expect(() => pairwiseAgreement([])).toThrow(/at least one/);
  });
});
