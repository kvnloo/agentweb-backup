import { SandboxArtifactCleanup } from '../../services/sandbox/artifactCleanup';

const userId = 'eval_cleanup';
function fixture(rows: Record<string, any[]> = {}) {
  const db = {
    scan: jest.fn((p: any) => ({ promise: async () => ({ Items: rows[p.TableName] || [] }) })),
    query: jest.fn((p: any) => ({ promise: async () => ({ Items: rows[p.TableName] || [] }) })),
    get: jest.fn((p: any) => ({ promise: async () => ({ Item: (rows[p.TableName] || []).find(row => Object.entries(p.Key).every(([key, value]) => row[key] === value)) }) })),
    delete: jest.fn((_p: any) => ({ promise: async () => ({}) })),
  };
  const s3 = {
    listObjectsV2: jest.fn((_p: any) => ({ promise: async () => ({ Contents: [] }) })),
    deleteObjects: jest.fn((_p: any) => ({ promise: async () => ({}) })),
  };
  const deleteGcsPrefix = jest.fn(async () => {});
  const cleanup = new SandboxArtifactCleanup({ db: db as any, s3: s3 as any, tablePrefix: '', deleteGcsPrefix });
  return { db, s3, cleanup, deleteGcsPrefix };
}

describe('sandbox artifact purge acceptance', () => {
  it('removes owned sessions/messages/share records, executions, KB files, landers and user prefixes, preserving policy/audit', async () => {
    const f = fixture({
      'AW-ChatSessions': [{ sessionId: 'session1', userId, shareToken: 'share' }],
      'AW-ChatMessages': [{ sessionId: 'session1', messageIndex: 0 }],
      'AW-Tasks': [{ taskId: 'task1', userId, knowledgeBaseType: 'private' }],
      'AW-TaskExecutions': [{ executionId: 'execution1', userId, status: 'completed' }],
      'AW-LandingPages': [{ id: 'page1', userId }],
      'AW-WorkPlans': [{ planId: 'plan1', ownerId: userId }],
    });
    await f.cleanup.purge(userId);
    expect(f.db.delete.mock.calls.map(([p]: any) => p.TableName)).toEqual(expect.arrayContaining([
      'AW-ChatSessions', 'AW-ChatMessages', 'AW-Tasks', 'AW-TaskExecutions', 'AW-LandingPages',
    ]));
    expect(f.db.scan.mock.calls.some(([p]: any) => p.TableName === 'AW-Evaluations')).toBe(false);
    expect(f.deleteGcsPrefix).toHaveBeenCalledWith('tasks/task1/');
    expect(f.s3.listObjectsV2.mock.calls.map(([p]: any) => p.Prefix)).toEqual(expect.arrayContaining([
      `users/${userId}/`, `sandbox/${userId}/`, 'tasks/task1/', 'workplans/plan1/', 'tool-responses/session1/',
    ]));
  });
  it('scans every database page including empty filtered pages', async () => {
    const f = fixture();
    f.db.scan.mockReturnValueOnce({ promise: async () => ({ Items: [], LastEvaluatedKey: { pk: 'cursor' } }) } as any);
    await f.cleanup.purge(userId);
    expect(f.db.scan.mock.calls[1][0]).toMatchObject({ ExclusiveStartKey: { pk: 'cursor' }, ConsistentRead: true });
  });
  it('removes execution files even when the parent task was already deleted', async () => {
    const f = fixture({ 'AW-TaskExecutions': [{ executionId: 'execution1', taskId: 'deletedTask', userId, status: 'completed' }] });
    await f.cleanup.purge(userId);
    expect(f.s3.listObjectsV2.mock.calls.map(([p]: any) => p.Prefix)).toContain('tasks/deletedTask/executions/execution1/');
    expect(f.deleteGcsPrefix).not.toHaveBeenCalled();
  });
  it('refuses non-sandbox identities without touching storage', async () => {
    const f = fixture();
    await expect(f.cleanup.purge('real_user')).rejects.toThrow();
    expect(f.db.scan).not.toHaveBeenCalled();
  });
  it('refuses malformed or cross-owner scan results before deleting', async () => {
    const f = fixture({ 'AW-ChatSessions': [{ sessionId: 'other', userId: 'real_user' }] });
    await expect(f.cleanup.purge(userId)).rejects.toThrow();
    expect(f.db.delete).not.toHaveBeenCalled();
  });
  it('keeps ownership records when object deletion partially fails', async () => {
    const f = fixture({ 'AW-Tasks': [{ taskId: 'task1', userId }] });
    f.s3.listObjectsV2.mockImplementation((() => ({ promise: async () => ({ Contents: [{ Key: 'sandbox/eval_cleanup/file' }] }) })) as any);
    f.s3.deleteObjects.mockImplementation((() => ({ promise: async () => ({ Errors: [{ Code: 'AccessDenied' }] }) })) as any);
    await expect(f.cleanup.purge(userId)).rejects.toThrow();
    expect(f.db.delete).not.toHaveBeenCalled();
  });
  it('blocks active executions and externally deployed landers before destructive cleanup', async () => {
    const activeFixtures: Array<Record<string, any[]>> = [
      { 'AW-AgentRuns': [{ pk: 'run#1', userId, status: 'running' }] },
      { 'AW-LandingPages': [{ id: 'page1', userId, vercelProjectId: 'prj_real' }] },
    ];
    for (const rows of activeFixtures) {
      const f = fixture(rows);
      await expect(f.cleanup.purge(userId)).rejects.toThrow();
      expect(f.s3.listObjectsV2).not.toHaveBeenCalled();
      expect(f.db.delete).not.toHaveBeenCalled();
    }
  });
  it('can retry after database deletion fails without losing child artifact ownership', async () => {
    const rows: Record<string, any[]> = {
      'AW-ChatSessions': [{ sessionId: 's1', userId }],
      'AW-ChatMessages': [{ sessionId: 's1', messageIndex: 0 }],
      'AW-Tasks': [{ taskId: 't1', userId }],
    };
    const f = fixture(rows);
    let fail = true;
    f.db.delete.mockImplementation((p: any) => ({ promise: async () => {
      if (p.TableName === 'AW-Tasks' && fail) { fail = false; throw new Error('transient'); }
      rows[p.TableName] = (rows[p.TableName] || []).filter(row =>
        !Object.entries(p.Key).every(([key, value]) => row[key] === value));
      return {};
    } }));
    await expect(f.cleanup.purge(userId)).rejects.toThrow('transient');
    expect(rows['AW-Tasks']).toHaveLength(1);
    await expect(f.cleanup.purge(userId)).resolves.toBeDefined();
    expect(Object.values(rows).flat()).toHaveLength(0);
    expect(f.deleteGcsPrefix).toHaveBeenCalledTimes(2);
  });
  it('paginates object listings and rejects escaped prefix keys', async () => {
    const f = fixture();
    f.s3.listObjectsV2.mockReturnValueOnce({ promise: async () => ({ Contents: [{ Key: `sandbox/${userId}/one` }], IsTruncated: true, NextContinuationToken: 'next' }) } as any);
    await f.cleanup.deleteSandboxPrefix(userId);
    expect(f.s3.listObjectsV2.mock.calls[1][0]).toMatchObject({ ContinuationToken: 'next' });
    f.s3.listObjectsV2.mockReturnValueOnce({ promise: async () => ({ Contents: [{ Key: 'users/real/file' }] }) } as any);
    await expect(f.cleanup.deleteSandboxPrefix(userId)).rejects.toThrow();
  });
});

it('uses only existing ownership indexes and primary queries, with a keyed settings read', async () => {
  const f = fixture({ 'AW-ChatSessions': [{ sessionId: 's1', userId }], 'AW-Settings': [{ settingName: `templates_${userId}` }] });
  await f.cleanup.purge(userId);
  expect(f.db.query).toHaveBeenCalledWith(expect.objectContaining({ TableName: 'AW-ChatSessions', IndexName: 'UserIdIndex', KeyConditionExpression: '#owner = :owner' }));
  expect(f.db.query).toHaveBeenCalledWith(expect.objectContaining({ TableName: 'AW-ChatMessages', ConsistentRead: true }));
  for (const [p] of f.db.query.mock.calls) if (p.IndexName) expect(p.ConsistentRead).toBeUndefined();
  expect(f.db.get).toHaveBeenCalledWith({ TableName: 'AW-Settings', Key: { settingName: `templates_${userId}` }, ConsistentRead: true });
  expect(new Set(f.db.scan.mock.calls.map(([p]) => p.TableName))).toEqual(new Set(['AW-AgentRuns', 'AW-WorkflowExecutions']));
});
it('rechecks GSI ownership and active status against the strongly consistent base row', async () => {
  for (const current of [{ sessionId: 's1', userId: 'other' }, { sessionId: 's1', userId, isProcessing: true }]) {
    const f = fixture({ 'AW-ChatSessions': [{ sessionId: 's1', userId }] });
    f.db.get.mockReturnValueOnce({ promise: async () => ({ Item: current }) });
    await expect(f.cleanup.purge(userId)).rejects.toThrow();
    expect(f.db.delete).not.toHaveBeenCalled();
    expect(f.s3.listObjectsV2).not.toHaveBeenCalled();
  }
});
it('fails closed on repeated pagination or scan budget exhaustion before deleting anything', async () => {
  for (const repeated of [true, false]) {
    const f = fixture(); let n = 0;
    f.db.scan.mockImplementation(() => ({ promise: async () => ({ Items: [], LastEvaluatedKey: { pk: String(repeated ? 1 : ++n) } }) }));
    await expect(f.cleanup.purge(userId)).rejects.toThrow(/pagination|limit/);
    expect(f.db.scan.mock.calls.length).toBeLessThanOrEqual(20);
    expect(f.db.delete).not.toHaveBeenCalled();
    expect(f.s3.listObjectsV2).not.toHaveBeenCalled();
  }
});
it('paginates empty GSI pages and refuses malformed or missing-index responses', async () => {
  const f = fixture();
  f.db.query.mockReturnValueOnce({ promise: async () => ({ Items: [], LastEvaluatedKey: { sessionId: 'next' } }) } as any);
  await f.cleanup.purge(userId);
  expect(f.db.query.mock.calls[1][0]).toMatchObject({ ExclusiveStartKey: { sessionId: 'next' } });
  f.db.query.mockReturnValueOnce({ promise: async () => ({ Items: [null] }) } as any);
  await expect(f.cleanup.purge(userId)).rejects.toThrow(/ownership/);
  f.db.query.mockImplementationOnce(() => ({ promise: async () => { throw Object.assign(new Error('missing index'), { code: 'ResourceNotFoundException' }); } }));
  await expect(f.cleanup.purge(userId)).rejects.toThrow('missing index');
});
