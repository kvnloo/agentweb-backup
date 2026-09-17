import { getSandboxOverlayStore, SandboxOverlayMutationFailed } from '../../services/sandbox/sandboxOverlayStore';
import { EMPTY_OVERLAY, SandboxOverlay } from '../../services/sandbox/types';

/**
 * ENG-1909: one CAS item per sandbox principal at evaluation/<userId>/sim in AW-Evaluations,
 * same optimistic-concurrency shape as settingsService.ts's setSettingIfValueMatches (ENG-965).
 */
const USER = 'eval_0f1e2d3c-1111-4222-8333-444455556666';

function fakeDb() {
  const items = new Map<string, any>();
  items.set(`evaluation/${USER}`, { userId: USER, status: 'active', expiresAt: Date.now() + 3600000 });
  const put = jest.fn((params: any) => ({ promise: async () => {
    const current = items.get(params.Item.evaluationKey);
    if (params.ConditionExpression?.includes('revision = :expected')) {
      const expected = params.ExpressionAttributeValues[':expected'];
      if ((current && current.revision !== expected) || (!current && params.ConditionExpression === 'revision = :expected')) {
        throw Object.assign(new Error('The conditional request failed'), { code: 'ConditionalCheckFailedException' });
      }
    }
    if (params.ConditionExpression === 'attribute_not_exists(evaluationKey)' && current) {
      throw Object.assign(new Error('The conditional request failed'), { code: 'ConditionalCheckFailedException' });
    }
    items.set(params.Item.evaluationKey, params.Item);
    return {};
  } }));
  const get = jest.fn((params: any) => ({ promise: async () => ({ Item: items.get(params.Key.evaluationKey) }) }));
  const transactWrite = jest.fn((params: any) => ({ promise: async () => {
    const [guard, write] = params.TransactItems;
    const root = items.get(guard.ConditionCheck.Key.evaluationKey);
    if (!root || root.status !== 'active' || root.lifecycleState !== undefined) throw conflict('ConditionalCheckFailed', 'None');
    try { return await put(write.Put).promise(); } catch (error: any) {
      if (error.code === 'ConditionalCheckFailedException') throw conflict();
      throw error;
    }
  } }));
  return { db: { put, get, transactWrite } as any, items, put, get };
}

function conflict(root = 'None', overlay = 'ConditionalCheckFailed') {
  return Object.assign(new Error('conflict'), { code: 'TransactionCanceledException',
    CancellationReasons: [{ Code: root }, { Code: overlay }] });
}

describe('sandbox overlay store', () => {
  it('load returns EMPTY_OVERLAY when no row exists yet', async () => {
    const { db } = fakeDb();
    const store = getSandboxOverlayStore(db);
    await expect(store.load(USER)).resolves.toEqual(EMPTY_OVERLAY);
  });

  it('mutate on a fresh row writes revision 1 and the mutated content', async () => {
    const { db, items } = fakeDb();
    const store = getSandboxOverlayStore(db);
    const result = await store.mutate(USER, (current) => ({ ...current, campaigns: { c1: { id: 'c1' } as any } }));
    expect(result.revision).toBe(1);
    expect(result.campaigns).toEqual({ c1: { id: 'c1' } });
    expect(items.get(`evaluation/${USER}/sim`).revision).toBe(1);
  });

  it('mutate on an existing row increments revision and preserves untouched fields', async () => {
    const { db } = fakeDb();
    const store = getSandboxOverlayStore(db);
    await store.mutate(USER, (current) => ({ ...current, nextId: 5 }));
    const result = await store.mutate(USER, (current) => ({ ...current, campaigns: { c1: { id: 'c1' } as any } }));
    expect(result.revision).toBe(2);
    expect(result.nextId).toBe(5); // preserved from the first mutation
    expect(result.campaigns).toEqual({ c1: { id: 'c1' } });
  });

  it('a genuine CAS race retries from a fresh read and both mutations end up applied', async () => {
    const { db } = fakeDb();
    const store = getSandboxOverlayStore(db);
    // Simulate a race: the second mutate's transaction is made to fail exactly once (as if
    // another writer's put landed between this store's read and write), forcing a retry that
    // re-reads the row the first mutation already wrote.
    let putCalls = 0;
    const originalPut = db.transactWrite;
    (db as any).transactWrite = jest.fn((params: any) => {
      putCalls++;
      if (putCalls === 1) {
        // Let mutation A's put go through for real.
        return originalPut(params);
      }
      if (putCalls === 2) {
        // Mutation B's FIRST attempt: reject as if A's write landed first.
        return { promise: async () => { throw conflict(); } };
      }
      return originalPut(params);
    });
    const mutationA = store.mutate(USER, (current) => ({ ...current, campaigns: { a: { id: 'a' } as any } }));
    const resultA = await mutationA;
    expect(resultA.revision).toBe(1);
    const resultB = await store.mutate(USER, (current) => ({ ...current, adsets: { b: { id: 'b' } as any } }));
    // B's retry re-read A's committed state, so both mutations' effects are present.
    expect(resultB.campaigns).toEqual({ a: { id: 'a' } });
    expect(resultB.adsets).toEqual({ b: { id: 'b' } });
    expect(db.transactWrite).toHaveBeenCalledTimes(3);
    expect(resultB.revision).toBe(2); // A committed at revision 1; B's retry re-read that and committed at 2.
  });

  it('exhausting all retries throws SandboxOverlayMutationFailed', async () => {
    const { db } = fakeDb();
    (db as any).transactWrite = jest.fn(() => ({ promise: async () => { throw conflict(); } }));
    const store = getSandboxOverlayStore(db);
    await expect(store.mutate(USER, (current) => current)).rejects.toThrow(SandboxOverlayMutationFailed);
  });

  it('a non-conditional-check error propagates immediately, without retrying', async () => {
    const { db } = fakeDb();
    const put = jest.fn(() => ({ promise: async () => { throw new Error('DynamoDB is unavailable'); } }));
    (db as any).transactWrite = put;
    const store = getSandboxOverlayStore(db);
    await expect(store.mutate(USER, (current) => current)).rejects.toThrow('DynamoDB is unavailable');
    expect(put).toHaveBeenCalledTimes(1);
  });

  it('load normalizes a legacy row missing newer overlay fields onto EMPTY_OVERLAY (CodeRabbit)', async () => {
    const { db, items } = fakeDb();
    // A row written before `customAudiences` existed on SandboxOverlay — exactly what
    // happened to this store itself when that field was added mid-phase-3.
    items.set(`evaluation/${USER}/sim`, {
      evaluationKey: `evaluation/${USER}/sim`, userId: USER, revision: 3, nextId: 7,
      campaigns: { c1: { id: 'c1' } }, adsets: {}, ads: {}, adcreatives: {}, adimages: {},
      deletedIds: [], reviewUntil: {}, capiEvents: [],
      // customAudiences deliberately absent
    });
    const store = getSandboxOverlayStore(db);
    const overlay = await store.load(USER);
    expect(overlay.customAudiences).toEqual({});
    expect(overlay.campaigns).toEqual({ c1: { id: 'c1' } }); // real fields still come through
    expect(overlay.revision).toBe(3);
  });

  it('an audit append failure does not fail the overlay mutation itself', async () => {
    const { db, items } = fakeDb();
    let putCalls = 0;
    const originalPut = db.put;
    (db as any).put = jest.fn((params: any) => {
      putCalls++;
      if (putCalls === 1) return { promise: async () => { throw new Error('audit table unavailable'); } }; // the audit put
      return originalPut(params);
    });
    const store = getSandboxOverlayStore(db);
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const result = await store.mutate(USER, (current) => ({ ...current, nextId: 9 }), { action: 'sandbox.create' });
    expect(result.nextId).toBe(9);
    expect(items.get(`evaluation/${USER}/sim`).nextId).toBe(9);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

it('a lifecycle denial is not retried as overlay contention', async () => {
  const { db } = fakeDb();
  db.transactWrite.mockImplementation(() => ({ promise: async () => { throw conflict('ConditionalCheckFailed', 'None'); } }));
  await expect(getSandboxOverlayStore(db).mutate(USER, current => current)).rejects.toThrow('Evaluation access denied');
  expect(db.transactWrite).toHaveBeenCalledTimes(1);
});

it('a reset deleting an existing overlay cannot accept its stale revision', async () => {
  const { db, items } = fakeDb();
  const store = getSandboxOverlayStore(db);
  await store.mutate(USER, current => ({ ...current, nextId: 20 }));
  const inputs: number[] = [];
  const result = await store.mutate(USER, current => {
    inputs.push(current.nextId);
    if (inputs.length === 1) items.delete(`evaluation/${USER}/sim`);
    return { ...current, nextId: current.nextId + 1 };
  });
  expect(inputs).toEqual([20, EMPTY_OVERLAY.nextId]);
  expect(result.nextId).toBe(EMPTY_OVERLAY.nextId + 1);
  expect(result.revision).toBe(1);
});

it('transaction infrastructure errors do not become retryable CAS failures', async () => {
  const { db } = fakeDb();
  db.transactWrite.mockImplementation(() => ({ promise: async () => { throw conflict('None', 'ValidationError'); } }));
  await expect(getSandboxOverlayStore(db).mutate(USER, current => current)).rejects.toMatchObject({ code: 'TransactionCanceledException' });
  expect(db.transactWrite).toHaveBeenCalledTimes(1);
});
