// Human contract (ENG-1907 AC 4/5, ENG-1870 AC 1/2/7): tier-gated isolated provision, no production Meta path, full revoke.
import { EvaluationStore, SandboxTierMissing } from '../services/evaluationStore';
import { SANDBOX_TOOL_CLASS_NAMES } from '../services/evaluationPolicy';
import { getSubscriptionTypeConfig } from '../services/subscriptionService';

jest.mock('../services/subscriptionService', () => ({ getSubscriptionTypeConfig: jest.fn() }));

describe('ENG-1907 sandbox lifecycle persistence invariants', () => {
  const transactWrite = jest.fn((_request: any) => ({ promise: async () => ({}) }));
  const get = jest.fn();
  const scan = jest.fn((_request: any) => ({ promise: async () => ({ Items: [] as any[], LastEvaluatedKey: undefined as any }) }));
  const update = jest.fn((_request: any) => ({ promise: async () => ({}) }));
  const remove = jest.fn((_request: any) => ({ promise: async () => ({}) }));
  const store = new EvaluationStore({ transactWrite, get, scan, update, delete: remove } as any);
  const request = { email: 'Candidate@Example.invalid', displayName: 'Test candidate', password: 'Synthetic-password-123!', expiresAt: Date.now() + 3600000, brandGuidelines: { brandName: 'Synthetic Co', website: 'https://synthetic.invalid', description: 'A synthetic case' } };
  const userPut = () => transactWrite.mock.calls[0][0].TransactItems.find((w: any) => w.Put?.TableName.endsWith('AW-Users')).Put;
  const policyPut = () => transactWrite.mock.calls[0][0].TransactItems.find((w: any) => w.Put?.Item?.evaluationKey?.startsWith('evaluation/eval_') && w.Put?.Item?.mode).Put;
  beforeEach(() => {
    jest.clearAllMocks();
    (getSubscriptionTypeConfig as jest.Mock).mockResolvedValue({ name: 'Sandbox', allowedPages: ['*'], allowedSkills: ['*'] });
  });

  it('refuses to provision when the Sandbox tier row does not exist (AC 4)', async () => {
    (getSubscriptionTypeConfig as jest.Mock).mockResolvedValue(null);
    await expect(store.provision('admin', request)).rejects.toBeInstanceOf(SandboxTierMissing);
    await expect(store.provision('admin', request)).rejects.toThrow('ensure-sandbox-tier');
    expect(getSubscriptionTypeConfig).toHaveBeenCalledWith('Sandbox');
    expect(transactWrite).not.toHaveBeenCalled();
  });

  it('creates a Sandbox-tier account and policy atomically without inheriting any organization', async () => {
    const result = await store.provision('admin', request);
    expect(result.userId).toMatch(/^eval_/);
    expect(result.audit).toMatchObject({ actor: 'admin', action: 'provision' });
    const user = userPut();
    expect(user.Item).toMatchObject({ isAdmin: false, isActive: true, subscriptionType: 'Sandbox', roles: ['customer'], email: 'candidate@example.invalid', signupSource: 'evaluation' });
    expect(user.Item.orgId).toBeUndefined();
    expect(user.Item.password).not.toBe(request.password);
    expect(user.ConditionExpression).toContain('attribute_not_exists');
    const writes = transactWrite.mock.calls[0][0].TransactItems;
    expect(writes.filter((w: any) => w.Put?.TableName !== 'AW-Users').every((w: any) => w.Put.TableName === 'AW-Evaluations')).toBe(true);
    expect(writes.some((w: any) => w.Put?.Item.action === 'provision')).toBe(true);
  });

  it('seeds brand guidelines so the portal never routes the account into onboarding', async () => {
    await store.provision('admin', request);
    const brand = userPut().Item.brandGuidelines;
    expect(brand.brandData.brandName).toBe('Synthetic Co');
    expect(brand.brandData.domain).toBe('https://synthetic.invalid');
    expect(brand.brandData.tagline).toBe('A synthetic case');
    expect(Array.isArray(brand.brandData.keyMessages)).toBe(true);
    expect(Array.isArray(brand.attachments)).toBe(true);
    expect(typeof brand.updatedAt).toBe('string');
  });

  it('never writes the legacy adAccount field (the shared-production-token path)', async () => {
    await store.provision('admin', { ...request, adAccount: '123456789' } as any);
    expect(Object.keys(userPut().Item)).not.toContain('adAccount');
    expect(userPut().Item.connected_accounts).toBeUndefined();
  });

  it('writes the sandbox policy record with simulated Meta and every tool class denied by default', async () => {
    await store.provision('admin', request);
    expect(policyPut().Item).toMatchObject({ mode: 'sandbox', label: 'Sandbox', status: 'active', connectors: { meta: 'simulated' }, provisionedBy: 'admin', reviewerUserIds: [] });
    expect(policyPut().Item.deniedToolClasses).toEqual(SANDBOX_TOOL_CLASS_NAMES);
    expect(policyPut().ConditionExpression).toContain('attribute_not_exists');
  });

  it('honors an explicit subset of denied classes, label, and dataset pin, but always keeps lifecycle denied', async () => {
    await store.provision('admin', { ...request, label: 'Practice account', datasetId: 'agentweb-2026q2', datasetVersion: 1, deniedToolClasses: ['sends'], reviewerUserIds: ['reviewer-1'] });
    expect(policyPut().Item).toMatchObject({ label: 'Practice account', datasetId: 'agentweb-2026q2', datasetVersion: 1, reviewerUserIds: ['reviewer-1'] });
    expect(policyPut().Item.deniedToolClasses).toEqual(['sends', 'lifecycle']);
  });

  it.each([
    { brandGuidelines: undefined }, { brandGuidelines: { brandName: '' } }, { brandGuidelines: { brandName: 'x'.repeat(101) } },
    { password: 'short' }, { expiresAt: Date.now() - 1 }, { expiresAt: Date.now() + 31 * 86400000 }, { email: 'not-an-email' },
    { deniedToolClasses: ['not_a_class'] }, { deniedToolClasses: 'sends' }, { datasetVersion: -1 }, { reviewerUserIds: ['bad id'] }, { label: 'x'.repeat(41) },
  ])('rejects malformed provisioning input %p before persisting', async override => {
    await expect(store.provision('admin', { ...request, ...override } as any)).rejects.toThrow();
    expect(transactWrite).not.toHaveBeenCalled();
  });

  it('uses a strongly consistent primary-key read for access decisions', async () => {
    get.mockReturnValue({ promise: async () => ({ Item: { userId: 'eval_test', status: 'revoked' } }) });
    expect(await store.get('eval_test')).toMatchObject({ status: 'revoked' });
    expect(get).toHaveBeenCalledWith(expect.objectContaining({ ConsistentRead: true, Key: { evaluationKey: 'evaluation/eval_test' } }));
  });

  it('tolerates a legacy ENG-1870 policy row (materials, budget, artifacts, toy simulation) and normalizes it', async () => {
    get.mockReturnValue({ promise: async () => ({ Item: {
      evaluationKey: 'evaluation/eval_test', userId: 'eval_test', email: 'ryan@example.invalid', status: 'active', expiresAt: Date.now() + 60000,
      remaining: 100, materials: [{ title: 'Case', text: 'x', approved: true }], simulation: { seed: [{ id: 'sim_eval_test_seed_a' }], objects: [] },
      simulationRevision: 3, artifactEpoch: 1, resetArtifacts: ['old'], artifacts: [{ artifactId: 'a', mime: 'text/plain' }], provisionedBy: 'admin', reviewerUserIds: ['matt'],
    } }) });
    const record = await store.get('eval_test');
    expect(record).toMatchObject({ userId: 'eval_test', status: 'active', mode: 'sandbox', label: 'Sandbox', connectors: { meta: 'simulated' }, provisionedBy: 'admin', reviewerUserIds: ['matt'] });
    expect(record!.deniedToolClasses).toEqual(SANDBOX_TOOL_CLASS_NAMES);
    for (const legacy of ['remaining', 'materials', 'simulation', 'simulationRevision', 'artifactEpoch', 'resetArtifacts', 'artifacts']) expect((record as any)[legacy]).toBeUndefined();
  });

  it('fails closed when a persisted non-empty denied class list has no recognized classes', async () => {
    get.mockReturnValue({ promise: async () => ({ Item: {
      userId: 'eval_test', status: 'active', deniedToolClasses: ['unknown_class', 42],
    } }) });
    expect((await store.get('eval_test'))!.deniedToolClasses).toEqual(SANDBOX_TOOL_CLASS_NAMES);

    get.mockReturnValue({ promise: async () => ({ Item: {
      userId: 'eval_test', status: 'active', deniedToolClasses: [],
    } }) });
    expect((await store.get('eval_test'))!.deniedToolClasses).toEqual([]);
  });

  it('refuses a policy row whose identity does not match the requested principal', async () => {
    get.mockReturnValue({ promise: async () => ({ Item: { userId: 'eval_other', status: 'active' } }) });
    await expect(store.get('eval_test')).rejects.toThrow();
  });

  it('revocation atomically records an audit event and disables the account', async () => {
    get.mockReturnValue({ promise: async () => ({ Item: { userId: 'eval_test', email: 'candidate@example.invalid', status: 'active' } }) });
    const result = await store.revoke('admin', 'eval_test');
    expect(result.audit).toMatchObject({ actor: 'admin', action: 'revoke' });
    const writes = transactWrite.mock.calls[0][0].TransactItems;
    expect(writes.some((w: any) => w.Update?.ExpressionAttributeValues?.[':revoked'] === 'revoked')).toBe(true);
    expect(writes.some((w: any) => w.Update?.ExpressionAttributeValues?.[':inactive'] === false)).toBe(true);
    expect(writes.some((w: any) => w.Update?.UpdateExpression?.includes('sessionVersion') && w.Update?.UpdateExpression?.includes('delegateTokenEpoch'))).toBe(true);
    expect(writes.some((w: any) => w.Put?.Item.action === 'revoke')).toBe(true);
  });
  it('revocation invalidates stored keys, OAuth grants, MCP sessions, and jobs with strongly consistent pagination', async () => {
    get.mockReturnValue({ promise: async () => ({ Item: { userId: 'eval_test', email: 'candidate@example.invalid', status: 'active' } }) });
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
    get.mockReturnValue({ promise: async () => ({ Item: { userId: 'eval_test', email: 'candidate@example.invalid', status: 'active' } }) });
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
  it('records cleanup failure after the authoritative revoke commit', async () => {
    get.mockReturnValue({ promise: async () => ({ Item: { userId: 'eval_test', email: 'candidate@example.invalid' } }) });
    scan.mockImplementationOnce(() => ({ promise: async () => { throw new Error('synthetic unavailable'); } }));
    await expect(store.revoke('admin', 'eval_test')).rejects.toThrow();
    const initialRevoke = transactWrite.mock.calls[0][0].TransactItems.find((w: any) => w.Put?.Item.action === 'revoke');
    expect(initialRevoke.Put.Item.cleanupStatus).toBe('pending');
    expect(transactWrite.mock.calls.some(([params]) => params.TransactItems.some((w: any) => w.Put?.Item.action === 'revocation-cleanup-failed'))).toBe(true);
  });

  it('review is limited to the provisioning admin and explicitly assigned reviewers and returns only status + audit', async () => {
    get.mockReturnValue({ promise: async () => ({ Item: { userId: 'eval_test', status: 'revoked', provisionedBy: 'admin', reviewerUserIds: ['matt'], materials: [{ title: 'x', text: 'y' }] } }) });
    scan.mockImplementation(() => ({ promise: async () => ({ Items: [{ evaluationKey: 'evaluation/eval_test/audit/1', userId: 'eval_test', action: 'provision' }], LastEvaluatedKey: undefined }) }));
    const result = await store.review('matt', 'eval_test');
    expect(result).toEqual({ userId: 'eval_test', status: 'revoked', audit: [expect.objectContaining({ action: 'provision' })], truncated: false });
    await expect(store.review('stranger', 'eval_test')).rejects.toThrow();
  });
});
