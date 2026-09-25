jest.mock('../../settingsService', () => ({
  settingsService: { getSetting: jest.fn().mockResolvedValue(null) },
}));

import {
  currentRunFunding,
  resolveRunFunding,
  withRunFunding,
  type RunFunding,
} from '../runFunding';

function funding(ownerUserId: string): RunFunding {
  return {
    route: 'agentweb',
    fallback: 'agentweb',
    ownerUserId,
    billingUserId: ownerUserId,
    resolvedAt: new Date().toISOString(),
  };
}

describe('RunFunding AsyncLocalStorage (ENG-1816 F1)', () => {
  it('is undefined outside any withRunFunding scope', () => {
    expect(currentRunFunding()).toBeUndefined();
  });

  it('is visible inside the scope it was entered with', async () => {
    await withRunFunding(funding('user-a'), async () => {
      expect(currentRunFunding()?.ownerUserId).toBe('user-a');
    });
  });

  it('is visible to a nested async call without being passed explicitly (the whole point of the ambient store)', async () => {
    async function nestedCallSite(): Promise<string | undefined> {
      // Simulate a tool-internal callLLM several awaits deep, with no funding parameter.
      await new Promise((resolve) => setImmediate(resolve));
      return currentRunFunding()?.ownerUserId;
    }

    const result = await withRunFunding(funding('user-b'), () => nestedCallSite());
    expect(result).toBe('user-b');
  });

  it('isolates two concurrent runs on the same process — this is the correctness requirement a module-level global would violate', async () => {
    async function simulateTurn(ownerUserId: string, delayMs: number): Promise<string | undefined> {
      return withRunFunding(funding(ownerUserId), async () => {
        // Interleave: both turns are "in flight" at once, racing on the same event loop,
        // the same way two customers' turns race inside the shared fork worker.
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        return currentRunFunding()?.ownerUserId;
      });
    }

    const [resultA, resultB] = await Promise.all([
      simulateTurn('customer-a', 15),
      simulateTurn('customer-b', 5),
    ]);

    expect(resultA).toBe('customer-a');
    expect(resultB).toBe('customer-b');
  });

  it('resolveRunFunding always resolves route=agentweb in F1 (no connection kind exists to route to yet)', async () => {
    const result = await resolveRunFunding({ userId: 'user-c' });
    expect(result.route).toBe('agentweb');
    expect(result.fallback).toBe('agentweb');
    expect(result.ownerUserId).toBe('user-c');
    expect(result.billingUserId).toBe('user-c');
  });
});
