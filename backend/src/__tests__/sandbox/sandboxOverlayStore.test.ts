import { getSandboxOverlayStore, SandboxOverlayMutationFailed } from '../../services/sandbox/sandboxOverlayStore';
import { EMPTY_OVERLAY, SandboxOverlay } from '../../services/sandbox/types';

/**
 * ENG-1909: one CAS item per sandbox principal at evaluation/<userId>/sim in AW-Evaluations,
 * same optimistic-concurrency shape as settingsService.ts's setSettingIfValueMatches (ENG-965).
 */
const USER = 'eval_0f1e2d3c-1111-4222-8333-444455556666';

function fakeDb() {
  const items = new Map<string, any>();
  const put = jest.fn((params: any) => ({ promise: async () => {
    const current = items.get(params.Item.evaluationKey);
    if (params.ConditionExpression === 'attribute_not_exists(evaluationKey) OR revision = :expected') {
      const expected = params.ExpressionAttributeValues[':expected'];
      if (current && current.revision !== expected) {
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
  return { db: { put, get } as any, items, put, get };
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
    // Simulate a race: the second mutate's `put` call is made to fail exactly once (as if
    // another writer's put landed between this store's read and write), forcing a retry that
    // re-reads the row the first mutation already wrote.
    let putCalls = 0;
    const originalPut = db.put;
    (db as any).put = jest.fn((params: any) => {
      putCalls++;
      if (putCalls === 1) {
        // Let mutation A's put go through for real.
        return originalPut(params);
      }
      if (putCalls === 2) {
        // Mutation B's FIRST attempt: reject as if A's write landed first.
        return { promise: async () => { throw Object.assign(new Error('conflict'), { code: 'ConditionalCheckFailedException' }); } };
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
    expect(resultB.revision).toBe(2); // A committed at revision 1; B's retry re-read that and committed at 2.
  });

  it('exhausting all retries throws SandboxOverlayMutationFailed', async () => {
    const { db } = fakeDb();
    (db as any).put = jest.fn(() => ({ promise: async () => { throw Object.assign(new Error('conflict'), { code: 'ConditionalCheckFailedException' }); } }));
    const store = getSandboxOverlayStore(db);
    await expect(store.mutate(USER, (current) => current)).rejects.toThrow(SandboxOverlayMutationFailed);
  });

  it('a non-conditional-check error propagates immediately, without retrying', async () => {
    const { db } = fakeDb();
    const put = jest.fn(() => ({ promise: async () => { throw new Error('DynamoDB is unavailable'); } }));
    (db as any).put = put;
    const store = getSandboxOverlayStore(db);
    await expect(store.mutate(USER, (current) => current)).rejects.toThrow('DynamoDB is unavailable');
    expect(put).toHaveBeenCalledTimes(1);
  });

  it('an audit append failure does not fail the overlay mutation itself', async () => {
    const { db, items } = fakeDb();
    let putCalls = 0;
    const originalPut = db.put;
    (db as any).put = jest.fn((params: any) => {
      putCalls++;
      if (putCalls === 2) return { promise: async () => { throw new Error('audit table unavailable'); } }; // the audit put
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
