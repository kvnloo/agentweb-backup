/**
 * ENG-764: the ASG termination guard holds an instance in `Terminating:Wait`
 * until in-flight scheduled runs have drained, then releases it.
 *
 * A false positive here would drain a HEALTHY single-instance production
 * environment, so the negative cases (off-ASG, transient IMDS blips, a single
 * unconfirmed read) matter more than the happy path.
 */

import {
  startAsgTerminationGuard,
  readTargetLifecycleState,
  TERMINATION_LIFECYCLE_HOOK_NAME,
  CONFIRMING_READS_REQUIRED,
} from '../services/asgLifecycleGuard';

const STATE_PATH = '/latest/meta-data/autoscaling/target-lifecycle-state';
const TOKEN_PATH = '/latest/api/token';
const INSTANCE_ID_PATH = '/latest/meta-data/instance-id';

type StateReply = { status: number; body: string } | 'throw';

/**
 * Build a fake IMDS. `stateReplies` is consumed one per lifecycle-state read;
 * the last entry repeats once exhausted.
 */
function makeFetch(opts: {
  token?: string | null;
  stateReplies: StateReply[];
  instanceId?: string;
}) {
  const stateReplies = [...opts.stateReplies];
  const fetchImpl = jest.fn(async (url: string) => {
    const path = String(url).replace('http://169.254.169.254', '');

    if (path === TOKEN_PATH) {
      if (opts.token === null) return { ok: false, status: 500, text: async () => '' } as any;
      return { ok: true, status: 200, text: async () => opts.token ?? 'tok-1' } as any;
    }
    if (path === STATE_PATH) {
      const reply = stateReplies.length > 1 ? stateReplies.shift()! : stateReplies[0];
      if (reply === 'throw') throw new Error('IMDS blip');
      return { ok: reply.status === 200, status: reply.status, text: async () => reply.body } as any;
    }
    if (path === INSTANCE_ID_PATH) {
      return { ok: true, status: 200, text: async () => opts.instanceId ?? 'i-abc' } as any;
    }
    throw new Error(`unexpected IMDS path ${path}`);
  });
  return fetchImpl as unknown as typeof fetch;
}

/** Replaces setInterval so the test drives ticks by hand. */
function makeClock() {
  let tick: (() => Promise<void>) | null = null;
  let cleared = false;
  const setIntervalImpl = ((fn: any) => {
    tick = fn;
    return { unref: jest.fn() } as any;
  }) as unknown as typeof setInterval;
  const clearIntervalImpl = (() => {
    cleared = true;
  }) as unknown as typeof clearInterval;
  return {
    setIntervalImpl,
    clearIntervalImpl,
    isCleared: () => cleared,
    async advance(times = 1) {
      for (let i = 0; i < times; i++) {
        if (!tick) throw new Error('guard never registered an interval');
        await tick();
      }
    },
  };
}

const silentLogger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };

beforeEach(() => jest.clearAllMocks());

describe('readTargetLifecycleState', () => {
  it('reports unavailable when the instance is not in an ASG (IMDS 404)', async () => {
    const fetchImpl = makeFetch({ stateReplies: [{ status: 404, body: 'Not Found' }] });

    await expect(readTargetLifecycleState(fetchImpl)).resolves.toEqual({
      state: null,
      unavailable: true,
    });
  });

  it('reports unavailable when IMDS will not issue a token', async () => {
    const fetchImpl = makeFetch({ token: null, stateReplies: [{ status: 200, body: 'InService' }] });

    await expect(readTargetLifecycleState(fetchImpl)).resolves.toEqual({
      state: null,
      unavailable: true,
    });
  });

  it('does NOT report unavailable for a transient read error', async () => {
    const fetchImpl = makeFetch({ stateReplies: ['throw'] });

    // unavailable=false keeps the guard alive to retry on the next tick.
    await expect(readTargetLifecycleState(fetchImpl)).resolves.toEqual({
      state: null,
      unavailable: false,
    });
  });

  it('returns the trimmed state for an ASG instance', async () => {
    const fetchImpl = makeFetch({ stateReplies: [{ status: 200, body: 'InService\n' }] });

    await expect(readTargetLifecycleState(fetchImpl)).resolves.toEqual({
      state: 'InService',
      unavailable: false,
    });
  });
});

describe('startAsgTerminationGuard', () => {
  function lifecycleActionNotReady(): Error & { code: string } {
    return Object.assign(
      new Error('No active Lifecycle Action found with instance ID i-dead'),
      { code: 'ValidationError' }
    );
  }

  it('disables itself permanently off-ASG and never drains', async () => {
    const clock = makeClock();
    const onTerminating = jest.fn(async () => {});
    const completeAction = jest.fn(async () => {});

    startAsgTerminationGuard(onTerminating, {
      fetchImpl: makeFetch({ stateReplies: [{ status: 404, body: '' }] }),
      completeAction,
      logger: silentLogger,
      ...clock,
    });
    await clock.advance(3);

    expect(onTerminating).not.toHaveBeenCalled();
    expect(completeAction).not.toHaveBeenCalled();
    expect(clock.isCleared()).toBe(true);
  });

  it('does not drain a healthy in-service instance', async () => {
    const clock = makeClock();
    const onTerminating = jest.fn(async () => {});

    startAsgTerminationGuard(onTerminating, {
      fetchImpl: makeFetch({ stateReplies: [{ status: 200, body: 'InService' }] }),
      completeAction: jest.fn(async () => {}),
      logger: silentLogger,
      ...clock,
    });
    await clock.advance(5);

    expect(onTerminating).not.toHaveBeenCalled();
    expect(clock.isCleared()).toBe(false);
  });

  it('does not drain on a SINGLE unconfirmed Terminated read', async () => {
    const clock = makeClock();
    const onTerminating = jest.fn(async () => {});

    startAsgTerminationGuard(onTerminating, {
      fetchImpl: makeFetch({ stateReplies: [{ status: 200, body: 'Terminated' }] }),
      completeAction: jest.fn(async () => {}),
      logger: silentLogger,
      ...clock,
    });

    // Hardcoded 1 tick, NOT derived from the constant — otherwise lowering
    // CONFIRMING_READS_REQUIRED to 1 would silently keep this test green.
    await clock.advance(1);
    expect(onTerminating).not.toHaveBeenCalled();
    expect(CONFIRMING_READS_REQUIRED).toBeGreaterThanOrEqual(2);

    await clock.advance(1);
    expect(onTerminating).toHaveBeenCalledTimes(1);
  });

  it('resets the confirmation streak when the state flaps back to InService', async () => {
    const clock = makeClock();
    const onTerminating = jest.fn(async () => {});

    startAsgTerminationGuard(onTerminating, {
      fetchImpl: makeFetch({
        stateReplies: [
          { status: 200, body: 'Terminated' },
          { status: 200, body: 'InService' },
          { status: 200, body: 'Terminated' },
          { status: 200, body: 'InService' },
        ],
      }),
      completeAction: jest.fn(async () => {}),
      logger: silentLogger,
      ...clock,
    });
    await clock.advance(4);

    // Never two Terminated in a row → never drained.
    expect(onTerminating).not.toHaveBeenCalled();
  });

  it('drains then releases the instance with the pinned hook name', async () => {
    const clock = makeClock();
    const order: string[] = [];
    const onTerminating = jest.fn(async () => {
      order.push('drain');
    });
    const completeAction = jest.fn(async () => {
      order.push('complete');
    });

    startAsgTerminationGuard(onTerminating, {
      fetchImpl: makeFetch({ stateReplies: [{ status: 200, body: 'Terminated' }], instanceId: 'i-dead' }),
      completeAction,
      logger: silentLogger,
      ...clock,
    });
    await clock.advance(CONFIRMING_READS_REQUIRED);

    // Drain must complete BEFORE the instance is released.
    expect(order).toEqual(['drain', 'complete']);
    expect(completeAction).toHaveBeenCalledWith('i-dead');
    expect(clock.isCleared()).toBe(true);
    expect(TERMINATION_LIFECYCLE_HOOK_NAME).toBe('agentweb-drain-before-terminate');
  });

  it('fires only once even if further ticks land', async () => {
    const clock = makeClock();
    const onTerminating = jest.fn(async () => {});

    startAsgTerminationGuard(onTerminating, {
      fetchImpl: makeFetch({ stateReplies: [{ status: 200, body: 'Terminated' }] }),
      completeAction: jest.fn(async () => {}),
      logger: silentLogger,
      ...clock,
    });
    await clock.advance(CONFIRMING_READS_REQUIRED + 3);

    expect(onTerminating).toHaveBeenCalledTimes(1);
  });

  it('still releases the instance when the drain itself throws', async () => {
    const clock = makeClock();
    const completeAction = jest.fn(async () => {});

    startAsgTerminationGuard(
      jest.fn(async () => {
        throw new Error('drain exploded');
      }),
      {
        fetchImpl: makeFetch({ stateReplies: [{ status: 200, body: 'Terminated' }] }),
        completeAction,
        logger: silentLogger,
        ...clock,
      }
    );
    await clock.advance(CONFIRMING_READS_REQUIRED);

    // A broken drain must not strand the instance in Terminating:Wait.
    expect(completeAction).toHaveBeenCalledTimes(1);
  });

  it('swallows a CompleteLifecycleAction failure (the hook times out to CONTINUE)', async () => {
    const clock = makeClock();
    const onTerminating = jest.fn(async () => {});

    startAsgTerminationGuard(onTerminating, {
      fetchImpl: makeFetch({ stateReplies: [{ status: 200, body: 'Terminated' }] }),
      completeAction: jest.fn(async () => {
        throw new Error('AccessDenied: autoscaling:CompleteLifecycleAction');
      }),
      logger: silentLogger,
      ...clock,
    });

    // Must not reject — an unhandled rejection here would crash the dying instance
    // before its drain could be reported.
    await expect(clock.advance(CONFIRMING_READS_REQUIRED)).resolves.toBeUndefined();
    expect(onTerminating).toHaveBeenCalledTimes(1);
  });

  it('retries the exact AWS lifecycle-action propagation race until completion succeeds', async () => {
    const clock = makeClock();
    const sleepImpl = jest.fn(async () => {});
    const completeAction = jest
      .fn<Promise<void>, [string]>()
      .mockRejectedValueOnce(lifecycleActionNotReady())
      .mockRejectedValueOnce(lifecycleActionNotReady())
      .mockResolvedValue(undefined);
    const deps: any = {
      fetchImpl: makeFetch({
        stateReplies: [{ status: 200, body: 'Terminated' }],
        instanceId: 'i-dead',
      }),
      completeAction,
      sleepImpl,
      logger: silentLogger,
      ...clock,
    };

    startAsgTerminationGuard(jest.fn(async () => {}), deps);
    await clock.advance(CONFIRMING_READS_REQUIRED);

    expect(completeAction).toHaveBeenCalledTimes(3);
    expect(sleepImpl).toHaveBeenCalledTimes(2);
  });

  it('bounds lifecycle-action propagation retries to fifteen attempts', async () => {
    const clock = makeClock();
    const sleepImpl = jest.fn(async () => {});
    const completeAction = jest.fn(async () => {
      throw lifecycleActionNotReady();
    });
    const deps: any = {
      fetchImpl: makeFetch({
        stateReplies: [{ status: 200, body: 'Terminated' }],
        instanceId: 'i-dead',
      }),
      completeAction,
      sleepImpl,
      logger: silentLogger,
      ...clock,
    };

    startAsgTerminationGuard(jest.fn(async () => {}), deps);
    await expect(clock.advance(CONFIRMING_READS_REQUIRED)).resolves.toBeUndefined();

    // This is a behavioral ceiling, intentionally not derived from production constants.
    expect(completeAction).toHaveBeenCalledTimes(15);
    expect(sleepImpl).toHaveBeenCalledTimes(14);
    expect(silentLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('the hook will time out'),
      expect.objectContaining({ code: 'ValidationError' })
    );
  });

  it('records lifecycle propagation retries before the eventual successful release', async () => {
    const clock = makeClock();
    const completeAction = jest
      .fn<Promise<void>, [string]>()
      .mockRejectedValueOnce(lifecycleActionNotReady())
      .mockResolvedValue(undefined);
    const deps: any = {
      fetchImpl: makeFetch({
        stateReplies: [{ status: 200, body: 'Terminated' }],
        instanceId: 'i-dead',
      }),
      completeAction,
      sleepImpl: jest.fn(async () => {}),
      logger: silentLogger,
      ...clock,
    };

    startAsgTerminationGuard(jest.fn(async () => {}), deps);
    await clock.advance(CONFIRMING_READS_REQUIRED);

    expect(silentLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('lifecycle action is not active yet')
    );
    expect(silentLogger.log).toHaveBeenCalledWith(
      expect.stringContaining('lifecycle action completed')
    );
  });

  it('does not retry a non-propagation completion error', async () => {
    const clock = makeClock();
    const sleepImpl = jest.fn(async () => {});
    const completeAction = jest.fn(async () => {
      throw Object.assign(new Error('not authorized'), { code: 'AccessDenied' });
    });
    const deps: any = {
      fetchImpl: makeFetch({
        stateReplies: [{ status: 200, body: 'Terminated' }],
        instanceId: 'i-dead',
      }),
      completeAction,
      sleepImpl,
      logger: silentLogger,
      ...clock,
    };

    startAsgTerminationGuard(jest.fn(async () => {}), deps);
    await expect(clock.advance(CONFIRMING_READS_REQUIRED)).resolves.toBeUndefined();

    expect(completeAction).toHaveBeenCalledTimes(1);
    expect(sleepImpl).not.toHaveBeenCalled();
    expect(silentLogger.error).toHaveBeenCalledTimes(1);
  });

  it('survives a transient IMDS error without disabling or draining', async () => {
    const clock = makeClock();
    const onTerminating = jest.fn(async () => {});

    startAsgTerminationGuard(onTerminating, {
      fetchImpl: makeFetch({ stateReplies: ['throw', { status: 200, body: 'InService' }] }),
      completeAction: jest.fn(async () => {}),
      logger: silentLogger,
      ...clock,
    });
    await clock.advance(3);

    expect(onTerminating).not.toHaveBeenCalled();
    expect(clock.isCleared()).toBe(false);
  });
});
