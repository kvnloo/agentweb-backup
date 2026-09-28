/**
 * ENG-2138: offline replay of the shadow outcome judge vs deterministic task success. The
 * argument parser is strict (a typo must not start live judge calls) and the report is
 * aggregates only.
 */
import { parseArgs, summarizeReplay, type JudgedSession } from '../scripts/evalOutcomeJudge';
import { DEFAULT_OUTCOME_JUDGE_MODEL } from '../services/outcomeJudge';

describe('evalOutcomeJudge parseArgs', () => {
  it('parses a replay window with defaults', () => {
    expect(parseArgs(['--from', '2026-09-14', '--to', '2026-09-27'])).toEqual({
      mode: 'replay',
      from: '2026-09-14T00:00:00.000Z',
      to: '2026-09-27T23:59:59.999Z',
      sample: 150,
      seed: 'eng-2138',
      model: DEFAULT_OUTCOME_JUDGE_MODEL,
      dryRun: false,
    });
  });

  it('rejects unknown flags, missing operands, bad dates and a reversed window', () => {
    expect(() => parseArgs(['--from', '2026-09-14', '--to', '2026-09-27', '--dryrun'])).toThrow(/unknown argument/);
    expect(() => parseArgs(['--from', '--to', '2026-09-27'])).toThrow(/--from needs a value/);
    expect(() => parseArgs(['--from', '2026-02-30', '--to', '2026-03-02'])).toThrow(/--from must be a date/);
    expect(() => parseArgs(['--from', '2026-09-27', '--to', '2026-09-14'])).toThrow(/must not be after/);
    expect(() => parseArgs(['--from', '2026-09-14', '--to', '2026-09-27', '--sample', '0'])).toThrow(/positive integer/);
  });

  it('prints the OPS-1 row only with a sample rate in (0, 1]', () => {
    expect(parseArgs(['--print-judge-row', '--sample-rate', '0.33'])).toEqual({ mode: 'print-row', sampleRate: 0.33, model: DEFAULT_OUTCOME_JUDGE_MODEL });
    expect(() => parseArgs(['--print-judge-row'])).toThrow(/--sample-rate/);
    expect(() => parseArgs(['--print-judge-row', '--sample-rate', '0'])).toThrow(/--sample-rate/);
  });
});

describe('summarizeReplay', () => {
  const row = (success: boolean, score: number, model = 'm-a'): JudgedSession => ({ success, score, model });

  it('reports AUC, share at 5, histogram, means and per-model rows from n >= 5', () => {
    const rows = [
      row(true, 5), row(true, 4), row(true, 4), row(true, 3), row(true, 4),
      row(false, 2, 'm-b'), row(false, 3, 'm-b'), row(false, 4, 'm-b'), row(false, 1, 'm-b'), row(false, 2, 'm-b'),
      row(false, 5, 'm-c'),
    ];
    const s = summarizeReplay(rows);
    // Positives {5,4,4,3,4} vs negatives {2,3,4,1,2,5}: wins = 5.5 + 3 x 4.5 + 3.5 = 22.5 of 30.
    expect(s.auc).toBeCloseTo(0.75, 10);
    expect(s.aucCI).not.toBeNull();
    expect(s.shareAt5).toBeCloseTo(2 / 11, 10);
    expect(s.histogram).toEqual({ 1: 1, 2: 2, 3: 2, 4: 4, 5: 2 });
    expect(s.meanScore.success).toBeCloseTo(4, 10);
    expect(s.meanScore.failure).toBeCloseTo(17 / 6, 10);
    expect(s.perModel).toEqual([
      { model: 'm-a', n: 5, successRate: 1, meanScore: 4 },
      { model: 'm-b', n: 5, successRate: 0, meanScore: 2.4 },
    ]);
    expect(s.meetsTarget).toBe(false); // AUC 0.75 meets the bar, 18% at 5 does not
  });

  it('meets the bar only with AUC >= 0.75 and under 15% at 5', () => {
    const rows = [...Array(10)].map((_, i) => row(i < 5, i < 5 ? 4 : 2));
    expect(summarizeReplay(rows)).toEqual(expect.objectContaining({ auc: 1, shareAt5: 0, meetsTarget: true }));
  });

  it('gives no AUC when only one label is present', () => {
    const s = summarizeReplay([row(true, 5), row(true, 3)]);
    expect(s.auc).toBeNull();
    expect(s.aucCI).toBeNull();
    expect(s.meetsTarget).toBe(false);
  });
});
