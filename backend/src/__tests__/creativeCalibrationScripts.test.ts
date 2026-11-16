/**
 * ENG-2142: the calibration batch and report scripts parse strictly (a typo never turns a dry run
 * into a write), and the report counts only labelled pairs of the asked batches and prints counts
 * and rates, never ids.
 */

jest.mock('../cron/creativeCalibrationCron', () => ({ runCreativeCalibration: jest.fn() }));

import { parseBatchArgs } from '../scripts/creativeCalibrationBatch';
import { formatCalibrationReport, judgeLabelledPairs, labelledPairs, parseReportArgs } from '../scripts/creativeCalibrationReport';
import type { HumanEvalCandidate } from '../services/humanEvalService';
import { pairwiseAgreement } from '../loops/eval/creativeCalibration';
import { newCreativePairCase, newGoldenCase, type GoldenCase } from '../loops/eval/goldenSet';

const NOW = new Date('2026-09-22T00:00:00Z');

function pairCase(a: string, batch: string, label?: 'A' | 'B' | 'tie'): GoldenCase {
  const c = newCreativePairCase({
    candidateIdA: a,
    pair: { candidateIdB: `${a}-prior`, batch, position: 0, batchSize: 3, category: 'ad', placement: 'unknown', signal: 'unscored' },
    now: NOW,
  });
  return label ? { ...c, labels: { pairwise_preference: label } } : c;
}

describe('creativeCalibrationBatch args', () => {
  it('defaults to a dry run of 20 pairs and takes a batch, a target and --write', () => {
    expect(parseBatchArgs([])).toEqual({ target: 20, write: false });
    expect(parseBatchArgs(['--batch', '2026-W39', '--target', '15', '--write'])).toEqual({ batch: '2026-W39', target: 15, write: true });
  });

  it('rejects unknown flags, bad weeks and bad targets', () => {
    expect(() => parseBatchArgs(['--wrte'])).toThrow(/unknown argument/);
    expect(() => parseBatchArgs(['--batch', '2026-39'])).toThrow(/ISO week/);
    expect(() => parseBatchArgs(['--batch'])).toThrow(/needs a value/);
    expect(() => parseBatchArgs(['--target', '0'])).toThrow(/--target/);
    expect(() => parseBatchArgs(['--target', '2.5'])).toThrow(/--target/);
  });
});

describe('creativeCalibrationReport', () => {
  it('parses batches strictly', () => {
    expect(parseReportArgs(['--batch', '2026-W39,2026-W40', '--no-judge'])).toMatchObject({ batches: ['2026-W39', '2026-W40'], judge: false });
    expect(() => parseReportArgs([])).toThrow(/--batch is required/);
    expect(() => parseReportArgs(['--batch', 'last-week'])).toThrow(/ISO week/);
    expect(() => parseReportArgs(['--batch', '2026-W39', '--dry'])).toThrow(/unknown argument/);
  });

  it('keeps only the asked batches, and of those only the labelled pairs', () => {
    const cases = [
      pairCase('a1', '2026-W39', 'A'),
      pairCase('a2', '2026-W39'),
      pairCase('a3', '2026-W39', 'tie'),
      pairCase('a4', '2026-W38', 'B'),
      { ...newGoldenCase({ surface: 'creative', taskType: 'creative_image', sourceId: 'single', seedSource: 's', now: NOW }), labels: { hook: 'pass' as const } },
    ];
    const { inBatch, labelled } = labelledPairs(cases, ['2026-W39']);
    expect(inBatch).toHaveLength(3);
    expect(labelled.map((l) => l.human)).toEqual(['A', 'tie']);
  });

  it('leaves AI-written choices out by default and counts them only with --include-ai-labels (ENG-2135)', () => {
    const ai = { ...pairCase('ai1', '2026-W39', 'B'), notes: '[AI-LABEL] Written by Claude on behalf of the owner. Not an independent human review.' };
    const cases = [pairCase('h1', '2026-W39', 'A'), ai, pairCase('h2', '2026-W39', 'tie')];
    const byDefault = labelledPairs(cases, ['2026-W39']);
    expect(byDefault.labelled.map((l) => l.human)).toEqual(['A', 'tie']);
    expect(byDefault.aiLabelled).toBe(1);
    const included = labelledPairs(cases, ['2026-W39'], true);
    expect(included.labelled.map((l) => l.human)).toEqual(['A', 'B', 'tie']);
    expect(included.aiLabelled).toBe(1);
    expect(parseReportArgs(['--batch', '2026-W39'])).toMatchObject({ includeAiLabels: false });
    expect(parseReportArgs(['--batch', '2026-W39', '--include-ai-labels'])).toMatchObject({ includeAiLabels: true });
  });

  it('says how many AI-written choices were left out or included, and that included ones are not human agreement', () => {
    const base = { batches: ['2026-W39'], inBatch: 3, humanChoices: ['A' as const], judgeErrors: 0, agreement: null };
    expect(formatCalibrationReport({ ...base, aiLabelled: { count: 2, included: false } })).toContain('2 AI-written choice(s) left out');
    expect(formatCalibrationReport({ ...base, aiLabelled: { count: 2, included: true } })).toContain('ADVISORY, not human agreement');
    expect(formatCalibrationReport({ ...base, aiLabelled: { count: 0, included: false } })).not.toContain('AI-written');
  });

  it('prints n, agreement with its CI, kappa and win rates — and no ids', () => {
    const rows = [
      { human: 'A' as const, judge: 'A' as const },
      { human: 'A' as const, judge: 'A' as const },
      { human: 'B' as const, judge: 'A' as const },
      { human: 'tie' as const, judge: 'B' as const },
    ];
    const text = formatCalibrationReport({
      batches: ['2026-W39'],
      inBatch: 20,
      humanChoices: rows.map((r) => r.human),
      judgeErrors: 1,
      agreement: pairwiseAgreement(rows, { iterations: 100 }),
      model: 'anthropic.claude-sonnet-5',
    });
    expect(text).toContain('Creative calibration 2026-W39: 4/20 pairs labelled');
    expect(text).toContain('Human: A (newer) 2 · B (prior) 1 · tie 1');
    expect(text).toContain('errors 1');
    expect(text).toMatch(/Agreement \(A\/B\/tie\): 50\.0% of n=4, 95% CI \d+\.\d%–\d+\.\d%/);
    expect(text).toMatch(/Cohen's kappa: -?\d\.\d{3}/);
    expect(text).toContain('Decisive pairs only (no tie on either side): 66.7% of n=3');
    expect(text).toContain('A win rate (ties half): human 62.5%, judge 75.0%');
    expect(formatCalibrationReport({ batches: ['2026-W39'], inBatch: 2, humanChoices: [], judgeErrors: 0, agreement: null })).toContain('Agreement: n/a');
  });
});

describe('judgeLabelledPairs (#3094 review)', () => {
  const pairCase = (id: string, a: string, b: string) =>
    ({ caseId: id, sourceRef: { kind: 'candidateId', id: a }, pair: { candidateIdB: b } } as unknown as GoldenCase);
  const candidate = (id: string) => ({ candidateId: id, artifactUrl: `https://files.example.com/${id}.png` } as unknown as HumanEvalCandidate);

  it('counts a failed lookup as a judge error and keeps judging the remaining pairs', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const labelled = [
      { c: pairCase('p1', 'broken', 'b1'), human: 'A' as const },
      { c: pairCase('p2', 'a2', 'b2'), human: 'B' as const },
    ];
    const result = await judgeLabelledPairs(labelled, {
      getCandidate: async (id) => {
        if (id === 'broken') throw new Error('DynamoDB unavailable');
        return candidate(id);
      },
      briefFor: async () => ({}) as never,
      judge: async () => ({ status: 'ok', preference: 'B' }) as never,
    });
    expect(result.judgeErrors).toBe(1);
    expect(result.rows).toEqual([{ human: 'B', judge: 'B' }]);
  });

  it('leaves landing-page pairs to the human labels: no judge call, no error (ENG-2192)', async () => {
    const judge = jest.fn(async () => ({ status: 'ok', preference: 'A' }) as never);
    const lpCase = { ...pairCase('lp', 'a1', 'b1'), pair: { candidateIdB: 'b1', category: 'landing_page' } } as unknown as GoldenCase;

    const result = await judgeLabelledPairs([{ c: lpCase, human: 'A' }], { getCandidate: async (id) => candidate(id), briefFor: async () => ({}), judge });

    expect(result).toEqual({ rows: [], judgeErrors: 0 });
    expect(judge).not.toHaveBeenCalled();
  });

  it('counts a failed brief lookup the same way', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await judgeLabelledPairs([{ c: pairCase('p1', 'a1', 'b1'), human: 'tie' }], {
      getCandidate: async (id) => candidate(id),
      briefFor: async () => { throw new Error('brand lookup failed'); },
      judge: async () => ({ status: 'ok', preference: 'A' }) as never,
    });
    expect(result).toEqual({ rows: [], judgeErrors: 1 });
  });
});
