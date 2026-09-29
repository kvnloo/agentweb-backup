/**
 * ENG-2144: online eval sampler, pure half — uniform seeded sampling, the stored row shape and
 * the aggregate math (n, 95% Wilson CI, mayGate). Synthetic ids only.
 */
import { gradeSession, type SessionForGrading } from '../loops/eval/agentGraders';
import { wilsonInterval } from '../loops/eval/agreement';
import {
  aggregateEvalV2,
  buildScoredEventItem,
  buildSnapshotItem,
  parseScoredEvent,
  parseSnapshotItem,
  sampleUniform,
  shiftDate,
  surfaceOf,
  type EvalV2Score,
} from '../loops/eval/evalV2Sampler';
import { EVAL_REGISTRY, mayGate } from '../loops/eval/evalRegistry';

const ids = (n: number) => Array.from({ length: n }, (_, i) => `s-${String(i).padStart(3, '0')}`);
const self = (x: string) => x;

describe('sampleUniform', () => {
  it('draws k distinct items, deterministically for a seed, whatever order the query returned', () => {
    const frame = ids(40);
    const a = sampleUniform(frame, 10, 'eval-v2:2026-09-24', self);
    expect(a).toHaveLength(10);
    expect(new Set(a).size).toBe(10);
    expect(a.every((x) => frame.includes(x))).toBe(true);
    expect(sampleUniform([...frame].reverse(), 10, 'eval-v2:2026-09-24', self)).toEqual(a);
    expect(sampleUniform(frame, 10, 'eval-v2:2026-09-25', self)).not.toEqual(a);
  });

  it('takes the whole frame when it has no more than k sessions', () => {
    expect(sampleUniform(ids(3), 50, 'seed', self).sort()).toEqual(ids(3));
    expect(sampleUniform([], 50, 'seed', self)).toEqual([]);
  });

  it('gives every session the same inclusion probability k/N (uniform over seeds)', () => {
    const frame = ids(20);
    const k = 5;
    const runs = 4000;
    const hits = new Map(frame.map((id) => [id, 0]));
    for (let r = 0; r < runs; r++) {
      for (const id of sampleUniform(frame, k, `eval-v2:run-${r}`, self)) hits.set(id, (hits.get(id) ?? 0) + 1);
    }
    const expected = (runs * k) / frame.length; // 1000
    // Binomial sd = sqrt(4000 * 0.25 * 0.75) ≈ 27; 5 sd either side.
    for (const count of hits.values()) expect(Math.abs(count - expected)).toBeLessThan(140);
    // Position in the sorted frame does not matter: first and last halves are hit equally often.
    const firstHalf = frame.slice(0, 10).reduce((sum, id) => sum + (hits.get(id) ?? 0), 0);
    expect(Math.abs(firstHalf - (runs * k) / 2)).toBeLessThan(250);
  });
});

describe('scored event rows', () => {
  const session: SessionForGrading = {
    sessionId: 'sess-1',
    workPlan: { title: 'Launch Google Ads campaign', steps: [{ stepCount: 1, status: 'completed' }] },
    ledger: [{ id: 'c1', toolName: 'web_search', args: {}, status: 'success', result: {} }],
    events: [],
    endsWithRunFailurePlaceholder: false,
    finalReply: 'SECRET CUSTOMER TEXT: I launched the campaign.',
    userTurns: 2,
  };
  const graded = gradeSession(session, 'gemini-3.8-flash', undefined);
  const ctx = { sampleDate: '2026-09-24', surface: 'agent/regular', frameSize: 56, sampleSize: 50, userTurns: 2 };

  it('keys a score on (day, session) and records the graders with their versions', () => {
    const item = buildScoredEventItem(graded, ctx, new Date('2026-09-25T17:15:00Z'));
    expect(item).toMatchObject({
      loopId: 'eval-v2',
      tsSession: 'eval_v2_scored#2026-09-24#sess-1',
      eventType: 'eval_v2_scored',
      subjectId: 'sess-1',
      ts: '2026-09-25T17:15:00.000Z',
    });
    expect(item.dimensions).toMatchObject({
      graders: 'agent-task-success@1,agent-tool-correctness@1,agent-groundedness-offline@1,agent-reply-length-adherence@1,agent-format-adherence@1,agent-act-without-asking@1',
      taskType: 'ads',
      model: 'gemini-3.8-flash',
      frameSize: 56,
      sampleSize: 50,
    });
  });

  it('stores verdicts and counts only, never message text', () => {
    const item = buildScoredEventItem(graded, ctx, new Date('2026-09-25T17:15:00Z'));
    expect(JSON.stringify(item)).not.toContain('SECRET');
    expect(JSON.stringify(item)).not.toContain('Launch Google Ads');
    const dims = item.dimensions as Record<string, unknown>;
    for (const v of Object.values(dims)) expect(['string', 'number', 'boolean']).toContain(typeof v);
  });

  it('stores the adherence verdicts and reason codes, never the turn text (ENG-2189)', () => {
    const turns = [{ userText: 'SECRET brief: show me this in a table', replyText: 'SECRET numbers without a table', toolNames: [] }];
    const item = buildScoredEventItem(gradeSession({ ...session, turns }, 'm', undefined), ctx, new Date('2026-09-25T17:15:00Z'));
    expect(JSON.stringify(item)).not.toContain('SECRET');
    expect(item.dimensions).toMatchObject({ formatVerdict: 'fail', formatReason: 'table_missing', lengthVerdict: 'not_applicable', permissionReason: 'no_act_instruction' });
    expect(parseScoredEvent(item as Record<string, unknown>)?.adherence).toEqual({ length: 'not_applicable', format: 'fail', permission: 'not_applicable' });
  });

  it('round-trips through parseScoredEvent and rejects other rows', () => {
    const parsed = parseScoredEvent(buildScoredEventItem(graded, ctx, new Date('2026-09-25T17:15:00Z')) as Record<string, unknown>);
    expect(parsed).toEqual({
      sessionId: 'sess-1',
      sampleDate: '2026-09-24',
      surface: 'agent/regular',
      model: 'gemini-3.8-flash',
      taskType: 'ads',
      taskVerdict: graded.task.verdict,
      toolVerdict: 'pass',
      toolCalls: 1,
      groundednessVerdict: graded.groundedness.verdict,
      adherence: { length: 'not_applicable', format: 'not_applicable', permission: 'not_applicable' },
      graderVersions: { 'agent-task-success': 1, 'agent-tool-correctness': 1, 'agent-groundedness-offline': 1, 'agent-reply-length-adherence': 1, 'agent-format-adherence': 1, 'agent-act-without-asking': 1 },
    });
    expect(parseScoredEvent({ eventType: 'agent_run_verdict', dimensions: {} })).toBeNull();
    expect(parseScoredEvent({ eventType: 'eval_v2_scored', dimensions: { sessionId: 'x', sampleDate: 'd', taskVerdict: 'maybe' } })).toBeNull();
  });

  it('names the surface by portal and session type', () => {
    expect(surfaceOf({ portalType: 'agent', sessionType: 'scheduled' })).toBe('agent/scheduled');
    expect(surfaceOf({})).toBe('unknown/unknown');
  });
});

describe('aggregateEvalV2', () => {
  const score = (over: Partial<EvalV2Score>): EvalV2Score => ({
    sessionId: 's',
    sampleDate: '2026-09-24',
    surface: 'agent/regular',
    model: 'm1',
    taskType: 'ads',
    taskVerdict: 'success',
    toolVerdict: 'pass',
    toolCalls: 3,
    groundednessVerdict: 'grounded',
    graderVersions: { 'agent-task-success': 1, 'agent-tool-correctness': 1, 'agent-groundedness-offline': 1 },
    ...over,
  });
  const now = new Date('2026-09-25T17:15:00Z');

  const scores: EvalV2Score[] = [
    score({ sessionId: 'a' }),
    score({ sessionId: 'b', taskVerdict: 'failure', toolVerdict: 'fail', groundednessVerdict: 'ungrounded' }),
    score({ sessionId: 'c', taskVerdict: 'excluded', toolCalls: 0, groundednessVerdict: 'no_claims' }),
    score({ sessionId: 'd', model: 'm2', taskType: 'content' }),
    // Six days earlier: inside 7d, outside 1d.
    score({ sessionId: 'e', sampleDate: '2026-09-18', taskVerdict: 'failure' }),
    // Seven days earlier: outside both windows.
    score({ sessionId: 'f', sampleDate: '2026-09-17', taskVerdict: 'failure' }),
  ];

  it('computes n, passes, rate and the Wilson CI per grader, leaving unlabelled sessions out of n', () => {
    const snap = aggregateEvalV2(scores, { date: '2026-09-24', windowLabel: '1d', now });
    expect(snap.sessions).toBe(4);
    const all = snap.groups[0];
    expect(all).toMatchObject({ surface: 'all', taskType: 'all', model: 'all', sessions: 4 });
    const task = all.metrics.find((m) => m.graderId === 'agent-task-success');
    expect(task).toEqual({
      graderId: 'agent-task-success',
      versions: [1],
      n: 3,
      passes: 2,
      rate: 2 / 3,
      ci: wilsonInterval(2, 3),
      notApplicable: 1,
      mayGate: false,
    });
    const tools = all.metrics.find((m) => m.graderId === 'agent-tool-correctness');
    expect(tools).toMatchObject({ n: 3, passes: 2, notApplicable: 1 });
    const grounded = all.metrics.find((m) => m.graderId === 'agent-groundedness-offline');
    expect(grounded).toMatchObject({ n: 3, passes: 2, notApplicable: 1 });
  });

  it('reports the adherence checks per group, counting pre-v2 rows (no adherence) as not applicable (ENG-2189)', () => {
    const rows = [
      score({ sessionId: 'a', adherence: { length: 'pass', format: 'not_applicable', permission: 'fail' } }),
      score({ sessionId: 'b', adherence: { length: 'fail', format: 'pass', permission: 'not_applicable' } }),
      score({ sessionId: 'c' }),
    ];
    const all = aggregateEvalV2(rows, { date: '2026-09-24', windowLabel: '1d', now }).groups[0];
    const metric = (id: string) => all.metrics.find((m) => m.graderId === id);
    expect(metric('agent-reply-length-adherence')).toMatchObject({ n: 2, passes: 1, rate: 0.5, ci: wilsonInterval(1, 2), notApplicable: 1, mayGate: false });
    expect(metric('agent-format-adherence')).toMatchObject({ n: 1, passes: 1, notApplicable: 2 });
    expect(metric('agent-act-without-asking')).toMatchObject({ n: 1, passes: 0, notApplicable: 2 });
  });

  it('splits by surface × task type × model, largest cell first', () => {
    const snap = aggregateEvalV2(scores, { date: '2026-09-24', windowLabel: '1d', now });
    expect(snap.groups.slice(1).map((g) => [g.surface, g.taskType, g.model, g.sessions])).toEqual([
      ['agent/regular', 'ads', 'm1', 3],
      ['agent/regular', 'content', 'm2', 1],
    ]);
  });

  it('reports a null rate and CI rather than 0 when no session could be labelled', () => {
    const snap = aggregateEvalV2([score({ taskVerdict: 'excluded' })], { date: '2026-09-24', windowLabel: '1d', now });
    expect(snap.groups[0].metrics[0]).toMatchObject({ n: 0, passes: 0, rate: null, ci: null, notApplicable: 1 });
  });

  it('windows by sample day: 7d covers the six days before the date, 1d only the date', () => {
    const week = aggregateEvalV2(scores, { date: '2026-09-24', windowLabel: '7d', now });
    expect(week).toMatchObject({ windowStartDate: '2026-09-18', windowEndDate: '2026-09-24', sessions: 5 });
    expect(week.groups[0].metrics[0]).toMatchObject({ n: 4, passes: 2 });
    expect(shiftDate('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('reports frame coverage per sampled day', () => {
    const runs = [
      { sampleDate: '2026-09-24', status: 'complete' as const, seed: 's', frameSize: 56, sampleSize: 50, sessionIds: ids(4), startedAt: '' },
      { sampleDate: '2026-09-10', status: 'complete' as const, seed: 's', frameSize: 9, sampleSize: 50, sessionIds: ids(9), startedAt: '' },
    ];
    const snap = aggregateEvalV2(scores, { date: '2026-09-24', windowLabel: '7d', now, runs });
    expect(snap.coverage).toEqual([{ date: '2026-09-24', frameSize: 56, sampleSize: 4, scored: 4 }]);
  });

  it('lists every grader version in a cell, so a mid-window logic change is visible', () => {
    const snap = aggregateEvalV2(
      [score({}), score({ graderVersions: { 'agent-task-success': 2, 'agent-tool-correctness': 1, 'agent-groundedness-offline': 1 } })],
      { date: '2026-09-24', windowLabel: '1d', now },
    );
    expect(snap.groups[0].metrics[0].versions).toEqual([1, 2]);
  });

  it('round-trips a snapshot row', () => {
    const snap = aggregateEvalV2(scores, { date: '2026-09-24', windowLabel: '7d', now });
    const item = buildSnapshotItem(snap);
    expect(item).toMatchObject({ loopId: 'eval-v2-daily', tsSession: '2026-09-24#7d', eventType: 'eval_v2_snapshot' });
    expect(parseSnapshotItem(item as Record<string, unknown>)).toEqual(snap);
  });
});

describe('mayGate gating (ENG-2128 principle 2)', () => {
  const s: EvalV2Score = {
    sessionId: 's', sampleDate: '2026-09-24', surface: 'agent/regular', model: 'm', taskType: 'ads',
    taskVerdict: 'success', toolVerdict: 'pass', toolCalls: 1, groundednessVerdict: 'grounded', graderVersions: {},
  };
  const now = new Date('2026-09-25T00:00:00Z');

  it('marks every sampled grader unvalidated today, straight from the eval registry', () => {
    const snap = aggregateEvalV2([s], { date: '2026-09-24', windowLabel: '1d', now });
    for (const group of snap.groups) {
      for (const m of group.metrics) {
        expect(EVAL_REGISTRY.some((g) => g.id === m.graderId)).toBe(true);
        expect({ id: m.graderId, mayGate: m.mayGate }).toEqual({ id: m.graderId, mayGate: mayGate(m.graderId) });
        expect(m.mayGate).toBe(false);
      }
    }
  });

  it('flags a metric as gateable only for a grader the registry validates', () => {
    const gate = (id: string) => id === 'agent-tool-correctness';
    const snap = aggregateEvalV2([s], { date: '2026-09-24', windowLabel: '1d', now, gate });
    expect(snap.groups[0].metrics.map((m) => [m.graderId, m.mayGate])).toEqual([
      ['agent-task-success', false],
      ['agent-tool-correctness', true],
      ['agent-groundedness-offline', false],
      ['agent-reply-length-adherence', false],
      ['agent-format-adherence', false],
      ['agent-act-without-asking', false],
    ]);
  });
});
