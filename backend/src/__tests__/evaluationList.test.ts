// Human contract: the admin "Sandbox Accounts" list must show every provisioned sandbox
// principal without needing a CLI script, and one malformed/legacy row must never take the
// whole list down (this table's own history includes a pre-ENG-1906 legacy shape).
import { EvaluationStore } from '../services/evaluationStore';
import { SANDBOX_TOOL_CLASS_NAMES } from '../services/evaluationPolicy';

function fakeDb() {
  const items = new Map<string, Record<string, unknown>>();
  const scan = jest.fn((params: any) => ({ promise: async () => {
    const all = [...items.values()].filter((item) =>
      params.FilterExpression !== 'attribute_exists(email)' || item.email !== undefined);
    const startIndex = params.ExclusiveStartKey
      ? all.findIndex((item) => item.evaluationKey === params.ExclusiveStartKey.evaluationKey) + 1 : 0;
    const page = all.slice(startIndex, startIndex + 2); // force multi-page pagination in tests
    const last = startIndex + 2 < all.length ? page[page.length - 1] : undefined;
    return { Items: page, ...(last ? { LastEvaluatedKey: { evaluationKey: last.evaluationKey } } : {}) };
  } }));
  return { db: { scan } as any, items, scan };
}

describe('evaluationStore.listAll (admin Sandbox Accounts list)', () => {
  it('lists only root policy rows, never audit, dataset, or overlay rows', async () => {
    const { db, items } = fakeDb();
    items.set('evaluation/eval_a/audit/x', { evaluationKey: 'evaluation/eval_a/audit/x', userId: 'eval_a', email: 'a@example.invalid', action: 'provision' });
    items.set('evaluation/eval_a/sim', { evaluationKey: 'evaluation/eval_a/sim', userId: 'eval_a', revision: 3 });
    items.set('evaluation/eval_a', { evaluationKey: 'evaluation/eval_a', userId: 'eval_a', email: 'a@example.invalid', status: 'active', expiresAt: Date.now() + 60000 });
    items.set('evaluation/eval_b', { evaluationKey: 'evaluation/eval_b', userId: 'eval_b', email: 'b@example.invalid', status: 'active', expiresAt: Date.now() + 60000 });
    const rows = await new EvaluationStore(db).listAll();
    expect(rows.map(r => r.userId).sort()).toEqual(['eval_a', 'eval_b']);
  });

  it('sorts by email and normalizes every row the same way get() does', async () => {
    const { db, items } = fakeDb();
    items.set('evaluation/eval_z', { evaluationKey: 'evaluation/eval_z', userId: 'eval_z', email: 'zeta@example.invalid', status: 'active', expiresAt: 1, label: 'Zeta case', datasetId: 'case-z', datasetVersion: 2 });
    items.set('evaluation/eval_a', { evaluationKey: 'evaluation/eval_a', userId: 'eval_a', email: 'alpha@example.invalid', status: 'revoked', expiresAt: 2, deniedToolClasses: ['sends'] });
    const rows = await new EvaluationStore(db).listAll();
    expect(rows.map(r => r.email)).toEqual(['alpha@example.invalid', 'zeta@example.invalid']);
    expect(rows[1]).toMatchObject({ label: 'Zeta case', datasetId: 'case-z', datasetVersion: 2, connectors: { meta: 'simulated' } });
    expect(rows[0].deniedToolClasses).toEqual(['sends']);
  });

  it('skips a malformed or legacy-shaped row instead of throwing for the whole list', async () => {
    const { db, items } = fakeDb();
    items.set('evaluation/eval_good', { evaluationKey: 'evaluation/eval_good', userId: 'eval_good', email: 'good@example.invalid', status: 'active', expiresAt: 1 });
    // A row with an invalid lifecycleState — normalize() throws on this by design (get() would too).
    items.set('evaluation/eval_bad', { evaluationKey: 'evaluation/eval_bad', userId: 'eval_bad', email: 'bad@example.invalid', status: 'active', expiresAt: 1, lifecycleState: 'not-a-real-state' });
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const rows = await new EvaluationStore(db).listAll();
    expect(rows.map(r => r.userId)).toEqual(['eval_good']);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('eval_bad'), expect.anything());
    errorSpy.mockRestore();
  });

  it('skips a row with a non-string email instead of crashing the email sort for everyone', async () => {
    const { db, items } = fakeDb();
    items.set('evaluation/eval_good', { evaluationKey: 'evaluation/eval_good', userId: 'eval_good', email: 'good@example.invalid', status: 'active', expiresAt: 1 });
    // A row whose email is present (passes the DynamoDB filter) but not a string — normalize()
    // must reject this before listAll()'s final rows.sort(...localeCompare...), or one bad row
    // throws for the entire admin list instead of just being skipped.
    items.set('evaluation/eval_bad', { evaluationKey: 'evaluation/eval_bad', userId: 'eval_bad', email: 12345, status: 'active', expiresAt: 1 });
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const rows = await new EvaluationStore(db).listAll();
    expect(rows.map(r => r.userId)).toEqual(['eval_good']);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('eval_bad'));
    errorSpy.mockRestore();
  });

  it('paginates across multiple scan pages transparently', async () => {
    const { db, items, scan } = fakeDb();
    for (let i = 0; i < 5; i++) {
      items.set(`evaluation/eval_${i}`, { evaluationKey: `evaluation/eval_${i}`, userId: `eval_${i}`, email: `u${i}@example.invalid`, status: 'active', expiresAt: 1 });
    }
    const rows = await new EvaluationStore(db).listAll();
    expect(rows).toHaveLength(5);
    expect(scan.mock.calls.length).toBeGreaterThan(1);
  });

  it('returns an empty list rather than throwing when nothing is provisioned yet', async () => {
    const { db } = fakeDb();
    await expect(new EvaluationStore(db).listAll()).resolves.toEqual([]);
  });

  it('defaults a row with no persisted deniedToolClasses to every class denied, matching provision()', async () => {
    const { db, items } = fakeDb();
    items.set('evaluation/eval_a', { evaluationKey: 'evaluation/eval_a', userId: 'eval_a', email: 'a@example.invalid', status: 'active', expiresAt: 1 });
    const rows = await new EvaluationStore(db).listAll();
    expect(rows[0].deniedToolClasses).toEqual([...SANDBOX_TOOL_CLASS_NAMES]);
  });
});
