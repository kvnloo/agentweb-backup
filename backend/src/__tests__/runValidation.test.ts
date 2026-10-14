import type AWS from 'aws-sdk';
import { isQualifyingValidation } from '../loops/eval/evalRegistry';
import { newCreativePairCase, newGoldenCase, type GoldenCase, type LabelValue } from '../loops/eval/goldenSet';
import type { GoldenSetStore } from '../loops/eval/goldenSetStore';
import type { ReadOnlyDocReader, ReadRequest } from '../loops/eval/agentGraderLoader';
import type { SessionForGrading } from '../loops/eval/agentGraders';
import type { CreativeGateResult } from '../services/creativeGates';
import type { AccountHealthState } from '../services/accountHealthClassifier';
import {
  accountHealthGrader,
  accountHealthPrediction,
  agentGraderPrediction,
  computeCriterionAgreement,
  creativeGatesGrader,
  creativeGatesPrediction,
  MIN_CLASS_EXAMPLES,
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
    expect(run.validation).toEqual({ kappa: expect.closeTo(0.7, 10), n: 40, date: '2026-09-25', evidence: 'unpublished', labelSource: 'human' });
    expect(isQualifyingValidation(run.validation ?? undefined)).toBe(false);

    const withEvidence = await runValidation({ graderId: 'session-judge-general', store, graders: [grader], evidence: 'https://linear.app/x', now: NOW, bootstrap: { iterations: 200 } });
    expect(isQualifyingValidation(withEvidence.validation ?? undefined)).toBe(true);
  });

  describe('AI-written labels (ENG-2135)', () => {
    const AI_NOTE = '[AI-LABEL] Written by Claude on behalf of the owner. Not an independent human review.';
    const aiGrader = (predictions: Map<string, GraderPrediction>): GoldenCaseGrader => ({
      graderId: 'session-judge-general',
      surface: 'agent',
      criteria: ['task_success'],
      primaryCriterion: 'task_success',
      grade: async (c) => predictions.get(c.caseId) ?? {},
    });

    it('leaves AI-written labels out by default, so agreement and the registry record rest on human labels only', async () => {
      const { cases, predictions } = fixture(); // 40 human-labelled cases, kappa 0.7
      const aiCases = Array.from({ length: 10 }, (_, i) => ({ ...labelled(`ai${i}`, 'pass'), notes: AI_NOTE }));
      // The grader disagrees with every AI label, so counting them would lower kappa.
      const aiPredictions = new Map(aiCases.map((c) => [c.caseId, { task_success: 'fail' as LabelValue }]));
      const run = await runValidation({
        graderId: 'session-judge-general',
        store: storeOf([...cases, ...aiCases]),
        graders: [aiGrader(new Map([...predictions, ...aiPredictions]))],
        now: NOW,
        bootstrap: { iterations: 100 },
      });
      expect(run).toMatchObject({ cases: 40, aiLabelledCases: 10, labelSource: 'human' });
      expect(run.criteria[0].report?.n).toBe(40);
      expect(run.validation).toEqual({ kappa: expect.closeTo(0.7, 10), n: 40, date: '2026-09-25', evidence: 'unpublished', labelSource: 'human' });
    });

    it('counts them only on request, and then withholds the registry record: an advisory run is never evidence', async () => {
      const { cases, predictions } = fixture();
      const aiCases = Array.from({ length: 10 }, (_, i) => ({ ...labelled(`ai${i}`, 'pass'), notes: AI_NOTE }));
      const aiPredictions = new Map(aiCases.map((c) => [c.caseId, { task_success: 'fail' as LabelValue }]));
      const run = await runValidation({
        graderId: 'session-judge-general',
        store: storeOf([...cases, ...aiCases]),
        graders: [aiGrader(new Map([...predictions, ...aiPredictions]))],
        includeAiLabels: true,
        evidence: 'https://linear.app/x',
        now: NOW,
        bootstrap: { iterations: 100 },
      });
      expect(run).toMatchObject({ cases: 50, aiLabelledCases: 10, labelSource: 'human+ai' });
      expect(run.criteria[0].report?.n).toBe(50);
      expect(run.validation).toBeNull();
      expect(isQualifyingValidation(run.validation ?? undefined)).toBe(false);
    });

    it('stays a human run when the flag is set but the split holds no AI-written label', async () => {
      const { cases, predictions } = fixture();
      const run = await runValidation({
        graderId: 'session-judge-general',
        store: storeOf(cases),
        graders: [aiGrader(predictions)],
        includeAiLabels: true,
        now: NOW,
        bootstrap: { iterations: 100 },
      });
      expect(run).toMatchObject({ aiLabelledCases: 0, labelSource: 'human' });
      expect(run.validation).not.toBeNull();
    });
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

  it('never runs the grader on a case without a human pass/fail label (an adapter may read live customer state)', async () => {
    const unlabelledCase = labelled('u1', undefined);
    const naCase = labelled('n1', 'na');
    const passCase = labelled('p1', 'pass');
    const grade = jest.fn(async () => ({ task_success: 'pass' as const }));
    const grader: GoldenCaseGrader = { graderId: 'session-judge-general', surface: 'agent', criteria: ['task_success'], primaryCriterion: 'task_success', grade };
    const run = await runValidation({ graderId: 'session-judge-general', store: storeOf([unlabelledCase, naCase, passCase]), graders: [grader], bootstrap: { iterations: 10 } });
    expect(grade).toHaveBeenCalledTimes(1);
    expect(grade).toHaveBeenCalledWith(expect.objectContaining({ caseId: passCase.caseId }));
    expect(run).toMatchObject({ cases: 3, graded: 1, gradeErrors: 0 });
    expect(run.criteria[0]).toMatchObject({ unlabelled: 1, humanNa: 1 });
    expect(run.criteria[0].report?.n).toBe(1);
  });

  it('counts a case as graded when any of the grader\'s criteria has a binary label', async () => {
    const c = { ...labelled('m1', undefined), labels: { groundedness: 'fail' as const } };
    const grade = jest.fn(async () => ({}));
    const grader: GoldenCaseGrader = { graderId: 'session-judge-general', surface: 'agent', criteria: ['task_success', 'groundedness'], primaryCriterion: 'task_success', grade };
    const run = await runValidation({ graderId: 'session-judge-general', store: storeOf([c]), graders: [grader], bootstrap: { iterations: 10 } });
    expect(grade).toHaveBeenCalledTimes(1);
    expect(run.graded).toBe(1);
  });

  it('leaves pairwise calibration cases out of a creative grader run (ENG-2142)', async () => {
    const single = { ...newGoldenCase({ surface: 'creative', taskType: 'creative_image', sourceId: 'c1', seedSource: 's', now: NOW }), split: 'test' as const, labels: { hook: 'pass' as const } };
    const pair: GoldenCase = {
      ...newCreativePairCase({
        candidateIdA: 'c2',
        pair: { candidateIdB: 'c1', batch: '2026-W39', position: 0, batchSize: 1, category: 'ad', placement: 'unknown', signal: 'unscored' },
        now: NOW,
      }),
      split: 'test',
      labels: { pairwise_preference: 'A' },
    };
    const graded: string[] = [];
    const grader: GoldenCaseGrader = {
      graderId: 'creative-rubric-judge',
      surface: 'creative',
      criteria: ['hook'],
      primaryCriterion: 'hook',
      grade: async (c) => {
        graded.push(c.caseId);
        return { hook: 'pass' };
      },
    };
    const run = await runValidation({ graderId: 'creative-rubric-judge', store: storeOf([single, pair]), graders: [grader], bootstrap: { iterations: 10 } });
    expect(graded).toEqual([single.caseId]);
    expect(run.cases).toBe(1);
    expect(run.criteria[0]).toMatchObject({ unlabelled: 0 });
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
    expect(sessionJudgePrediction({ goalCompletion: 4, dataAccuracy: 3 })).toEqual({ task_success: 'pass', groundedness: 'fail', instruction_compliance: 'na', argued_with_instruction: 'na', escalated_when_not_required: 'na', failed_to_escalate: 'na' });
    expect(sessionJudgePrediction(undefined)).toEqual({ task_success: 'na', groundedness: 'na', instruction_compliance: 'na', argued_with_instruction: 'na', escalated_when_not_required: 'na', failed_to_escalate: 'na' });
  });

  it('grades a case by its session id', async () => {
    const read = jest.fn(async () => ({ goalCompletion: 2 }));
    const grader = sessionJudgeGrader('session-judge-general', read);
    expect(await grader.grade(labelled('sess-9', 'fail'))).toMatchObject({ task_success: 'fail' });
    expect(read).toHaveBeenCalledWith('sess-9');
  });

  it('exposes the general, Fangfang, Matt and shadow outcome judges, reading only the stored scores', async () => {
    const get = jest.fn(() => ({
      promise: async () => ({
        Item: {
          satisfactionScore: { dimensions: { goalCompletion: 5 } },
          judgeScores: {
            judge_1779822633705_027n0uoio: { dimensions: { goalCompletion: 1 } },
            'outcome-judge-b-shadow': { dimensions: { goalCompletion: 4 } },
          },
        },
      }),
    }));
    const graders = storedSessionJudgeGraders({ get } as unknown as AWS.DynamoDB.DocumentClient);
    expect(graders.map((g) => g.graderId)).toEqual(['session-judge-general', 'session-judge-fangfang', 'session-judge-matt', 'session-judge-outcome-b-shadow']);
    const c = labelled('sess-1', 'pass');
    expect((await graders[0].grade(c)).task_success).toBe('pass');
    expect((await graders[1].grade(c)).task_success).toBe('na');
    expect((await graders[2].grade(c)).task_success).toBe('fail');
    expect((await graders[3].grade(c)).task_success).toBe('pass');
    expect(get).toHaveBeenCalledWith(expect.objectContaining({ Key: { sessionId: 'sess-1' }, ProjectionExpression: 'satisfactionScore, judgeScores' }));
  });
});

describe('outcome rubric behaviour criteria (ENG-2189)', () => {
  it('maps the shadow judge\'s booleans onto the golden criteria, true = pass (it happened)', () => {
    expect(sessionJudgePrediction({ arguedWithInstruction: true, escalatedWhenNotRequired: false })).toMatchObject({
      argued_with_instruction: 'pass',
      escalated_when_not_required: 'fail',
      failed_to_escalate: 'na',
    });
  });

  it('scores the behaviour criteria for the shadow judge only; the Gemini judges never ask for them', () => {
    const read = async () => undefined;
    expect(sessionJudgeGrader('session-judge-outcome-b-shadow', read).criteria).toEqual([
      'task_success', 'groundedness', 'instruction_compliance', 'argued_with_instruction', 'escalated_when_not_required', 'failed_to_escalate',
    ]);
    expect(sessionJudgeGrader('session-judge-general', read).criteria).toEqual(['task_success', 'groundedness', 'instruction_compliance']);
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
    // ENG-2189: the adherence checks label instruction_compliance, abstaining when no instruction applies.
    expect(agentGraderPrediction('agent-format-adherence', completed)).toEqual({ instruction_compliance: 'na' });
    const asked = { ...completed, turns: [{ userText: 'go ahead', replyText: 'Shall I proceed with the research?', toolNames: [] }] };
    expect(agentGraderPrediction('agent-act-without-asking', asked)).toEqual({ instruction_compliance: 'fail' });
    const short = { ...completed, turns: [{ userText: 'in under 100 words', replyText: 'Short answer.', toolNames: [] }] };
    expect(agentGraderPrediction('agent-reply-length-adherence', short)).toEqual({ instruction_compliance: 'pass' });
    expect(() => agentGraderPrediction('session-judge-general', completed)).toThrow(/not an agent grader/);
  });

  it('registers one adapter per agent grader, each scoring only its own criterion', async () => {
    const load = jest.fn(async () => completed);
    const graders = liveAgentGraders(load);
    expect(graders.map((g) => [g.graderId, g.criteria, g.primaryCriterion])).toEqual([
      ['agent-task-success', ['task_success'], 'task_success'],
      ['agent-tool-correctness', ['tool_correctness'], 'tool_correctness'],
      ['agent-groundedness-offline', ['groundedness'], 'groundedness'],
      ['agent-reply-length-adherence', ['instruction_compliance'], 'instruction_compliance'],
      ['agent-format-adherence', ['instruction_compliance'], 'instruction_compliance'],
      ['agent-act-without-asking', ['instruction_compliance'], 'instruction_compliance'],
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

describe('creative deterministic gates adapter (ENG-2139, ENG-2226)', () => {
  const gateResult = (passed: boolean, checks: CreativeGateResult['checks'] = [{ id: 'decode', status: passed ? 'pass' : 'fail' }]): CreativeGateResult => ({
    graderId: 'creative-deterministic-gates',
    version: '2026-09-29.1',
    advisory: true,
    passed,
    checks,
    bytes: 12345,
    fitsPlacements: [],
    evaluatedAt: '2026-09-29T00:00:00.000Z',
  });

  const creativeCase = (candidateId: string): GoldenCase => ({
    ...newGoldenCase({ surface: 'creative', taskType: 'creative_image', sourceId: candidateId, seedSource: 's', now: NOW }),
    split: 'test',
  });

  it('maps passed/failed onto format_readiness and abstains when the candidate has no stored gate result', () => {
    expect(creativeGatesPrediction(gateResult(true))).toEqual({ format_readiness: 'pass' });
    expect(creativeGatesPrediction(gateResult(false))).toEqual({ format_readiness: 'fail' });
    expect(creativeGatesPrediction(undefined)).toEqual({});
  });

  it('ignores the advisory content checks: a launch-ready image with failing content checks is still format_readiness pass (ENG-2193 merged them into `passed`)', () => {
    const g = gateResult(false, [
      { id: 'decode', status: 'pass' },
      { id: 'blank_render', status: 'pass' },
      { id: 'aspect_ratio', status: 'pass' },
      { id: 'dimensions', status: 'pass' },
      { id: 'file_size', status: 'pass' },
      { id: 'ocr_legibility', status: 'fail' },
      { id: 'brand_colour', status: 'fail' },
    ]);
    expect(g.passed).toBe(false);
    expect(creativeGatesPrediction(g)).toEqual({ format_readiness: 'pass' });
  });

  it('a failing structural check is a fail even when content checks pass', () => {
    const g = gateResult(false, [
      { id: 'decode', status: 'pass' },
      { id: 'blank_render', status: 'fail' },
      { id: 'logo_presence', status: 'pass' },
    ]);
    expect(creativeGatesPrediction(g)).toEqual({ format_readiness: 'fail' });
  });

  it('a skipped structural check does not count as pass: abstains when every structural check was skipped or the gates were not checked', () => {
    const skipped = gateResult(true, [
      { id: 'decode', status: 'skipped' },
      { id: 'blank_render', status: 'skipped' },
      { id: 'ocr_text_ratio', status: 'pass' },
    ]);
    expect(creativeGatesPrediction(skipped)).toEqual({});
    expect(creativeGatesPrediction({ ...gateResult(true), notChecked: 'no image bytes' })).toEqual({});
    expect(creativeGatesPrediction(gateResult(true, []))).toEqual({});
  });

  it('structural pass with some other structural check skipped is still a pass', () => {
    const g = gateResult(true, [
      { id: 'decode', status: 'pass' },
      { id: 'aspect_ratio', status: 'skipped' },
    ]);
    expect(creativeGatesPrediction(g)).toEqual({ format_readiness: 'pass' });
  });

  it('grades a case by its candidate id, read-only', async () => {
    const read = jest.fn(async (id: string) => (id === 'cand-1' ? gateResult(true) : undefined));
    const grader = creativeGatesGrader(read);
    expect(grader).toMatchObject({
      graderId: 'creative-deterministic-gates',
      surface: 'creative',
      criteria: ['format_readiness'],
      primaryCriterion: 'format_readiness',
    });

    expect(await grader.grade(creativeCase('cand-1'))).toEqual({ format_readiness: 'pass' });
    expect(read).toHaveBeenCalledWith('cand-1');

    // Abstention: no stored gate result for this candidate (e.g. gated before ENG-2139).
    expect(await grader.grade(creativeCase('cand-2'))).toEqual({});
  });
});

describe('account-health classifier adapter (ENG-2143, ENG-2226)', () => {
  const accountCase = (userId: string): GoldenCase => ({
    ...newGoldenCase({ surface: 'account_health', taskType: 'paying_account', sourceId: userId, seedSource: 's', now: NOW }),
    split: 'test',
  });

  it('maps the classified state onto the three golden criteria, and abstains on insufficient evidence or no classification', () => {
    expect(accountHealthPrediction('at_risk')).toEqual({ activation_incomplete: 'fail', at_risk: 'pass', healthy: 'fail' });
    expect(accountHealthPrediction('activation_incomplete')).toEqual({ activation_incomplete: 'pass', at_risk: 'fail', healthy: 'fail' });
    expect(accountHealthPrediction('healthy')).toEqual({ activation_incomplete: 'fail', at_risk: 'fail', healthy: 'pass' });
    // Abstention cases: the classifier itself could not decide, or never ran at all.
    expect(accountHealthPrediction('insufficient_evidence')).toEqual({});
    expect(accountHealthPrediction(undefined)).toEqual({});
  });

  it('grades a case by its user id, read-only, with at_risk as the primary (gating) criterion', async () => {
    const classify = jest.fn(async (id: string): Promise<AccountHealthState | undefined> => (id === 'user-1' ? 'at_risk' : undefined));
    const grader = accountHealthGrader(classify);
    expect(grader).toMatchObject({
      graderId: 'account-health-classifier',
      surface: 'account_health',
      criteria: ['activation_incomplete', 'at_risk', 'healthy'],
      primaryCriterion: 'at_risk',
    });

    expect(await grader.grade(accountCase('user-1'))).toEqual({ activation_incomplete: 'fail', at_risk: 'pass', healthy: 'fail' });
    expect(classify).toHaveBeenCalledWith('user-1');

    // Abstention: the classify function found nothing for this user (e.g. deleted since the case was seeded).
    expect(await grader.grade(accountCase('user-2'))).toEqual({});
  });
});

describe('class reliability and the human-only record (ENG-2135)', () => {
  const grader = (predict: (c: GoldenCase) => 'pass' | 'fail'): GoldenCaseGrader => ({
    graderId: 'session-judge-general',
    surface: 'agent',
    criteria: ['task_success'],
    primaryCriterion: 'task_success',
    grade: async (c) => ({ task_success: predict(c) }),
  });
  const perfect = grader((c) => (c.labels.task_success === 'pass' ? 'pass' : 'fail'));
  const withPass = (nPass: number) => Array.from({ length: 40 }, (_, i) => labelled(`c${i}`, i < nPass ? 'pass' : 'fail'));

  it('a balanced human-labelled run produces a record that says the labels are human, and it can qualify', async () => {
    const run = await runValidation({ graderId: 'session-judge-general', store: storeOf(withPass(20)), graders: [perfect], evidence: 'https://linear.app/x', now: NOW, bootstrap: { iterations: 20 } });
    expect(run.criteria[0]).toMatchObject({ minorityN: 20, reliable: true });
    expect(run.validation).toMatchObject({ labelSource: 'human', n: 40 });
    expect(isQualifyingValidation(run.validation!)).toBe(true);
  });

  it('a class with fewer than MIN_CLASS_EXAMPLES examples is not reliable and produces no validation record', async () => {
    const run = await runValidation({ graderId: 'session-judge-general', store: storeOf(withPass(MIN_CLASS_EXAMPLES - 1)), graders: [perfect], evidence: 'https://linear.app/x', now: NOW, bootstrap: { iterations: 20 } });
    expect(run.criteria[0]).toMatchObject({ minorityN: MIN_CLASS_EXAMPLES - 1, reliable: false });
    expect(run.criteria[0].report).not.toBeNull();
    expect(run.validation).toBeNull();
  });

  it('the rarer class can be either label: too few fails is just as unreliable as too few passes', async () => {
    const run = await runValidation({ graderId: 'session-judge-general', store: storeOf(withPass(40 - (MIN_CLASS_EXAMPLES - 1))), graders: [perfect], evidence: 'https://linear.app/x', now: NOW, bootstrap: { iterations: 20 } });
    expect(run.criteria[0]).toMatchObject({ minorityN: MIN_CLASS_EXAMPLES - 1, reliable: false });
    expect(run.validation).toBeNull();
  });

  it('exactly MIN_CLASS_EXAMPLES examples of the rarer class is enough', async () => {
    const run = await runValidation({ graderId: 'session-judge-general', store: storeOf(withPass(MIN_CLASS_EXAMPLES)), graders: [perfect], evidence: 'https://linear.app/x', now: NOW, bootstrap: { iterations: 20 } });
    expect(run.criteria[0]).toMatchObject({ minorityN: MIN_CLASS_EXAMPLES, reliable: true });
    expect(run.validation).not.toBeNull();
  });

  it('no pairs: not reliable, no record', async () => {
    const run = await runValidation({ graderId: 'session-judge-general', store: storeOf([labelled('x', undefined)]), graders: [perfect], now: NOW });
    expect(run.criteria[0]).toMatchObject({ reliable: false, minorityN: 0 });
    expect(run.validation).toBeNull();
  });
});
