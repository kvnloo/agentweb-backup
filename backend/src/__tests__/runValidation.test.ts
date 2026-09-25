import type AWS from 'aws-sdk';
import { isQualifyingValidation } from '../loops/eval/evalRegistry';
import { newGoldenCase, type GoldenCase, type LabelValue } from '../loops/eval/goldenSet';
import type { GoldenSetStore } from '../loops/eval/goldenSetStore';
import type { ReadOnlyDocReader, ReadRequest } from '../loops/eval/agentGraderLoader';
import type { SessionForGrading } from '../loops/eval/agentGraders';
import {
  agentGraderPrediction,
  computeCriterionAgreement,
  liveAgentGraders,
  loadSessionForGrading,
  runValidation,
  sessionJudgeGrader,
  sessionJudgePrediction,
  storedSessionJudgeGraders,
  type GoldenCaseGrader,
  type GraderPrediction,
} from '../loops/eval/runValidation';

const NOW = new Date('2026-09-25T00:00:00.000Z');

function labelled(id: string, taskSuccess: LabelValue | undefined): GoldenCase {
  const c = newGoldenCase({ surface: 'agent', taskType: 'fp_catalogue', sourceId: id, seedSource: 's', now: NOW });
  return { ...c, split: 'test', labels: taskSuccess ? { task_success: taskSuccess } : {} };
}

function storeOf(cases: GoldenCase[]): jest.Mocked<GoldenSetStore> {
  return {
    tableName: 'T',
    isProvisioned: jest.fn(() => true),
    listCases: jest.fn(async () => cases),
    getCase: jest.fn(),
    createCase: jest.fn(),
    saveLabels: jest.fn(),
  } as unknown as jest.Mocked<GoldenSetStore>;
}

// 40 labelled cases: human pass/fail vs grader, 34 agreements, known confusion matrix.
// truth pass & pred pass: 18, truth pass & pred fail: 2, truth fail & pred pass: 4, truth fail & pred fail: 16.
function fixture(): { cases: GoldenCase[]; predictions: Map<string, GraderPrediction> } {
  const rows: Array<[LabelValue, LabelValue]> = [
    ...Array.from({ length: 18 }, (): [LabelValue, LabelValue] => ['pass', 'pass']),
    ...Array.from({ length: 2 }, (): [LabelValue, LabelValue] => ['pass', 'fail']),
    ...Array.from({ length: 4 }, (): [LabelValue, LabelValue] => ['fail', 'pass']),
    ...Array.from({ length: 16 }, (): [LabelValue, LabelValue] => ['fail', 'fail']),
  ];
  const cases = rows.map(([truth], i) => labelled(`s${i}`, truth));
  const predictions = new Map(rows.map(([, predicted], i) => [cases[i].caseId, { task_success: predicted }]));
  return { cases, predictions };
}

describe('validation runner math (ENG-2135)', () => {
  it('computes kappa and precision/recall on the pass/fail pairs', () => {
    const { cases, predictions } = fixture();
    const out = computeCriterionAgreement(cases, predictions, 'task_success', { iterations: 200 });
    // po = 34/40 = 0.85; pe = (20/40)(22/40) + (20/40)(18/40) = 0.5; kappa = 0.35/0.5 = 0.7
    expect(out.report?.n).toBe(40);
    expect(out.report?.observedAgreement).toBeCloseTo(0.85, 10);
    expect(out.report?.kappa).toBeCloseTo(0.7, 10);
    expect(out.report?.perClass.fail).toMatchObject({ precision: 16 / 18, recall: 16 / 20, support: 20 });
    expect(out.report?.perClass.pass).toMatchObject({ precision: 18 / 22, recall: 18 / 20, support: 20 });
  });

  it('leaves out human na, unlabelled cases and grader abstentions instead of counting them as agreement', () => {
    const { cases, predictions } = fixture();
    const extra = [labelled('na', 'na'), labelled('none', undefined), labelled('abstain', 'pass'), labelled('abstain-na', 'fail')];
    predictions.set(extra[0].caseId, { task_success: 'na' });
    predictions.set(extra[3].caseId, { task_success: 'na' });
    const out = computeCriterionAgreement([...cases, ...extra], predictions, 'task_success', { iterations: 200 });
    expect(out).toMatchObject({ humanNa: 1, unlabelled: 1, graderAbstained: 2 });
    expect(out.report?.n).toBe(40);
    expect(out.report?.kappa).toBeCloseTo(0.7, 10);
  });

  it('reports no agreement (null) when no case has both labels', () => {
    expect(computeCriterionAgreement([labelled('a', 'na')], new Map(), 'task_success').report).toBeNull();
  });

  it('runs a registry grader over the test split and returns the validation record without qualifying it by itself', async () => {
    const { cases, predictions } = fixture();
    const store = storeOf(cases);
    const grader: GoldenCaseGrader = {
      graderId: 'session-judge-general',
      surface: 'agent',
      criteria: ['task_success'],
      primaryCriterion: 'task_success',
      grade: async (c) => predictions.get(c.caseId) ?? {},
    };
    const run = await runValidation({ graderId: 'session-judge-general', store, graders: [grader], now: NOW, bootstrap: { iterations: 200 } });
    expect(store.listCases).toHaveBeenCalledWith('agent', { split: 'test' });
    expect(run).toMatchObject({ cases: 40, gradeErrors: 0, split: 'test', primaryCriterion: 'task_success' });
    expect(run.validation).toEqual({ kappa: expect.closeTo(0.7, 10), n: 40, date: '2026-09-25', evidence: 'unpublished' });
    expect(isQualifyingValidation(run.validation ?? undefined)).toBe(false);

    const withEvidence = await runValidation({ graderId: 'session-judge-general', store, graders: [grader], evidence: 'https://linear.app/x', now: NOW, bootstrap: { iterations: 200 } });
    expect(isQualifyingValidation(withEvidence.validation ?? undefined)).toBe(true);
  });

  it('counts a grader that throws on a case as an error and an abstention', async () => {
    const { cases, predictions } = fixture();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const grader: GoldenCaseGrader = {
      graderId: 'session-judge-general',
      surface: 'agent',
      criteria: ['task_success'],
      primaryCriterion: 'task_success',
      grade: async (c) => {
        if (c.caseId === cases[0].caseId) throw new Error('boom');
        return predictions.get(c.caseId) ?? {};
      },
    };
    const run = await runValidation({ graderId: 'session-judge-general', store: storeOf(cases), graders: [grader], bootstrap: { iterations: 50 } });
    expect(run.gradeErrors).toBe(1);
    expect(run.criteria[0]).toMatchObject({ graderAbstained: 1 });
    expect(run.criteria[0].report?.n).toBe(39);
    warn.mockRestore();
  });

  it('rejects an unknown grader, a grader with no adapter, and a surface mismatch', async () => {
    const store = storeOf([]);
    await expect(runValidation({ graderId: 'nope', store, graders: [] })).rejects.toThrow(/Unknown eval-registry grader/);
    await expect(runValidation({ graderId: 'finalize-guard', store, graders: [] })).rejects.toThrow(/No golden-case adapter/);
    const wrong: GoldenCaseGrader = { graderId: 'client-health-assessment', surface: 'agent', criteria: ['task_success'], primaryCriterion: 'task_success', grade: async () => ({}) };
    await expect(runValidation({ graderId: 'client-health-assessment', store, graders: [wrong] })).rejects.toThrow(/surface/);
  });
});

describe('stored session-judge adapters', () => {
  it('maps 1-5 dimensions to pass at >= 4 and abstains on a missing dimension', () => {
    expect(sessionJudgePrediction({ goalCompletion: 4, dataAccuracy: 3 })).toEqual({ task_success: 'pass', groundedness: 'fail', instruction_compliance: 'na' });
    expect(sessionJudgePrediction(undefined)).toEqual({ task_success: 'na', groundedness: 'na', instruction_compliance: 'na' });
  });

  it('grades a case by its session id', async () => {
    const read = jest.fn(async () => ({ goalCompletion: 2 }));
    const grader = sessionJudgeGrader('session-judge-general', read);
    expect(await grader.grade(labelled('sess-9', 'fail'))).toMatchObject({ task_success: 'fail' });
    expect(read).toHaveBeenCalledWith('sess-9');
  });

  it('exposes the general, Fangfang and Matt judges, reading only the stored scores', async () => {
    const get = jest.fn(() => ({
      promise: async () => ({
        Item: {
          satisfactionScore: { dimensions: { goalCompletion: 5 } },
          judgeScores: { judge_1779822633705_027n0uoio: { dimensions: { goalCompletion: 1 } } },
        },
      }),
    }));
    const graders = storedSessionJudgeGraders({ get } as unknown as AWS.DynamoDB.DocumentClient);
    expect(graders.map((g) => g.graderId)).toEqual(['session-judge-general', 'session-judge-fangfang', 'session-judge-matt']);
    const c = labelled('sess-1', 'pass');
    expect((await graders[0].grade(c)).task_success).toBe('pass');
    expect((await graders[1].grade(c)).task_success).toBe('na');
    expect((await graders[2].grade(c)).task_success).toBe('fail');
    expect(get).toHaveBeenCalledWith(expect.objectContaining({ Key: { sessionId: 'sess-1' }, ProjectionExpression: 'satisfactionScore, judgeScores' }));
  });
});

describe('agent grader adapters (ENG-2137 graders on golden cases)', () => {
  const completed: SessionForGrading = {
    sessionId: 'sess-1',
    workPlan: { steps: [{ stepCount: 1, status: 'completed', requiredFunctionCalls: ['search_web'] }] },
    ledger: [{ toolName: 'search_web', args: {}, status: 'success' }],
    events: [],
    endsWithRunFailurePlaceholder: false,
    finalReply: 'Here is what I found.',
    userTurns: 1,
  };

  it('maps verdicts to criteria, abstaining on excluded sessions and replies with no claims', () => {
    expect(agentGraderPrediction('agent-task-success', completed)).toEqual({ task_success: 'pass' });
    expect(agentGraderPrediction('agent-task-success', { ...completed, workPlan: { steps: [{ status: 'pending' }, { status: 'pending' }] } })).toEqual({ task_success: 'fail' });
    expect(agentGraderPrediction('agent-task-success', { ...completed, workPlan: undefined })).toEqual({ task_success: 'na' });
    expect(agentGraderPrediction('agent-tool-correctness', completed)).toEqual({ tool_correctness: 'pass' });
    expect(agentGraderPrediction('agent-groundedness-offline', completed)).toEqual({ groundedness: 'na' });
    expect(agentGraderPrediction('agent-task-success', undefined)).toEqual({});
    expect(() => agentGraderPrediction('session-judge-general', completed)).toThrow(/not an agent grader/);
  });

  it('registers one adapter per agent grader, each scoring only its own criterion', async () => {
    const load = jest.fn(async () => completed);
    const graders = liveAgentGraders(load);
    expect(graders.map((g) => [g.graderId, g.criteria, g.primaryCriterion])).toEqual([
      ['agent-task-success', ['task_success'], 'task_success'],
      ['agent-tool-correctness', ['tool_correctness'], 'tool_correctness'],
      ['agent-groundedness-offline', ['groundedness'], 'groundedness'],
    ]);
    expect(await graders[0].grade(labelled('sess-1', 'pass'))).toEqual({ task_success: 'pass' });
    expect(load).toHaveBeenCalledWith('sess-1');
  });

  it('loads one session read-only: key query on sessions and messages, loop events filtered to the session', async () => {
    const requests: ReadRequest[] = [];
    const reader: ReadOnlyDocReader = {
      scan: jest.fn(),
      query: jest.fn(async (r: ReadRequest) => {
        requests.push(r);
        if (r.TableName === 'S') {
          return { Items: [{ sessionId: 'sess-1', createdAt: '2026-09-20T00:00:00.000Z', updatedAt: '2026-09-21T00:00:00.000Z', workPlan: { steps: [{ status: 'completed' }] } }] };
        }
        if (r.TableName === 'M') {
          return { Items: [{ sessionId: 'sess-1', messageIndex: 1, message: { role: 'assistant', content: 'done' } }, { sessionId: 'sess-1', messageIndex: 0, message: { role: 'user', content: 'go' } }] };
        }
        return { Items: [{ loopId: 'agent-mode', subjectId: 'run-1', eventType: 'agent_tool_invoked', ts: '2026-09-20T01:00:00.000Z', dimensions: { sessionId: 'sess-1', toolName: 'search_web' } }] };
      }),
    };
    const s = await loadSessionForGrading(reader, { sessions: 'S', messages: 'M', loopEvents: 'E' }, 'sess-1');
    expect(s).toMatchObject({ sessionId: 'sess-1', userTurns: 1, finalReply: 'done', workPlan: { steps: [{ status: 'completed' }] } });
    expect(s?.events).toHaveLength(1);
    expect(reader.scan).not.toHaveBeenCalled();
    expect(requests.find((r) => r.TableName === 'E')).toMatchObject({
      FilterExpression: '#dims.sessionId = :s',
      ExpressionAttributeNames: { '#dims': 'dimensions' },
      ExpressionAttributeValues: { ':l': 'agent-mode', ':from': '2026-09-20T00:00:00.000Z', ':s': 'sess-1' },
    });
  });

  it('returns undefined for a session that does not exist', async () => {
    const reader: ReadOnlyDocReader = { scan: jest.fn(), query: jest.fn(async () => ({ Items: [] })) };
    await expect(loadSessionForGrading(reader, { sessions: 'S', messages: 'M', loopEvents: 'E' }, 'gone')).resolves.toBeUndefined();
  });
});
