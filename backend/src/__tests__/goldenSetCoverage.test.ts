import { formatLabelCoverage, summarizeLabelCoverage } from '../loops/eval/goldenSetCoverage';
import { newGoldenCase, newCreativePairCase, type GoldenCase, type LabelValue, type GoldenCriterion, type GoldenSplit } from '../loops/eval/goldenSet';
import { runLabelCoverage } from '../scripts/goldenSetLabelCoverage';
import type { GoldenSetStore } from '../loops/eval/goldenSetStore';

const NOW = new Date('2026-10-13T00:00:00.000Z');

function make(surface: 'agent' | 'creative' | 'account_health', id: string, split: GoldenSplit, labels: Partial<Record<GoldenCriterion, LabelValue>> = {}): GoldenCase {
  return { ...newGoldenCase({ surface, taskType: 't', sourceId: id, seedSource: 's', now: NOW }), split, labels };
}

describe('summarizeLabelCoverage (ENG-2135)', () => {
  it('counts pass / fail / na / unlabelled and available n per criterion on the test split', () => {
    const cases = [
      make('account_health', 'u1', 'test', { healthy: 'pass', at_risk: 'fail', activation_incomplete: 'na' }),
      make('account_health', 'u2', 'test', { healthy: 'fail' }),
      make('account_health', 'u3', 'test'),
      make('account_health', 'u4', 'dev', { healthy: 'pass' }),
    ];
    const test = summarizeLabelCoverage(cases).surfaces.find((s) => s.surface === 'account_health')!.splits.test;
    expect(test.totalCases).toBe(3);
    expect(test.casesWithBinaryLabel).toBe(2);
    const healthy = test.criteria.find((c) => c.criterion === 'healthy')!;
    expect(healthy).toMatchObject({ pass: 1, fail: 1, na: 0, unlabelled: 1, nAvailable: 2 });
    const incomplete = test.criteria.find((c) => c.criterion === 'activation_incomplete')!;
    expect(incomplete).toMatchObject({ pass: 0, fail: 0, na: 1, unlabelled: 2, nAvailable: 0 });
  });

  it('excludes pairwise creative cases from binary counts and reports them separately', () => {
    const pair = newCreativePairCase({
      candidateIdA: 'a',
      now: NOW,
      pair: { candidateIdB: 'b', batch: '2026-W41', position: 0, batchSize: 1, category: 'c', placement: 'p', signal: 'clear' },
    });
    const labelledPair: GoldenCase = { ...pair, split: 'test', labels: { pairwise_preference: 'A' } };
    const single = make('creative', 'c1', 'test', { hook: 'pass' });
    const creative = summarizeLabelCoverage([labelledPair, single]).surfaces.find((s) => s.surface === 'creative')!.splits.test;
    expect(creative.totalCases).toBe(1);
    expect(creative.casesWithBinaryLabel).toBe(1);
    expect(creative.pairwiseCases).toBe(1);
    expect(creative.pairwiseLabelled).toBe(1);
    expect(creative.criteria.every((c) => c.pass + c.fail + c.na + c.unlabelled === 1)).toBe(true);
  });

  it('says it cannot reach n>=30 for a 29-case test split even if all were labelled', () => {
    const cases = Array.from({ length: 29 }, (_, i) => make('agent', `s${i}`, 'test', { task_success: 'pass' }));
    const lines = formatLabelCoverage(summarizeLabelCoverage(cases));
    expect(lines).toContain('  cannot reach n>=30 on the test split: has 29 (even if every case were labelled)');
  });

  it('does not say that for a 30-case split, and notes criteria still short', () => {
    const cases = Array.from({ length: 30 }, (_, i) => make('agent', `s${i}`, 'test', { task_success: 'pass' }));
    const text = formatLabelCoverage(summarizeLabelCoverage(cases)).join('\n');
    expect(text).not.toMatch(/agent \/ test[\s\S]*cannot reach n>=30 on the test split: has 30/);
    expect(text).toMatch(/task_success: pass=30 fail=0 na=0 unlabelled=0 \| n available for validation=30\/30/);
    expect(text).toMatch(/6 of 7 criteria still below n>=30/);
  });

  it('counts a case whose label an AI wrote as unlabelled and reports it apart, so the human work is never overstated (ENG-2135)', () => {
    const AI = { notes: '[AI-LABEL] Written by Claude on behalf of the owner. Not an independent human review.' };
    const human = [make('agent', 'h1', 'test', { task_success: 'pass' }), make('agent', 'h2', 'test', { task_success: 'fail' })];
    const ai = [{ ...make('agent', 'a1', 'test', { task_success: 'pass' }), ...AI }, { ...make('agent', 'a2', 'test', { task_success: 'fail' }), ...AI }];
    const test = summarizeLabelCoverage([...human, ...ai]).surfaces.find((s) => s.surface === 'agent')!.splits.test;
    expect(test.totalCases).toBe(4);
    expect(test.casesWithBinaryLabel).toBe(2);
    expect(test.aiLabelledCases).toBe(2);
    expect(test.criteria.find((c) => c.criterion === 'task_success')).toMatchObject({ pass: 1, fail: 1, unlabelled: 2, nAvailable: 2 });
    const lines = formatLabelCoverage(summarizeLabelCoverage([...human, ...ai]));
    expect(lines).toContain('  2 case(s) hold AI-written labels: not counted as human');
  });

  it('does not count an AI-written pairwise choice as labelled', () => {
    const pair = (id: string, notes?: string): GoldenCase => ({
      ...newCreativePairCase({
        candidateIdA: id,
        now: NOW,
        pair: { candidateIdB: `${id}-b`, batch: '2026-W41', position: 0, batchSize: 2, category: 'c', placement: 'p', signal: 'clear' },
      }),
      split: 'test',
      labels: { pairwise_preference: 'A' },
      ...(notes ? { notes } : {}),
    });
    const creative = summarizeLabelCoverage([pair('p1'), pair('p2', '[AI-LABEL] Written by Claude.')]).surfaces.find((s) => s.surface === 'creative')!.splits.test;
    expect(creative.pairwiseCases).toBe(2);
    expect(creative.pairwiseLabelled).toBe(1);
    expect(creative.aiLabelledCases).toBe(1);
  });

  it('prints no AI line when no case holds an AI-written label', () => {
    const lines = formatLabelCoverage(summarizeLabelCoverage([make('agent', 'h1', 'test', { task_success: 'pass' })]));
    expect(lines.join('\n')).not.toContain('AI-written');
  });

  it('prints aggregates only: no case ids or source ids', () => {
    const cases = [make('agent', 'secret-session-id-123', 'test', { task_success: 'pass' })];
    const text = formatLabelCoverage(summarizeLabelCoverage(cases)).join('\n');
    expect(text).not.toContain('secret-session-id-123');
    expect(JSON.stringify(summarizeLabelCoverage(cases))).not.toContain('secret-session-id-123');
  });
});

describe('runLabelCoverage', () => {
  it('refuses to run, and never lists, when the store is not provisioned', async () => {
    const listCases = jest.fn();
    const err = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const code = await runLabelCoverage({ isProvisioned: () => false, listCases } as unknown as Pick<GoldenSetStore, 'isProvisioned' | 'listCases'>, () => undefined);
    expect(code).toBe(1);
    expect(listCases).not.toHaveBeenCalled();
    expect(err.mock.calls.join(' ')).toMatch(/not provisioned/);
    err.mockRestore();
  });

  it('lists every surface read-only and logs the report when provisioned', async () => {
    const listCases = jest.fn(async (_surface: string) => [] as GoldenCase[]);
    const lines: string[] = [];
    const code = await runLabelCoverage({ isProvisioned: () => true, listCases }, (l) => lines.push(l));
    expect(code).toBe(0);
    expect(listCases.mock.calls.map((c) => c[0])).toEqual(['agent', 'creative', 'account_health']);
    expect(lines.join('\n')).toMatch(/cannot reach n>=30 on the test split: has 0/);
  });
});
