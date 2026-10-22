/**
 * ENG-110: cross-instance active-run guard (AW-ChatSessions.activeRun). Two simulated instances (A and B)
 * share ONE in-memory DynamoDB that really evaluates the conditional expressions, so the assertions are about
 * what the table ends up holding, not about call arguments. Time is jest fake time (Date and timers together).
 */
import { BranchFakeDynamo } from './helpers/branchFakeDynamo';
import {
  ACTIVE_RUN_HEARTBEAT_INTERVAL_MS,
  ACTIVE_RUN_STALE_AFTER_MS,
  SETTING_READ_TIMEOUT_MS,
  SESSION_ACTIVE_RUN_GUARD_SETTING,
  carryConcealedActiveRun,
  concealActiveRun,
  createSessionActiveRunGuard,
  isActiveRunFresh,
  omitActiveRun,
} from '../services/agentMode/sessionActiveRunGuard';

const TABLE = 'AW-ChatSessions';
const SID = 's1';

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

interface Env {
  fake: BranchFakeDynamo;
  log: jest.Mock;
  setting: { value: unknown; fail: boolean };
  make(instanceId: string, over?: Partial<Parameters<typeof createSessionActiveRunGuard>[0]>): ReturnType<typeof createSessionActiveRunGuard>;
}

function env(...args: [] | [unknown]): Env {
  const settingValue = args.length === 0 ? 'true' : args[0];
  const fake = new BranchFakeDynamo();
  fake.seedSession({ sessionId: SID, userId: 'u1', updatedAt: '2026-10-13T00:00:00.000Z', adminListPartition: 'p' });
  const log = jest.fn();
  const setting = { value: settingValue, fail: false };
  let n = 0;
  return {
    fake,
    log,
    setting,
    make: (instanceId, over = {}) =>
      createSessionActiveRunGuard({
        getSetting: async (name) => {
          expect(name).toBe(SESSION_ACTIVE_RUN_GUARD_SETTING);
          if (setting.fail) throw new Error('settings down');
          return setting.value === undefined ? null : { settingValue: setting.value };
        },
        update: (p) => fake.client().update(p).promise(),
        tableName: () => TABLE,
        now: () => Date.now(),
        log,
        instanceId,
        newRunId: () => `run-${instanceId}-${++n}`,
        ...over,
      }),
  };
}

/** Simulate the process dying: its timers vanish (clearAllTimers also resets the fake clock, so restore it). */
const killTimers = () => {
  const now = Date.now();
  jest.clearAllTimers();
  jest.setSystemTime(now);
};

const activeRunOf = (e: Env) => e.fake.session(SID)?.activeRun;

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  jest.setSystemTime(new Date('2026-10-13T12:00:00.000Z'));
});
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe('claim', () => {
  it('claims a free session, stores the run, and starts exactly one heartbeat timer', async () => {
    const e = env();
    const claim = await e.make('A').claim(SID);
    expect(claim.status).toBe('claimed');
    expect(activeRunOf(e)).toEqual({
      runId: expect.stringMatching(/^run-A-/), instanceId: 'A', startedAt: Date.now(), heartbeatAt: Date.now(),
    });
    expect(jest.getTimerCount()).toBe(1);
  });

  it('a live run on A makes B busy; B writes nothing and starts no timer', async () => {
    const e = env();
    const a = await e.make('A').claim(SID);
    const before = activeRunOf(e);
    const b = await e.make('B').claim(SID);
    expect(b.status).toBe('busy');
    expect(activeRunOf(e)).toEqual(before);
    expect(jest.getTimerCount()).toBe(1); // only A's
    expect(a.status).toBe('claimed');
  });

  it('a dead run on A (no more beats) is claimable by B only once the heartbeat is older than the staleness window', async () => {
    const e = env();
    await e.make('A').claim(SID);
    killTimers(); // A's process died: no more beats
    jest.setSystemTime(Date.now() + ACTIVE_RUN_STALE_AFTER_MS); // exactly at the boundary: still live
    expect((await e.make('B').claim(SID)).status).toBe('busy');
    jest.setSystemTime(Date.now() + 1); // one ms past: stale
    const b = await e.make('B').claim(SID);
    expect(b.status).toBe('claimed');
    expect(activeRunOf(e).instanceId).toBe('B');
  });

  it('staleness is 3 beats (90s) and a 91s-old heartbeat is not live', () => {
    expect(ACTIVE_RUN_STALE_AFTER_MS).toBe(90_000);
    expect(ACTIVE_RUN_HEARTBEAT_INTERVAL_MS).toBe(30_000);
  });

  it('the same runId may re-claim (even from another instance object)', async () => {
    const e = env();
    const a = await e.make('A', { newRunId: () => 'same' }).claim(SID);
    const b = await e.make('B', { newRunId: () => 'same' }).claim(SID);
    expect([a.status, b.status]).toEqual(['claimed', 'claimed']);
  });

  it('the same INSTANCE may re-claim (its in-memory lock proves the earlier run ended: Stop then immediate resend)', async () => {
    const e = env();
    const guard = e.make('A');
    await guard.claim(SID); // old run's clear has not landed yet
    const second = await guard.claim(SID);
    expect(second.status).toBe('claimed');
    expect(activeRunOf(e).runId).toMatch(/^run-A-2$/);
  });

  it('a missing session item is not created by the claim (attribute_exists(sessionId))', async () => {
    const e = env();
    e.fake.sessions().delete(SID);
    expect((await e.make('A').claim(SID)).status).toBe('busy');
    expect(e.fake.session(SID)).toBeUndefined();
  });

  it('never touches updatedAt or adminListPartition', async () => {
    const e = env();
    const claim = await e.make('A').claim(SID);
    jest.advanceTimersByTime(ACTIVE_RUN_HEARTBEAT_INTERVAL_MS);
    await flush();
    if (claim.status === 'claimed') await claim.release();
    const item = e.fake.session(SID)!;
    expect(item.updatedAt).toBe('2026-10-13T00:00:00.000Z');
    expect(item.adminListPartition).toBe('p');
    expect(e.fake.writeLog.length).toBeGreaterThan(0);
  });
});

describe('switch', () => {
  it.each([undefined, null, 'false', 'TRUE', ' true', 'true ', true, '1', ''])('value %p => off: ZERO DynamoDB calls, no timer', async (value) => {
    const e = env(value);
    const guard = e.make('A');
    expect(await guard.claim(SID)).toEqual({ status: 'skipped' });
    expect(e.fake.writeLog).toEqual([]);
    expect(activeRunOf(e)).toBeUndefined();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('off also ignores a fresh activeRun when judging "live elsewhere"', async () => {
    const e = env('true');
    await e.make('A').claim(SID);
    const run = activeRunOf(e);
    const offGuard = env('false').make('B');
    expect(await offGuard.hasLiveRunElsewhere(run)).toBe(false);
  });

  it('is cached ~60s, refreshed after, keeps the last-known value on a failed refresh, and is off on a cold-start failure', async () => {
    const e = env('true');
    const getSetting = jest.fn(async () => (e.setting.fail ? Promise.reject(new Error('down')) : { settingValue: e.setting.value }));
    const guard = e.make('A', { getSetting });
    expect(await guard.isEnabled()).toBe(true);
    e.setting.value = 'false';
    jest.setSystemTime(Date.now() + 59_000);
    expect(await guard.isEnabled()).toBe(true); // cached
    expect(getSetting).toHaveBeenCalledTimes(1);
    e.setting.fail = true;
    jest.setSystemTime(Date.now() + 2_000);
    expect(await guard.isEnabled()).toBe(true); // refresh failed => last-known (on)
    expect(e.log).toHaveBeenCalledWith(expect.stringContaining('failed to read switch'), expect.anything());
    e.setting.fail = false;
    jest.setSystemTime(Date.now() + 6_000); // error retry window passed
    expect(await guard.isEnabled()).toBe(false); // now reads 'false'

    const cold = env('true');
    cold.setting.fail = true;
    expect(await cold.make('C').isEnabled()).toBe(false);
  });

  it('a HUNG settings read never stalls the claim: it gives up after the timeout, skips the guard, touches DynamoDB not at all, and logs', async () => {
    const e = env('true');
    const getSetting = jest.fn(() => new Promise<never>(() => undefined)); // never settles
    const guard = e.make('A', { getSetting });
    let result: unknown;
    void guard.claim(SID).then((r) => { result = r; });
    await flush();
    expect(result).toBeUndefined(); // still waiting, bounded by the timeout
    jest.advanceTimersByTime(SETTING_READ_TIMEOUT_MS);
    await flush();
    expect(result).toEqual({ status: 'skipped' });
    expect(e.fake.writeLog).toEqual([]);
    expect(e.log).toHaveBeenCalledWith(expect.stringContaining('failed to read switch'), expect.anything());
    expect(jest.getTimerCount()).toBe(0); // the timeout timer does not leak
    // Within the error-retry window the next claim does not wait again.
    expect(await guard.claim(SID)).toEqual({ status: 'skipped' });
    expect(getSetting).toHaveBeenCalledTimes(1);
  });

  it('a hung refresh keeps the last-known value (on) instead of turning the guard off', async () => {
    const e = env('true');
    let hang = false;
    const guard = e.make('A', { getSetting: () => (hang ? new Promise<never>(() => undefined) : Promise.resolve({ settingValue: 'true' })) });
    expect(await guard.isEnabled()).toBe(true);
    hang = true;
    jest.setSystemTime(Date.now() + 61_000);
    let result: boolean | undefined;
    void guard.isEnabled().then((r) => { result = r; });
    await flush();
    jest.advanceTimersByTime(SETTING_READ_TIMEOUT_MS);
    await flush();
    expect(result).toBe(true);
  });

  it('a settings read failure never blocks a run (claim is skipped)', async () => {
    const e = env('true');
    e.setting.fail = true;
    expect(await e.make('A').claim(SID)).toEqual({ status: 'skipped' });
    expect(e.fake.writeLog).toEqual([]);
  });
});

describe('fail-open', () => {
  it.each([
    ['throttle', Object.assign(new Error('slow down'), { code: 'ProvisionedThroughputExceededException' })],
    ['network', Object.assign(new Error('socket hang up'), { code: 'NetworkingError' })],
    ['missing client', new TypeError('Cannot read properties of undefined')],
  ])('a %s error on the claim lets the run proceed without the guard', async (_n, error) => {
    const e = env();
    const guard = e.make('A', { update: () => Promise.reject(error) });
    expect(await guard.claim(SID)).toEqual({ status: 'skipped' });
    expect(e.log).toHaveBeenCalledWith(expect.stringContaining('fail-open'), expect.objectContaining({ sessionId: SID }));
    expect(jest.getTimerCount()).toBe(0);
  });

  it('only ConditionalCheckFailedException means busy', async () => {
    const e = env();
    const guard = e.make('A', { update: () => Promise.reject(Object.assign(new Error('x'), { code: 'ConditionalCheckFailedException' })) });
    expect(await guard.claim(SID)).toEqual({ status: 'busy' });
  });
});

describe('heartbeat', () => {
  it('refreshes heartbeatAt every 30s and keeps the run live past the staleness window', async () => {
    const e = env();
    await e.make('A').claim(SID);
    const startedAt = Date.now();
    for (let i = 0; i < 6; i++) {
      jest.advanceTimersByTime(ACTIVE_RUN_HEARTBEAT_INTERVAL_MS);
      await flush();
    }
    expect(activeRunOf(e).heartbeatAt).toBe(startedAt + 6 * ACTIVE_RUN_HEARTBEAT_INTERVAL_MS);
    expect(activeRunOf(e).startedAt).toBe(startedAt);
    expect((await e.make('B').claim(SID)).status).toBe('busy'); // 180s in, still live thanks to the beats
  });

  it('a failed beat is only logged: the run keeps going and the next beat is attempted', async () => {
    const e = env();
    let failing = false;
    const guard = e.make('A', {
      update: (p: any) => (failing && p.UpdateExpression.startsWith('SET activeRun.heartbeatAt')
        ? Promise.reject(Object.assign(new Error('throttle'), { code: 'ThrottlingException' }))
        : e.fake.client().update(p).promise()),
    });
    const claim = await guard.claim(SID);
    failing = true;
    jest.advanceTimersByTime(ACTIVE_RUN_HEARTBEAT_INTERVAL_MS);
    await flush();
    expect(e.log).toHaveBeenCalledWith(expect.stringContaining('heartbeat failed'), expect.objectContaining({ lostClaim: false }));
    expect(jest.getTimerCount()).toBe(1); // timer still alive
    failing = false;
    jest.advanceTimersByTime(ACTIVE_RUN_HEARTBEAT_INTERVAL_MS);
    await flush();
    expect(activeRunOf(e).heartbeatAt).toBe(Date.now());
    expect(claim.status).toBe('claimed');
  });

  it('a beat after another instance took over fails its runId condition, is logged as lost, and does not overwrite', async () => {
    const e = env();
    const a = await e.make('A').claim(SID);
    // A stalled for > 90s (GC pause / frozen VM) without its timer firing, then B legitimately took over.
    jest.setSystemTime(Date.now() + ACTIVE_RUN_STALE_AFTER_MS + 1);
    await e.make('B').claim(SID);
    const bRun = activeRunOf(e);
    jest.advanceTimersByTime(ACTIVE_RUN_HEARTBEAT_INTERVAL_MS);
    await flush();
    expect(activeRunOf(e).runId).toBe(bRun.runId);
    expect(e.log).toHaveBeenCalledWith(expect.stringContaining('heartbeat failed'), expect.objectContaining({ lostClaim: true }));
    expect(a.status).toBe('claimed');
  });

  it('beats do not overlap while one is still in flight', async () => {
    const e = env();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let beats = 0;
    const guard = e.make('A', {
      update: async (p: any) => {
        if (p.UpdateExpression.startsWith('SET activeRun.heartbeatAt')) { beats++; await gate; }
        return e.fake.client().update(p).promise();
      },
    });
    await guard.claim(SID);
    jest.advanceTimersByTime(ACTIVE_RUN_HEARTBEAT_INTERVAL_MS * 3);
    await flush();
    expect(beats).toBe(1);
    release();
    await flush();
  });
});

describe('release', () => {
  it('clears OUR activeRun and the timer, and is idempotent', async () => {
    const e = env();
    const claim = await e.make('A').claim(SID);
    if (claim.status !== 'claimed') throw new Error('expected claimed');
    await claim.release();
    expect(activeRunOf(e)).toBeUndefined();
    expect(jest.getTimerCount()).toBe(0);
    const writes = e.fake.writeLog.length;
    await claim.release();
    expect(e.fake.writeLog.length).toBe(writes);
    expect(e.fake.session(SID)).toMatchObject({ sessionId: SID, userId: 'u1' }); // item otherwise intact
  });

  it("A's release does NOT clear B's newer activeRun", async () => {
    const e = env();
    const a = await e.make('A').claim(SID);
    jest.setSystemTime(Date.now() + ACTIVE_RUN_STALE_AFTER_MS + 1); // A stalled; B took over
    await e.make('B').claim(SID);
    const bRun = activeRunOf(e);
    if (a.status !== 'claimed') throw new Error('expected claimed');
    await a.release();
    expect(activeRunOf(e)).toEqual(bRun);
    expect(jest.getTimerCount()).toBe(1); // only B's timer remains; A's is gone
  });

  it('a failed clear never throws and leaves a leftover that goes stale', async () => {
    const e = env();
    const guard = e.make('A', {
      update: (p: any) => (p.UpdateExpression === 'REMOVE activeRun'
        ? Promise.reject(new Error('network'))
        : e.fake.client().update(p).promise()),
    });
    const claim = await guard.claim(SID);
    if (claim.status !== 'claimed') throw new Error('expected claimed');
    await expect(claim.release()).resolves.toBeUndefined();
    expect(jest.getTimerCount()).toBe(0); // timer cleared regardless
    expect(e.log).toHaveBeenCalledWith(expect.stringContaining('clear failed'), expect.anything());
    jest.setSystemTime(Date.now() + ACTIVE_RUN_STALE_AFTER_MS + 1);
    expect((await e.make('B').claim(SID)).status).toBe('claimed');
  });

  it('the timer is unref()d so it cannot keep the process alive', async () => {
    const e = env();
    const unref = jest.fn();
    const guard = e.make('A', { setInterval: () => ({ unref } as any), clearInterval: jest.fn() });
    await guard.claim(SID);
    expect(unref).toHaveBeenCalledTimes(1);
  });
});

describe('hasLiveRunElsewhere', () => {
  it('true for a fresh run of another instance; false for stale, own, malformed, absent', async () => {
    const e = env();
    const b = e.make('B');
    const now = Date.now();
    const run = (over: object) => ({ runId: 'r', instanceId: 'A', startedAt: now, heartbeatAt: now, ...over });
    expect(await b.hasLiveRunElsewhere(run({}))).toBe(true);
    expect(await b.hasLiveRunElsewhere(run({ heartbeatAt: now - ACTIVE_RUN_STALE_AFTER_MS }))).toBe(true);
    expect(await b.hasLiveRunElsewhere(run({ heartbeatAt: now - ACTIVE_RUN_STALE_AFTER_MS - 1 }))).toBe(false);
    expect(await b.hasLiveRunElsewhere(run({ instanceId: 'B' }))).toBe(false);
    expect(await b.hasLiveRunElsewhere(run({ heartbeatAt: 'now' }))).toBe(false);
    expect(await b.hasLiveRunElsewhere(run({ heartbeatAt: NaN }))).toBe(false);
    expect(await b.hasLiveRunElsewhere(undefined)).toBe(false);
    expect(await b.hasLiveRunElsewhere(null)).toBe(false);
    expect(await b.hasLiveRunElsewhere('x')).toBe(false);
  });

  it('a stale heartbeat is never counted as live (isActiveRunFresh)', () => {
    const now = 1_000_000;
    expect(isActiveRunFresh({ heartbeatAt: now - ACTIVE_RUN_STALE_AFTER_MS }, now)).toBe(true);
    expect(isActiveRunFresh({ heartbeatAt: now - ACTIVE_RUN_STALE_AFTER_MS - 1 }, now)).toBe(false);
    expect(isActiveRunFresh({}, now)).toBe(false);
  });
});

describe('serialisation helpers', () => {
  const item = () => ({ sessionId: 's', activeRun: { runId: 'r', instanceId: 'i', startedAt: 1, heartbeatAt: 2 } });

  it('concealActiveRun hides it from JSON, spread and keys but keeps it readable', () => {
    const hidden = concealActiveRun(item());
    expect(hidden.activeRun.runId).toBe('r');
    expect(JSON.stringify(hidden)).not.toMatch(/runId|instanceId|activeRun/);
    expect(Object.keys(hidden)).toEqual(['sessionId']);
    expect({ ...hidden }).toEqual({ sessionId: 's' });
  });

  it('is a no-op for items without activeRun and for non-objects', () => {
    const plain = { sessionId: 's' };
    expect(concealActiveRun(plain)).toBe(plain);
    expect(Object.getOwnPropertyDescriptor(plain, 'activeRun')).toBeUndefined();
    expect(concealActiveRun(null)).toBeNull();
    expect(concealActiveRun(undefined)).toBeUndefined();
  });

  it('carryConcealedActiveRun re-hides it on a spread copy', () => {
    const hidden = concealActiveRun(item());
    const copy = carryConcealedActiveRun(hidden, { ...hidden, extra: 1 });
    expect(copy.activeRun.runId).toBe('r');
    expect(JSON.stringify(copy)).not.toMatch(/runId|activeRun/);
  });

  it('omitActiveRun strips it from one session and from { sessions: [] }', () => {
    expect(omitActiveRun(item())).toEqual({ sessionId: 's' });
    expect(omitActiveRun({ sessions: [item(), { sessionId: 'o' }], total: 2 })).toEqual({ sessions: [{ sessionId: 's' }, { sessionId: 'o' }], total: 2 });
    expect(omitActiveRun(null)).toBeNull();
  });
});
