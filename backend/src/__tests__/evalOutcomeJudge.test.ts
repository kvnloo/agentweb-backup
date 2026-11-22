/**
 * ENG-2138: offline replay of the shadow outcome judge vs deterministic task success. The
 * argument parser is strict (a typo must not start live judge calls) and the report is
 * aggregates only.
 */
import { loadPromptFile, parseArgs, replaySession, summarizeReplay, type JudgedSession } from '../scripts/evalOutcomeJudge';
import type { ChatSession } from '../services/chatbotService';
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

  it('accepts --no-judge-clauses for a serializer-only replay (ENG-2483)', () => {
    expect(parseArgs(['--from', '2026-07-10', '--to', '2026-10-07', '--no-judge-clauses'])).toEqual(
      expect.objectContaining({ mode: 'replay', noJudgeClauses: true }),
    );
    expect(parseArgs(['--from', '2026-07-10', '--to', '2026-10-07'])).not.toHaveProperty('noJudgeClauses');
  });

  it('accepts --prompt-file for a candidate rubric and rejects an empty one (ENG-2380)', () => {
    expect(parseArgs(['--from', '2026-07-10', '--to', '2026-10-07', '--prompt-file', '/tmp/B.txt'])).toEqual(
      expect.objectContaining({ mode: 'replay', promptFile: '/tmp/B.txt' }),
    );
    expect(parseArgs(['--from', '2026-07-10', '--to', '2026-10-07'])).not.toHaveProperty('promptFile');
    expect(() => parseArgs(['--from', '2026-07-10', '--to', '2026-10-07', '--prompt-file'])).toThrow(/--prompt-file needs a value/);
    expect(loadPromptFile('x', () => '  rubric B  \n')).toBe('rubric B');
    expect(() => loadPromptFile('x', () => ' \n ')).toThrow(/is empty/);
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

  it('counts a 5 as a score of at least 4.95, so a decimal 4.6 is not a 5', () => {
    const rows = [row(true, 4.97), row(true, 4.6), row(true, 4.5), row(false, 2.3), row(false, 4.95)];
    const s = summarizeReplay(rows);
    expect(s.shareAt5).toBeCloseTo(2 / 5, 10);
    // The histogram keeps whole-number buckets for display.
    expect(s.histogram).toEqual({ 1: 0, 2: 1, 3: 0, 4: 0, 5: 4 });
    // ENG-2138: the rounded share is a separate field, so the two printed numbers are not confused.
    expect(s.shareRoundingTo5).toBeCloseTo(4 / 5, 10);
  });

  it('has no rounded share for an empty replay', () => {
    expect(summarizeReplay([])).toEqual(expect.objectContaining({ shareAt5: null, shareRoundingTo5: null }));
  });

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

describe('replaySession (same gates as production before a custom judge)', () => {
  const STALE = '2026-09-01T00:00:00.000Z';
  const task = { role: 'user', content: 'Build a Meta campaign for the spring sale and launch it.' };
  const reply = { role: 'assistant', content: 'The campaign is live: 3 ad sets, $50/day.' };
  const session = (messages: object[], extra: object = {}): ChatSession =>
    ({ sessionId: 's-1', messages, messageCount: messages.length, updatedAt: STALE, ...extra }) as unknown as ChatSession;
  const judge = jest.fn(async (): Promise<{ score: number; taskRequested?: boolean }> => ({ score: 4 }));

  beforeEach(() => judge.mockClear());

  it('drops production cohort exclusions without calling the judge', async () => {
    const cases: Array<[ChatSession, string]> = [
      [session([reply]), 'no-user-message'],
      [session([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'Hi! How can I help?' }]), 'no-task-session'],
      [session([task, reply], { sessionType: 'scheduled', pageIdentifier: 'Test: Weekly report|scheduleId:x' }), 'test-run'],
    ];
    for (const [s, reason] of cases) {
      expect(await replaySession(s, judge)).toEqual({ kind: 'cohort_excluded', reason });
    }
    expect(judge).not.toHaveBeenCalled();
  });

  it("gives stale failed and turn-less runs production's fixed 1 without a model call", async () => {
    const placeholder = { role: 'assistant', content: 'The run did not finish.', metadata: { isRunFailureNotice: true } };
    expect(await replaySession(session([task, reply, placeholder]), judge)).toEqual({ kind: 'scored', score: 1, failedRun: true });
    expect(await replaySession(session([task]), judge)).toEqual({ kind: 'scored', score: 1, failedRun: true });
    expect(judge).not.toHaveBeenCalled();
  });

  it('skips a turn-less session that is still in flight', async () => {
    expect(await replaySession(session([task], { updatedAt: new Date().toISOString() }), judge)).toEqual({ kind: 'in_flight' });
    expect(judge).not.toHaveBeenCalled();
  });

  it('judges an in-cohort session and honours the judge saying no task was requested', async () => {
    expect(await replaySession(session([task, reply]), judge)).toEqual({ kind: 'scored', score: 4, failedRun: false });
    judge.mockResolvedValueOnce({ score: 3, taskRequested: false });
    expect(await replaySession(session([task, reply]), judge)).toEqual({ kind: 'judge_no_task' });
  });
});
