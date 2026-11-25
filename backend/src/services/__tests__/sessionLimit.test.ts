/**
 * ENG-2812 acceptance: a replayed runaway session stops at the cap and waits for confirmation;
 * the 75%/90% notices fire once per threshold. Counters persist on the session item, so a new
 * tracker (another instance, after a deploy) sees the same state.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  isSessionLimitConfirmation,
  sessionLimitCapsForTier,
  sessionLimitWarningMessage,
  startSessionLimit,
  type SessionLimitDeps,
  type SessionLimitTracker,
} from '../sessionLimit';
import { describeScheduledRunFailureReasons } from '../../utils/scheduledRunFailureReasons';
import { hasUnresolvedMediaDeferral } from '../../utils/timeoutContinuation';

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
    // Owner decision 2026-11-25: the customer-facing pause text carries no numbers (the usage is logged and stored on the message).
    expect(tracker.pauseMessage(false)).toBe('This session has reached its usage limit. Reply "continue" to keep going in this session, or start a new session.');

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
    // Stopped by the dollar side, and the text still shows no dollar figure or count.
    expect(tracker.pauseMessage(false)).not.toMatch(/[$\d]/);
  });

  it('an unattended scheduled run cannot confirm: it stays paused with a scheduled-run notice', async () => {
    const t = fakeTable({ sessionId: SESSION, sessionLimitTurns: 150, sessionLimitSpendMicroUsd: 1 });
    const tracker = (await startSessionLimit({ ...attended('continue'), isUnattendedRun: true, warningsAllowed: false }, t.deps))!;
    expect(tracker.reached()).toBe(true);
    expect(tracker.pauseMessage(true)).toBe('This scheduled run paused because the session reached its usage limit. Open this session and reply "continue" to keep going, or start a new session.');
    expect(t.item()!.sessionLimitWindowStartTurns).toBeUndefined();
  });

  // ENG-2812 / ENG-3164: a share-link visitor's "continue" is not the owner's word. Found live 2026-11-25: it reopened the owner's window.
  describe('a share-link visitor', () => {
    const visitor = (messageContent = 'continue') => ({ ...attended(messageContent), isShareVisitor: true });

    it('cannot reopen the owner\'s window with "continue" (or any confirmation word); the owner on the same session still can', async () => {
      for (const word of ['continue', 'Keep going', 'yes', 'proceed', 'ok continue']) {
        const t = fakeTable({ sessionId: SESSION, sessionLimitTurns: 150, sessionLimitSpendMicroUsd: 1 });
        const tracker = (await startSessionLimit(visitor(word), t.deps))!;
        expect(tracker.reached()).toBe(true);
        expect(t.item()!.sessionLimitWindowStartTurns).toBeUndefined(); // no window written
        expect((await runLoop(tracker, 40, 0.01)).calls).toBe(0);
      }
      const t = fakeTable({ sessionId: SESSION, sessionLimitTurns: 150, sessionLimitSpendMicroUsd: 1 });
      expect((await startSessionLimit(visitor(), t.deps))!.reached()).toBe(true);
      const owner = (await startSessionLimit(attended('continue'), t.deps))!; // the owner's own turn: no visitor flag
      expect(owner.reached()).toBe(false);
      expect(t.item()!.sessionLimitWindowStartTurns).toBe(150);
    });

    it('is told to ask the person who shared the chat, in plain words with no numbers', async () => {
      const t = fakeTable({ sessionId: SESSION, sessionLimitTurns: 150, sessionLimitSpendMicroUsd: 1 });
      const tracker = (await startSessionLimit(visitor('what is next?'), t.deps))!;
      expect(tracker.pauseMessage(false)).toBe('This shared chat has reached its usage limit. Ask the person who shared it to continue it.');
    });

    it('still counts its turns against the shared session, but never sees the 75% / 90% notices (nor claims them for the owner)', async () => {
      const t = fakeTable({ sessionId: SESSION, sessionLimitTurns: 112, sessionLimitSpendMicroUsd: 0 });
      const tracker = (await startSessionLimit(visitor('hello'), t.deps))!;
      await tracker.recordTurn(0.01); // 113 of 150: past 75%
      expect(t.item()!.sessionLimitTurns).toBe(113);
      expect(tracker.dueWarning()).toBeUndefined();
      expect(t.item()!.sessionLimitWarned75).toBeUndefined(); // not claimed: the owner's next turn still gets the notice
      const ownerTurn = (await startSessionLimit(attended('hello'), t.deps))!;
      await ownerTurn.recordTurn(0.01);
      expect(ownerTurn.dueWarning()).toBe(75);
    });
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

describe('media reopen backstop', () => {
  it('does not resume a deferral listed on a session-limit pause message', () => {
    const deferred = { name: 'generate_video', result: { mediaBudgetDeferred: true } };
    const base = { role: 'assistant', content: 'x', metadata: { toolCalls: [deferred] } } as any;
    expect(hasUnresolvedMediaDeferral([{ ...base, metadata: { ...base.metadata, mediaBudgetDeferred: true } }])).toBe(true);
    expect(hasUnresolvedMediaDeferral([{ ...base, metadata: { mediaBudgetDeferred: true, sessionLimitPaused: { turns: 150 } } }])).toBe(false);
  });
});

// ENG-2812 / ENG-3164: the visitor rule above only holds if the turn's visitor flag actually reaches the limit. Replies are generated in a
// forked worker, so the in-process visitor marker is NOT visible there; the flag that does cross is `isInteractiveShare` (false for the
// owner on their own link). A behavioural test would need the whole model stack, so the wiring is pinned the way ENG-827 pins its own.
describe('the visitor flag reaches the session limit (wiring)', () => {
  const read = (rel: string) => fs.readFileSync(path.join(__dirname, rel), 'utf8');

  it('startSessionLimitForRun is called with isShareVisitor taken from the turn\'s isInteractiveShare', () => {
    const src = read('../agentModeService.ts');
    const call = src.slice(src.indexOf('await startSessionLimitForRun({'));
    const args = call.slice(0, call.indexOf('});'));
    // Anchored at the start of a line: a commented-out `// isShareVisitor: ...` must not satisfy it.
    expect(args).toMatch(/^[ \t]+isShareVisitor:\s*isInteractiveShare\s*===\s*true,/m);
  });

  it('isInteractiveShare crosses the worker boundary: declared, sent by the controller, unpacked, and passed in its POSITION', () => {
    expect(read('../generateMarketingResponseWorkerService.ts')).toMatch(/isInteractiveShare\?:\s*boolean/);
    const controller = read('../../controllers/agentModeController.ts');
    const payload = controller.slice(controller.indexOf('runInWorker('), controller.indexOf('runInWorker(') + 900);
    expect(payload).toMatch(/^[ \t]+isInteractiveShare: isInteractiveShare \|\| false,/m);
    const worker = read('../../workers/generateMarketingResponseWorker.ts');
    expect(worker).toMatch(/const\s*\{[^}]*\bisInteractiveShare\b[^}]*\}\s*=\s*message\.params/);
    // The worker's argument list comes off `any`, so its ORDER is not type-checked: pin it, on both sides of the call.
    const call = worker.slice(worker.indexOf('agentModeService.generateMarketingResponse('));
    expect(call.slice(0, call.indexOf(');'))).toMatch(/^[ \t]+mockMode,\s*onProgress,\s*socketEmit,\s*isInteractiveShare,\s*isCancelled,/m);
    const service = read('../agentModeService.ts');
    expect(service).toMatch(/mockMode: boolean = false,\s*onProgress\?:[^\n]*\n\s*socketEmit\?:[^\n]*\n\s*isInteractiveShare: boolean = false,\s*isCancelled\?:/);
  });

  it('the share route passes isInteractiveShare = "not the owner" in its slot, so the owner on their own link is not treated as a visitor', () => {
    const controller = read('../../controllers/agentModeController.ts');
    expect(controller).toMatch(/^[ \t]+modelToUse,\s*attachments,\s*!viewerIsOwner,\s*\/\/ isInteractiveShare/m);
  });
});
