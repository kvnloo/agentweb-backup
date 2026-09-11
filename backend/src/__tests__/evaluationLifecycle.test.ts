// Human contract: isolated provision, bounded spend, approved-only material, full revoke.
import { EvaluationStore } from '../services/evaluationStore';

describe('ENG-1870 evaluation lifecycle persistence invariants', () => {
  const transactWrite = jest.fn((_request: any) => ({ promise: async () => ({}) }));
  const get = jest.fn();
  const scan = jest.fn((_request: any) => ({ promise: async () => ({ Items: [] as any[], LastEvaluatedKey: undefined as any }) }));
  const update = jest.fn((_request: any) => ({ promise: async () => ({}) }));
  const remove = jest.fn((_request: any) => ({ promise: async () => ({}) }));
  const store = new EvaluationStore({ transactWrite, get, scan, update, delete: remove } as any);
  const request = { email: 'candidate@example.invalid', displayName: 'Test candidate', password: 'Synthetic-password-123!', generationBudget: 5, expiresAt: Date.now() + 3600000, materials: [{ title: 'Sanitized case', text: 'Synthetic metrics only', approved: true as const }] };
  beforeEach(() => { jest.clearAllMocks(); });

  it('creates a Pro account and evaluation atomically without inheriting any organization', async () => {
    const result = await store.provision('admin', request);
    expect(result.userId).toMatch(/^eval_/);
    expect(result.audit).toMatchObject({ actor: 'admin', action: 'provision' });
    const writes = transactWrite.mock.calls[0][0].TransactItems;
    const user = writes.find((w: any) => w.Put?.TableName.endsWith('AW-Users')).Put;
    expect(user.Item).toMatchObject({ isAdmin: false, subscriptionType: 'Pro', roles: ['customer'] });
    expect(user.Item.orgId).toBeUndefined();
    expect(user.Item.password).not.toBe(request.password);
    expect(user.ConditionExpression).toContain('attribute_not_exists');
    expect(writes.filter((w: any) => w.Put?.TableName !== 'AW-Users').every((w: any) => w.Put.TableName === 'AW-Evaluations')).toBe(true);
    expect(writes.some((w: any) => w.Put?.Item.action === 'provision')).toBe(true);
  });

  it.each([null, {}, [{ title: 'Case', text: 'unsafe', approved: false }], ['wrong-type']])('rejects malformed or unapproved material %p before persisting', async materials => {
    await expect(store.provision('admin', { ...request, materials } as any)).rejects.toThrow();
    expect(transactWrite).not.toHaveBeenCalled();
  });

  it.each([0, -1, NaN, Infinity, 1.5])('rejects unbounded/invalid generation budget %p', async generationBudget => {
    await expect(store.provision('admin', { ...request, generationBudget })).rejects.toThrow();
    expect(transactWrite).not.toHaveBeenCalled();
  });

  it('uses a strongly consistent primary-key read for access decisions', async () => {
    get.mockReturnValue({ promise: async () => ({ Item: { userId: 'eval_test', status: 'revoked' } }) });
    expect(await store.get('eval_test')).toMatchObject({ status: 'revoked' });
    expect(get).toHaveBeenCalledWith(expect.objectContaining({ ConsistentRead: true, Key: { evaluationKey: 'evaluation/eval_test' } }));
  });

  it('reserves generation budget atomically against live, unexpired state', async () => {
    await store.reserve('eval_test');
    const update = transactWrite.mock.calls[0][0].TransactItems[0].Update;
    expect(update.ConditionExpression).toContain('remaining > :zero');
    expect(update.ConditionExpression).toContain('#status = :active');
    expect(update.ConditionExpression).toContain('expiresAt > :now');
  });

  it('revocation atomically records an audit event and disables the account', async () => {
    get.mockReturnValue({ promise: async () => ({ Item: { userId: 'eval_test', email: request.email, status: 'active' } }) });
    const result = await store.revoke('admin', 'eval_test');
    expect(result.audit).toMatchObject({ actor: 'admin', action: 'revoke' });
    const writes = transactWrite.mock.calls[0][0].TransactItems;
    expect(writes.some((w: any) => w.Update?.ExpressionAttributeValues?.[':revoked'] === 'revoked')).toBe(true);
    expect(writes.some((w: any) => w.Update?.ExpressionAttributeValues?.[':inactive'] === false)).toBe(true);
    expect(writes.some((w: any) => w.Put?.Item.action === 'revoke')).toBe(true);
  });
  it('revocation invalidates stored keys, OAuth grants, MCP sessions, and jobs with strongly consistent pagination', async () => {
    get.mockReturnValue({ promise: async () => ({ Item: { userId: 'eval_test', email: request.email, status: 'active' } }) });
    scan.mockImplementation((params: any) => ({ promise: async () => ({
      Items: params.TableName.endsWith('AW-AgentApiKeys') ? [{ userId: 'eval_test', keyId: params.ExclusiveStartKey ? 'second' : 'first' }] : [],
      LastEvaluatedKey: params.TableName.endsWith('AW-AgentApiKeys') && !params.ExclusiveStartKey ? { keyId: 'first' } : undefined,
    }) }));
    const result = await store.revoke('admin', 'eval_test');
    expect(result.cleanup['AW-AgentApiKeys']).toBe(2);
    expect(scan.mock.calls.every(([params]) => params.ConsistentRead === true)).toBe(true);
    expect(scan.mock.calls.map(([params]) => params.TableName)).toEqual(expect.arrayContaining(['AW-MCPOAuthTokens', 'AW-MCPOAuthCodes', 'AW-MCPSessions', 'AW-TaskSchedules']));
    expect(remove).toHaveBeenCalledTimes(2);
    expect(remove.mock.calls.every(([params]) => params.ExpressionAttributeValues[':user'] === 'eval_test')).toBe(true);
  });

  it('does not report a credential as deleted when the ownership condition loses a race', async () => {
    get.mockReturnValue({ promise: async () => ({ Item: { userId: 'eval_test', email: request.email, status: 'active' } }) });
    scan.mockImplementation((params: any) => ({ promise: async () => ({
      Items: params.TableName.endsWith('AW-AgentApiKeys') ? [{ userId: 'eval_test', keyId: 'raced' }] : [],
      LastEvaluatedKey: undefined,
    }) }));
    remove.mockReturnValueOnce({
      promise: async () => { throw Object.assign(new Error('ownership changed'), { code: 'ConditionalCheckFailedException' }); },
    });

    const result = await store.revoke('admin', 'eval_test');

    expect(result.cleanup['AW-AgentApiKeys']).toBe(0);
  });
});
