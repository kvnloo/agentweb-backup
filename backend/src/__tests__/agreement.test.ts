/**
 * ENG-2136: judge-vs-human agreement metrics. Expected values are hand-computed or from an
 * independent implementation of the textbook formulas, not read back from this module.
 */
import {
  agreementReport,
  averageRanks,
  bootstrapCI,
  cohensKappa,
  pairwiseWinRate,
  perClassMetrics,
  rocAuc,
  spearmanReport,
  spearmanRho,
  toGraderValidation,
  weightedKappa,
  wilsonInterval,
  type LabelPair,
  type XYPair,
} from '../loops/eval/agreement';

const pairs = <L extends string | number>(truth: L[], predicted: L[]): LabelPair<L>[] =>
  truth.map((t, i) => ({ truth: t, predicted: predicted[i] }));

/** 2x2 table [[20, 5], [10, 15]]: po = 0.7, pe = 0.5, kappa = 0.4. */
function textbookTable(): LabelPair<string>[] {
  const out: LabelPair<string>[] = [];
  const push = (t: string, p: string, k: number) => { for (let i = 0; i < k; i++) out.push({ truth: t, predicted: p }); };
  push('pass', 'pass', 20);
  push('pass', 'fail', 5);
  push('fail', 'pass', 10);
  push('fail', 'fail', 15);
  return out;
}

const A = [0, 1, 2, 0, 1, 2, 2, 1];
const B = [0, 1, 2, 1, 2, 0, 2, 1];

describe('cohensKappa', () => {
  it('matches the textbook 2x2 value', () => {
    expect(cohensKappa(textbookTable())).toBeCloseTo(0.4, 10);
  });

  it('matches the independent value on a 3-class example', () => {
    expect(cohensKappa(pairs(A, B))).toBeCloseTo(0.428571428571, 9);
  });

  it('is 1 for perfect agreement, including the single-class case', () => {
    expect(cohensKappa(pairs(['a', 'b'], ['a', 'b']))).toBe(1);
    expect(cohensKappa(pairs(['a', 'a'], ['a', 'a']))).toBe(1);
  });

  it('rejects an empty set', () => {
    expect(() => cohensKappa([])).toThrow();
  });
});

describe('weightedKappa', () => {
  it('matches independent quadratic and linear values', () => {
    expect(weightedKappa(pairs(A, B), { min: 0, max: 2 }, 'quadratic')).toBeCloseTo(0.384615384615, 9);
    expect(weightedKappa(pairs(A, B), { min: 0, max: 2 }, 'linear')).toBeCloseTo(0.407407407407, 9);
  });

  it('is 1 for identical 1-5 judge scores and rejects out-of-scale labels', () => {
    expect(weightedKappa(pairs([1, 3, 5], [1, 3, 5]), { min: 1, max: 5 })).toBe(1);
    expect(() => weightedKappa(pairs([6], [1]), { min: 1, max: 5 })).toThrow(/out of scale/);
  });
});

describe('perClassMetrics', () => {
  it('computes precision, recall and support per class with human labels as truth', () => {
    const m = perClassMetrics(pairs(A, B));
    expect(m['2'].precision).toBeCloseTo(2 / 3, 10);
    expect(m['2'].recall).toBeCloseTo(2 / 3, 10);
    expect(m['2'].support).toBe(3);
  });

  it('scores F1 as 0, not null, for a class the grader always gets wrong', () => {
    const m = perClassMetrics(pairs(['a', 'b', 'a'], ['b', 'a', 'a']));
    // class b: tp 0, fp 1, fn 1 -> precision 0, recall 0, F1 0
    expect(m.b).toEqual({ precision: 0, recall: 0, f1: 0, support: 1 });
    // class a: tp 1, fp 1, fn 1 -> F1 = 2/4
    expect(m.a.f1).toBeCloseTo(0.5, 10);
  });

  it('returns null instead of dividing by zero', () => {
    const m = perClassMetrics(pairs(['fail', 'fail'], ['pass', 'pass']));
    expect(m.fail.precision).toBeNull();
    expect(m.fail.recall).toBe(0);
    expect(m.pass.precision).toBe(0);
    expect(m.pass.recall).toBeNull();
  });
});

describe('wilsonInterval', () => {
  it('matches the reference interval for 8/10 and 0/10', () => {
    const a = wilsonInterval(8, 10);
    expect(a.low).toBeCloseTo(0.490162, 5);
    expect(a.high).toBeCloseTo(0.943318, 5);
    const b = wilsonInterval(0, 10);
    expect(b.low).toBe(0);
    expect(b.high).toBeCloseTo(0.277533, 5);
  });

  it('rejects impossible counts', () => {
    expect(() => wilsonInterval(3, 0)).toThrow();
    expect(() => wilsonInterval(11, 10)).toThrow();
  });
});

describe('bootstrapCI and agreementReport', () => {
  it('rejects iteration counts and levels that cannot give an interval', () => {
    const data = textbookTable();
    for (const iterations of [0, -5, 1.5, Number.NaN]) {
      expect(() => bootstrapCI(data, cohensKappa, { iterations })).toThrow(/iterations/);
    }
    for (const level of [0, 1, 1.2, Number.NaN]) {
      expect(() => bootstrapCI(data, cohensKappa, { level })).toThrow(/level/);
    }
  });

  it('is reproducible for a fixed seed and brackets the point estimate', () => {
    const data = textbookTable();
    const a = bootstrapCI(data, cohensKappa, { seed: 7, iterations: 500 });
    const b = bootstrapCI(data, cohensKappa, { seed: 7, iterations: 500 });
    expect(a).toEqual(b);
    expect(a.low).toBeLessThan(0.4);
    expect(a.high).toBeGreaterThan(0.4);
  });

  it('reports n, observed agreement, kappa with CI and per-class metrics', () => {
    const r = agreementReport(textbookTable(), { seed: 1, iterations: 200 });
    expect(r.n).toBe(50);
    expect(r.observedAgreement).toBeCloseTo(0.7, 10);
    expect(r.kappa).toBeCloseTo(0.4, 10);
    expect(r.kappaCI.low).toBeLessThanOrEqual(r.kappa);
    expect(r.perClass.pass.support).toBe(25);
  });

  it('produces the registry validation record', () => {
    const r = agreementReport(textbookTable(), { seed: 1, iterations: 50 });
    expect(toGraderValidation(r, 'https://linear.app/x', new Date('2026-09-25T10:00:00Z')))
      .toEqual({ kappa: r.kappa, n: 50, date: '2026-09-25', evidence: 'https://linear.app/x' });
    expect(toGraderValidation(r, 'https://linear.app/x', new Date('2026-09-25T10:00:00Z'), 'human'))
      .toEqual({ kappa: r.kappa, n: 50, date: '2026-09-25', evidence: 'https://linear.app/x', labelSource: 'human' });
  });
});

describe('pairwiseWinRate', () => {
  it('counts ties as half and puts a Wilson CI on decisive comparisons', () => {
    const r = pairwiseWinRate(['A', 'A', 'B', 'tie']);
    expect(r.n).toBe(4);
    expect(r.winRateA).toBeCloseTo(0.625, 10);
    expect(r.ties).toBe(1);
    expect(r.decisiveCI).toEqual(wilsonInterval(2, 3));
    expect(pairwiseWinRate(['tie']).decisiveCI).toBeNull();
  });
});

describe('rocAuc', () => {
  it('is the share of positive/negative pairs ranked correctly, ties counting half', () => {
    // Positives 5,4,3 vs negatives 4,2: pairs (5,4)(5,2)(4,4)(4,2)(3,4)(3,2) = 1+1+0.5+1+0+1 = 4.5 of 6.
    expect(rocAuc(pairs([1, 1, 1, 0, 0], [5, 4, 3, 4, 2]))).toBeCloseTo(0.75, 10);
  });

  it('is 1 for perfect separation, 0 for inverted, 0.5 for a constant score', () => {
    expect(rocAuc(pairs([1, 1, 0, 0], [5, 4, 2, 1]))).toBe(1);
    expect(rocAuc(pairs([1, 1, 0, 0], [1, 2, 4, 5]))).toBe(0);
    expect(rocAuc(pairs([1, 0, 1, 0], [5, 5, 5, 5]))).toBe(0.5);
  });

  it('returns 0.5 when a class is missing, so bootstrap resamples stay finite', () => {
    expect(rocAuc(pairs([1, 1], [5, 3]))).toBe(0.5);
    const ci = bootstrapCI(pairs([1, 1, 1, 0, 0], [5, 4, 3, 4, 2]), rocAuc, { iterations: 200, seed: 7 });
    expect(Number.isFinite(ci.low) && Number.isFinite(ci.high)).toBe(true);
    expect(ci.low).toBeLessThanOrEqual(ci.high);
  });
});

describe('Spearman rank correlation (ENG-2141)', () => {
  const xy = (xs: number[], ys: number[]): XYPair[] => xs.map((x, i) => ({ x, y: ys[i] }));

  it('gives tied values the mean of their positions', () => {
    expect(averageRanks([10, 20, 20, 30])).toEqual([1, 2.5, 2.5, 4]);
    expect(averageRanks([3, 1, 3, 3])).toEqual([3, 1, 3, 3]);
  });

  it('matches the textbook IQ vs hours-of-TV example: rho = -29/165 (no ties; = 1 - 6*194/990)', () => {
    const iq = [106, 100, 86, 101, 99, 103, 97, 113, 112, 110];
    const tv = [7, 27, 2, 50, 28, 29, 20, 12, 6, 17];
    expect(spearmanRho(xy(iq, tv))).toBeCloseTo(-29 / 165, 12);
  });

  it('is +1 / -1 for any strictly monotone relation, not only a linear one', () => {
    const x = [1, 2, 3, 4, 5, 6];
    expect(spearmanRho(xy(x, x.map((v) => Math.exp(v))))).toBeCloseTo(1, 12);
    expect(spearmanRho(xy(x, x.map((v) => -(v ** 3))))).toBeCloseTo(-1, 12);
  });

  it('uses the tie-correct form: y ranks [1,2,3.5,5,3.5] give 8/sqrt(95), not the no-ties shortcut', () => {
    // dx = [-2,-1,0,1,2], dy = [-2,-1,0.5,2,0.5]: sum dxdy = 8, sum dx^2 = 10, sum dy^2 = 9.5.
    const rho = spearmanRho(xy([1, 2, 3, 4, 5], [5, 6, 7, 8, 7]));
    expect(rho).toBeCloseTo(8 / Math.sqrt(95), 12);
    // The shortcut 1 - 6*sum(d^2)/(n(n^2-1)) with d = [0,0,0.5,1,-1.5] would give 0.825.
    expect(rho).not.toBeCloseTo(0.825, 3);
  });

  it('is undefined (NaN) when a variable is constant, and refuses bad input', () => {
    expect(spearmanRho(xy([1, 2, 3], [4, 4, 4]))).toBeNaN();
    expect(() => spearmanRho(xy([1], [2]))).toThrow(/at least two/);
    expect(() => spearmanRho(xy([1, NaN], [2, 3]))).toThrow(/non-finite/);
  });

  it('reports n, rho and a reproducible bootstrap CI bracketing rho', () => {
    const data = xy([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], [2, 1, 4, 3, 6, 5, 8, 7, 10, 9]);
    const a = spearmanReport(data, { iterations: 500, seed: 7 });
    const b = spearmanReport(data, { iterations: 500, seed: 7 });
    expect(a).toEqual(b);
    expect(a.n).toBe(10);
    expect(a.rho).toBeCloseTo(1 - (6 * 10) / 990, 12);
    expect(a.ci!.low).toBeLessThanOrEqual(a.rho!);
    expect(a.ci!.high).toBeGreaterThanOrEqual(a.rho!);
    expect(a.ci!.high).toBeLessThanOrEqual(1);
  });

  it('drops and counts resamples on which rho is undefined instead of sorting NaN into the CI', () => {
    const r = spearmanReport(xy([1, 2, 3], [1, 2, 3]), { iterations: 400, seed: 1 });
    expect(r.rho).toBeCloseTo(1, 12);
    // With n = 3, a resample often draws one point three times (constant x): undefined there.
    expect(r.undefinedResamples).toBeGreaterThan(0);
    expect(Number.isFinite(r.ci!.low) && Number.isFinite(r.ci!.high)).toBe(true);
    expect(spearmanReport(xy([1, 1], [2, 3])).rho).toBeNull();
    expect(spearmanReport(xy([1, 1], [2, 3])).ci).toBeNull();
  });
});
