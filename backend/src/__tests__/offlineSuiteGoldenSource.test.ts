import { goldenSetSource } from '../loops/eval/offlineSuiteSources';
import { newGoldenCase, type GoldenCase, type LabelValue } from '../loops/eval/goldenSet';
import type { GoldenSetStore } from '../loops/eval/goldenSetStore';
import type { GoldenCaseGrader } from '../loops/eval/runValidation';

const NOW = new Date('2026-10-14T00:00:00.000Z');
const AI_NOTE = '[AI-LABEL] Written by Claude on behalf of the owner. Not an independent human review.';

function labelled(id: string, taskSuccess: LabelValue, notes?: string): GoldenCase {
  const c = newGoldenCase({ surface: 'agent', taskType: 'fp_catalogue', sourceId: id, seedSource: 's', now: NOW });
  return { ...c, split: 'test', labels: { task_success: taskSuccess }, ...(notes ? { notes } : {}) };
}

function storeOf(cases: GoldenCase[]): GoldenSetStore {
  return { isProvisioned: () => true, listCases: jest.fn(async () => cases) } as unknown as GoldenSetStore;
}

// The grader always says "pass": it agrees with every human pass and disagrees with every human fail.
const grader: GoldenCaseGrader = {
  graderId: 'session-judge-general',
  surface: 'agent',
  criteria: ['task_success'],
  primaryCriterion: 'task_success',
  grade: async () => ({ task_success: 'pass' }),
};

describe('goldenSetSource: the offline suite\'s human-label agreement baseline (ENG-2135)', () => {
  it('leaves AI-written labels out, so the baseline is agreement with human labels only', async () => {
    const human = [labelled('h1', 'pass'), labelled('h2', 'pass'), labelled('h3', 'fail')];
    const ai = Array.from({ length: 5 }, (_, i) => labelled(`a${i}`, 'fail', AI_NOTE));
    const result = await goldenSetSource({ store: storeOf([...human, ...ai]), graders: () => [grader] }).run();
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.observations).toHaveLength(1);
    // 3 human cases: the grader agrees on the 2 passes only. Counting the 5 AI fails would make n 8 and passes 2.
    expect(result.observations[0]).toMatchObject({ metricId: 'golden-agreement:session-judge-general:task_success', n: 3, passes: 2 });
  });

  it('reports no labelled pairs when only AI-written labels exist', async () => {
    const result = await goldenSetSource({ store: storeOf([labelled('a1', 'pass', AI_NOTE)]), graders: () => [grader] }).run();
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.observations).toHaveLength(0);
    expect(result.notes?.[0]).toMatch(/no labelled pairs on task_success/);
  });
});
