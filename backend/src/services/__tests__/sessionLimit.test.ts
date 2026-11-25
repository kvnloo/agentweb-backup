/**
 * ENG-2812 acceptance: a replayed runaway session stops at the cap and waits for confirmation;
 * the 75%/90% notices fire once per threshold. Counters persist on the session item, so a new
 * tracker (another instance, after a deploy) sees the same state.
 */
import {
  isSessionLimitConfirmation,
  sessionLimitCapsForTier,
  sessionLimitWarningMessage,
  startSessionLimit,
  type SessionLimitDeps,
  type SessionLimitTracker,
} from '../sessionLimit';
import { describeScheduledRunFailureReasons } from '../../utils/scheduledRunFailureReasons';

const SESSION = 'sess-runaway';

/** Minimal fake of the conditional/atomic writes the module issues against one session item. */
function fakeTable(initial: Record<string, any> | null = { sessionId: SESSION }) {
  let item: Record<string, any> | null = initial ? { ...initial } : null;
  const conditionFailed = () => Object.assign(new Error('cond'), { code: 'ConditionalCheckFailedException' });
  const deps: SessionLimitDeps = {
    tableName: 'AW-ChatSessions',
    resolveCaps: async () => ({ maxTurns: 150, maxSpendUsd: 20 }),
    log: () => {},
    env: {},
    get: async () => ({ Item: item ? { ...item } : undefined }),
    update: async (p: any) => {
      if (!item) throw conditionFailed();
      const n = p.ExpressionAttributeNames;
      const v = p.ExpressionAttributeValues;
      if (p.UpdateExpression.startsWith('ADD')) {
        item[n['#t']] = (item[n['#t']] ?? 0) + v[':one'];
        item[n['#s']] = (item[n['#s']] ?? 0) + v[':micro'];
        return { Attributes: { [n['#t']]: item[n['#t']], [n['#s']]: item[n['#s']] } };
      }
      if (p.UpdateExpression === 'SET #wt = :t, #ws = :s') {
        if (item[n['#wt']] !== undefined && item[n['#wt']] !== v[':old']) throw conditionFailed();
        item[n['#wt']] = v[':t'];
        item[n['#ws']] = v[':s'];
        return {};
      }
      if (p.UpdateExpression === 'SET #w = :win') {
        if (item[n['#w']] === v[':win']) throw conditionFailed();
        item[n['#w']] = v[':win'];
        return {};
      }
      throw new Error(`unexpected update ${p.UpdateExpression}`);
    },
  };
  return { deps, item: () => item };
}

const attended = (messageContent = 'audit my CRM') => ({
  sessionId: SESSION, userId: 'u1', messageContent, warningsAllowed: true,
});

/** Drive one run the way the agent loop does: check before each model call, then count it. */
async function runLoop(tracker: SessionLimitTracker, maxCalls: number, costPerTurn: number) {
  let calls = 0;
  while (calls < maxCalls) {
    if (tracker.reached()) return { calls, paused: true };
    calls++;
    await tracker.recordTurn(costPerTurn);
  }
  return { calls, paused: false };
}

describe('sessionLimitCapsForTier (150 turns / $20 at the $80 Starter allowance, scaled up)', () => {
  const tier = (hardUsd?: number, monthlyCostAllowance?: number) => ({
    name: 't', allowedPages: [], allowedSkills: [], monthlyCostAllowance,
    ...(hardUsd !== undefined ? { llmUsagePolicy: { hardCostThresholdMicroUsd: hardUsd * 1e6 } as any } : {}),
  });

  it('gives the baseline to Starter, to smaller tiers and to tiers with no allowance', () => {
    expect(sessionLimitCapsForTier(tier(80))).toEqual({ maxTurns: 150, maxSpendUsd: 20 });
    expect(sessionLimitCapsForTier(tier(5))).toEqual({ maxTurns: 150, maxSpendUsd: 20 });
    expect(sessionLimitCapsForTier(tier())).toEqual({ maxTurns: 150, maxSpendUsd: 20 });
    expect(sessionLimitCapsForTier(null)).toEqual({ maxTurns: 150, maxSpendUsd: 20 });
  });

  it('scales higher tiers in proportion to their allowance', () => {
    expect(sessionLimitCapsForTier(tier(200))).toEqual({ maxTurns: 375, maxSpendUsd: 50 });
    expect(sessionLimitCapsForTier(tier(900))).toEqual({ maxTurns: 1688, maxSpendUsd: 225 });
    expect(sessionLimitCapsForTier(tier(undefined, 500))).toEqual({ maxTurns: 938, maxSpendUsd: 125 });
  });
});

describe('replayed runaway session (Opiner aea6a0ee: 549 turns, ~$47)', () => {
  const COST = 47 / 549;

  it('stops at the cap, stays paused for anything but a confirmation, and resumes on "continue"', async () => {
    const t = fakeTable();
    let tracker = (await startSessionLimit(attended(), t.deps))!;
    // One user request driving many 40-step turns: count until the loop is stopped.
    let total = 0;
    let paused = false;
    while (!paused && total < 549) {
      const r = await runLoop(tracker, 40, COST);
      total += r.calls;
      paused = r.paused;
    }
    expect(paused).toBe(true);
    // $20 at ~$0.0856/turn is reached at turn 234 > 150, so the turn cap trips first.
    expect(total).toBe(150);
    expect(tracker.pauseMessage(false)).toContain('150 of 150 steps');

    // A new run (another instance / after a deploy) reads the persisted counters: still paused.
    tracker = (await startSessionLimit(attended('what else can you do?'), t.deps))!;
    expect(tracker.reached()).toBe(true);
    expect((await runLoop(tracker, 40, COST)).calls).toBe(0);

    // Explicit confirmation opens a fresh window of the same size.
    tracker = (await startSessionLimit(attended('Continue.'), t.deps))!;
    expect(tracker.reached()).toBe(false);
    const after = await runLoop(tracker, 400, COST);
    expect(after).toEqual({ calls: 150, paused: true });
    expect(t.item()!.sessionLimitTurns).toBe(300);
  });

  it('trips on spend when turns are expensive', async () => {
    const t = fakeTable();
    const tracker = (await startSessionLimit(attended(), t.deps))!;
    const r = await runLoop(tracker, 100, 0.5);
    expect(r).toEqual({ calls: 40, paused: true });
    expect(tracker.pauseMessage(false)).toContain('$20.00 of $20.00');
  });

  it('an unattended scheduled run cannot confirm: it stays paused with a scheduled-run notice', async () => {
    const t = fakeTable({ sessionId: SESSION, sessionLimitTurns: 150, sessionLimitSpendMicroUsd: 1 });
    const tracker = (await startSessionLimit({ ...attended('continue'), isUnattendedRun: true, warningsAllowed: false }, t.deps))!;
    expect(tracker.reached()).toBe(true);
    expect(tracker.pauseMessage(true)).toMatch(/^This scheduled run paused/);
    expect(t.item()!.sessionLimitWindowStartTurns).toBeUndefined();
  });

  it('two simultaneous confirmations open exactly one window', async () => {
    const t = fakeTable({ sessionId: SESSION, sessionLimitTurns: 150, sessionLimitSpendMicroUsd: 0 });
    const [a, b] = await Promise.all([
      startSessionLimit(attended('continue'), t.deps),
      startSessionLimit(attended('keep going'), t.deps),
    ]);
    expect(a!.reached()).toBe(false);
    expect(b!.reached()).toBe(false);
    expect(t.item()!.sessionLimitWindowStartTurns).toBe(150);
  });
});

describe('75% / 90% notices', () => {
  it('fire once per threshold per window, at 113 and 135 turns', async () => {
    const t = fakeTable();
    const seen: Array<{ turn: number; pct: number }> = [];
    let turn = 0;
    // Each user message is a new run of 10 model calls; the notice is shown at the end of the run.
    while (turn < 150) {
      const tracker = (await startSessionLimit(attended(), t.deps))!;
      const r = await runLoop(tracker, 10, 0.01);
      turn += r.calls;
      const w = tracker.dueWarning();
      if (w) seen.push({ turn, pct: w });
      if (r.paused) break;
    }
    expect(seen).toEqual([{ turn: 120, pct: 75 }, { turn: 140, pct: 90 }]);
    expect(sessionLimitWarningMessage(75)).toBe(
      'You have used 75% of this session’s limit. Start a new session to keep going without interruption.',
    );
  });

  it('shows only the 90% notice when one run jumps past both, and never the 75% one afterwards', async () => {
    const t = fakeTable();
    let tracker = (await startSessionLimit(attended(), t.deps))!;
    await runLoop(tracker, 140, 0);
    expect(tracker.dueWarning()).toBe(90);
    tracker = (await startSessionLimit(attended(), t.deps))!;
    await runLoop(tracker, 5, 0);
    expect(tracker.dueWarning()).toBeUndefined();
  });

  it('re-arms in a new window after confirmation', async () => {
    const t = fakeTable({ sessionId: SESSION, sessionLimitTurns: 150, sessionLimitSpendMicroUsd: 0, sessionLimitWarned75: 0, sessionLimitWarned90: 0 });
    const tracker = (await startSessionLimit(attended('continue'), t.deps))!;
    await runLoop(tracker, 115, 0);
    expect(tracker.dueWarning()).toBe(75);
  });

  it('are not shown when warnings are not allowed (unattended runs, Slack) and do not consume the threshold', async () => {
    const t = fakeTable();
    const silent = (await startSessionLimit({ ...attended(), warningsAllowed: false }, t.deps))!;
    await runLoop(silent, 120, 0);
    expect(silent.dueWarning()).toBeUndefined();
    const inApp = (await startSessionLimit(attended(), t.deps))!;
    await runLoop(inApp, 1, 0);
    expect(inApp.dueWarning()).toBe(75);
  });

  it('a notice claimed by a concurrent run is not shown again', async () => {
    const t = fakeTable({ sessionId: SESSION, sessionLimitTurns: 112, sessionLimitSpendMicroUsd: 0 });
    const a = (await startSessionLimit(attended(), t.deps))!;
    const b = (await startSessionLimit(attended(), t.deps))!;
    await a.recordTurn(0);
    await b.recordTurn(0);
    expect([a.dueWarning(), b.dueWarning()].filter(Boolean)).toEqual([75]);
  });
});

describe('fail-open and switches', () => {
  it('is off with SESSION_LIMIT_ENFORCE=false', async () => {
    const t = fakeTable();
    expect(await startSessionLimit(attended(), { ...t.deps, env: { SESSION_LIMIT_ENFORCE: 'false' } })).toBeNull();
  });

  it('returns null when the session item does not exist or the read fails', async () => {
    expect(await startSessionLimit(attended(), fakeTable(null).deps)).toBeNull();
    const t = fakeTable();
    expect(await startSessionLimit(attended(), { ...t.deps, get: async () => { throw new Error('throttled'); } })).toBeNull();
  });

  it('keeps counting locally when a counter write fails, so the run still stops at its cap', async () => {
    const t = fakeTable();
    const tracker = (await startSessionLimit(attended(), t.deps))!;
    t.deps.update = async () => { throw new Error('throttled'); };
    expect(await runLoop(tracker, 400, 0)).toEqual({ calls: 150, paused: true });
  });

  it('uses baseline caps when the tier lookup fails', async () => {
    const t = fakeTable();
    const tracker = (await startSessionLimit(attended(), { ...t.deps, resolveCaps: async () => { throw new Error('x'); } }))!;
    expect(tracker.caps).toEqual({ maxTurns: 150, maxSpendUsd: 20 });
  });
});

describe('isSessionLimitConfirmation', () => {
  it.each(['continue', 'Continue!', ' keep going ', 'Yes, continue', 'OK continue.'])('accepts %p', (text) => {
    expect(isSessionLimitConfirmation(text)).toBe(true);
  });
  it.each(['', 'continue with the next report about Q3', 'no', '[SYSTEM] continue the work plan', undefined])('rejects %p', (text) => {
    expect(isSessionLimitConfirmation(text as any)).toBe(false);
  });
});

describe('scheduled run failure reasons', () => {
  it('names a session-limit pause', () => {
    expect(describeScheduledRunFailureReasons({ terminationReason: 'session_limit' } as any)).toEqual([
      'paused at the session turn/spend limit; waiting for someone to reply "continue" in the session',
    ]);
  });
});
