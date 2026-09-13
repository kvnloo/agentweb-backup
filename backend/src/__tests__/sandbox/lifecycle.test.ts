// ENG-1910 human acceptance: exact reset, exhaustive purge orchestration, retained reviewer access.
import { createHash } from 'crypto';
import { EvaluationStore } from '../../services/evaluationStore';
import { buildFixtureDataset } from './fixtures/fixtureDataset';
import { EMPTY_OVERLAY } from '../../services/sandbox/types';

const seed = buildFixtureDataset();
const seedHash = createHash('sha256').update(JSON.stringify(seed)).digest('hex');
const policy = { userId: 'eval_candidate', email: 'candidate@example.invalid', status: 'active',
  provisionedBy: 'admin', reviewerUserIds: ['reviewer'], datasetId: seed.meta.datasetId,
  datasetVersion: seed.meta.version, expiresAt: Date.now() + 86400000 };

function harness() {
  let record: any = { ...policy };
  let overlay: any = { ...JSON.parse(JSON.stringify(EMPTY_OVERLAY)), campaigns: { [seed.campaigns[0].id]: { ...seed.campaigns[0], name: 'Changed' } } };
  const audit = [
    { evaluationKey: 'evaluation/eval_candidate/audit/b', userId: policy.userId, action: 'meta', at: '2026-09-12T12:00:02.000Z', method: 'POST', path: 'campaign', args: {}, result: { success: true } },
    { evaluationKey: 'evaluation/eval_candidate/audit/a', userId: policy.userId, action: 'meta', at: '2026-09-12T12:00:01.000Z', method: 'GET', path: 'campaigns', args: {}, result: {} },
  ];
  const events: string[] = [];
  const db: any = {
    get: jest.fn(({ Key }: any) => ({ promise: async () => ({ Item: Key.evaluationKey?.endsWith('/sim') ? (overlay && { evaluationKey: Key.evaluationKey, userId: policy.userId, overlay }) : record }) })),
    scan: jest.fn(({ TableName, ExpressionAttributeValues }: any) => ({ promise: async () => ({ Items: TableName.endsWith('AW-Evaluations') ?
      (String(ExpressionAttributeValues?.[':prefix']).endsWith('/audit/') ? audit : []) : [] }) })),
    delete: jest.fn(({ Key }: any) => ({ promise: async () => { events.push('delete'); if (Key.evaluationKey?.endsWith('/sim')) overlay = null; return {}; } })),
    transactWrite: jest.fn(({ TransactItems }: any) => ({ promise: async () => {
      for (const w of TransactItems) {
        if (w.Update?.TableName.endsWith('AW-Evaluations')) {
          const vals = w.Update.ExpressionAttributeValues;
          if (vals[':state']) { record.lifecycleState = vals[':state']; events.push('lock'); }
          if (vals[':revoked']) record.status = vals[':revoked'];
          if (w.Update.UpdateExpression.includes('REMOVE lifecycleState')) { delete record.lifecycleState; events.push('unlock'); }
        }
        if (w.Delete?.Key.evaluationKey?.endsWith('/sim')) { overlay = null; events.push('overlay'); }
        if (w.Put?.Item.action) events.push(w.Put.Item.action);
      }
      return {};
    } })),
  };
  const cleanup = {
    assertQuiescent: jest.fn(async () => { events.push('quiescent'); }),
    deleteSandboxPrefix: jest.fn(async () => { events.push('s3'); return 2; }),
    preparePurge: jest.fn(async () => async () => { events.push('artifacts'); return { sessions: 1, executions: 1, files: 3 }; }),
  };
  const datasets = { loadDataset: jest.fn(async () => seed) };
  // Added lifecycle dependency seam must exercise the same orchestration as the production adapter.
  const store = new (EvaluationStore as any)(db, { cleanup, datasets });
  return { store, db, cleanup, datasets, events, audit, record: () => record, overlay: () => overlay };
}

describe('ENG-1910 lifecycle acceptance', () => {
  it('review orders Meta actions, includes seed overlay diff and remains available after revocation', async () => {
    const h = harness();
    h.record().status = 'revoked';
    const review = await h.store.review('reviewer', policy.userId);
    expect(review.timeline.map((a: any) => a.method)).toEqual(['GET', 'POST']);
    expect(JSON.stringify(review.overlayDiff)).toContain('Changed');
    expect(review.markdown).toContain('Changed');
    expect(review.markdown.indexOf('GET')).toBeLessThan(review.markdown.indexOf('POST'));
  });
  it('reset removes the S3 prefix before dropping the overlay and restores the exact immutable seed hash', async () => {
    const h = harness();
    const result = await h.store.reset('admin', policy.userId);
    expect(result.seedSha256).toBe(seedHash);
    expect(h.overlay()).toBeNull();
    expect(h.cleanup.deleteSandboxPrefix).toHaveBeenCalledWith(policy.userId);
    expect(h.events.indexOf('lock')).toBeLessThan(h.events.indexOf('s3'));
    expect(h.events.indexOf('s3')).toBeLessThan(h.events.indexOf('overlay'));
    expect(h.record().lifecycleState).toBeUndefined();
    expect(h.datasets.loadDataset).toHaveBeenCalledWith(seed.meta.datasetId, seed.meta.version);
    expect(createHash('sha256').update(JSON.stringify(seed)).digest('hex')).toBe(seedHash);
  });
  it('purge revokes before artifact deletion and retains policy/audit while deleting the user', async () => {
    const h = harness();
    const result = await h.store.purge('admin', policy.userId);
    expect(result.status).toBe('revoked');
    expect(h.cleanup.preparePurge).toHaveBeenCalledWith(policy.userId);
    expect(h.events.indexOf('revoke')).toBeLessThan(h.events.indexOf('artifacts'));
    expect(h.record().lifecycleState).toBe('purged');
    const deletes = h.db.transactWrite.mock.calls.flatMap(([p]: any) => p.TransactItems).filter((w: any) => w.Delete);
    expect(deletes.some((w: any) => w.Delete.TableName.endsWith('AW-Users') && w.Delete.ConditionExpression.includes('userId'))).toBe(true);
    expect(deletes.some((w: any) => w.Delete.Key.evaluationKey === 'evaluation/eval_candidate')).toBe(false);
  });
  it('a stranger cannot review a revoked sandbox', async () => {
    const h = harness(); h.record().status = 'revoked';
    await expect(h.store.review('stranger', policy.userId)).rejects.toThrow();
  });
  it('failed reset stays blocked and retains overlay for safe retry', async () => {
    const h = harness(); h.cleanup.deleteSandboxPrefix.mockRejectedValueOnce(new Error('S3 unavailable'));
    await expect(h.store.reset('admin', policy.userId)).rejects.toThrow('S3 unavailable');
    expect(h.record().lifecycleState).toBe('resetting');
    expect(h.overlay()).not.toBeNull();
  });
  it('active work blocks cleanup while the policy remains closed', async () => {
    const h = harness(); h.cleanup.assertQuiescent.mockRejectedValueOnce(new Error('active work'));
    await expect(h.store.reset('admin', policy.userId)).rejects.toThrow('active work');
    expect(h.cleanup.deleteSandboxPrefix).not.toHaveBeenCalled();
    expect(h.record().lifecycleState).toBe('resetting');
  });
});

it('returns the complete audit beyond twenty empty filtered pages and the old byte budget', async () => {
  const h = harness(); let pages = 0;
  const large = { ...h.audit[0], detail: 'x'.repeat(8 * 1024 * 1024) };
  h.db.scan.mockImplementation(() => ({ promise: async () => {
    ++pages;
    return { Items: pages === 21 ? [large] : pages === 22 ? [h.audit[1]] : [],
      ...(pages < 22 ? { LastEvaluatedKey: { evaluationKey: String(pages) } } : {}) };
  } }));
  const review = await h.store.review('reviewer', policy.userId);
  expect(pages).toBe(22);
  expect(review.timeline.map((a: any) => a.method)).toEqual(['GET', 'POST']);
  expect(review.truncated).toBe(false);
});

it('inventories late legacy material before artifact cleanup and retains audit rows', async () => {
  const h = harness(); let pages = 0;
  h.db.scan.mockImplementation(({ TableName, ExclusiveStartKey }: any) => ({ promise: async () => {
    expect(h.db.delete).not.toHaveBeenCalled();
    expect(h.events).not.toContain('artifacts');
    if (!TableName.endsWith('AW-Evaluations')) return { Items: [] };
    expect(ExclusiveStartKey).toEqual(pages ? { evaluationKey: String(pages) } : undefined);
    ++pages;
    return { Items: pages === 22 ? [{ evaluationKey: 'evaluation/eval_candidate/sim', userId: policy.userId }, ...h.audit] : [],
      ...(pages < 22 ? { LastEvaluatedKey: { evaluationKey: String(pages) } } : {}) };
  } }));
  await h.store.purge('admin', policy.userId);
  expect(pages).toBe(22);
  expect(h.db.delete.mock.calls.map(([p]: any) => p.Key)).toEqual([{ evaluationKey: 'evaluation/eval_candidate/sim' }]);
});

it.each(['material', 'credential', 'artifact'])('does not delete anything if the %s inventory fails', async failure => {
  const h = harness();
  h.db.scan.mockImplementation(({ TableName, ExclusiveStartKey }: any) => ({ promise: async () => {
    if (TableName.endsWith('AW-Evaluations')) {
      if (failure === 'material' && ExclusiveStartKey) throw new Error('inventory unavailable');
      return { Items: [{ evaluationKey: 'evaluation/eval_candidate/sim' }],
        ...(failure === 'material' ? { LastEvaluatedKey: { evaluationKey: 'next' } } : {}) };
    }
    if (failure === 'credential' && TableName.endsWith('AW-TaskSchedules')) throw new Error('inventory unavailable');
    if (TableName.endsWith('AW-AgentApiKeys')) return { Items: [{ keyId: 'key', userId: policy.userId }] };
    return { Items: [] };
  } }));
  if (failure === 'artifact') h.cleanup.preparePurge.mockRejectedValueOnce(new Error('inventory unavailable'));
  await expect(h.store.purge('admin', policy.userId)).rejects.toThrow('inventory unavailable');
  expect(h.db.delete).not.toHaveBeenCalled();
  expect(h.events).not.toContain('artifacts');
  expect(h.record().lifecycleState).toBe('purging');
});

it('revokes credentials beyond twenty empty pages without trusting a lagging GSI', async () => {
  const h = harness(); let pages = 0;
  h.db.scan.mockImplementation((params: any) => ({ promise: async () => {
    expect(params.IndexName).toBeUndefined();
    expect(params.ConsistentRead).toBe(true);
    expect(h.db.delete).not.toHaveBeenCalled();
    if (!params.TableName.endsWith('AW-AgentApiKeys')) return { Items: [] };
    ++pages;
    return { Items: pages === 22 ? [{ keyId: 'not-indexed-yet', userId: policy.userId }] : [],
      ...(pages < 22 ? { LastEvaluatedKey: { keyId: String(pages) } } : {}) };
  } }));
  const result = await h.store.revoke('admin', policy.userId);
  expect(pages).toBe(22);
  expect(result.cleanup['AW-AgentApiKeys']).toBe(1);
  expect(h.db.delete).toHaveBeenCalledWith(expect.objectContaining({ Key: { keyId: 'not-indexed-yet' },
    ConditionExpression: '#owner = :user' }));
});

it.each(['repeated', 'malformed', 'foreign', 'late-missing'])('fails closed on %s credential inventory before any deletion', async failure => {
  const h = harness();
  h.db.scan.mockImplementation(({ TableName, ExclusiveStartKey }: any) => ({ promise: async () => {
    if (TableName.endsWith('AW-AgentApiKeys')) return { Items: [{ keyId: 'key', userId: policy.userId }] };
    if (!TableName.endsWith('AW-TaskSchedules')) return { Items: [] };
    if (failure === 'malformed') return { Items: [true] };
    if (failure === 'foreign') return { Items: [{ scheduleId: 'other', userId: 'someone-else' }] };
    if (failure === 'late-missing' && ExclusiveStartKey) throw Object.assign(new Error('late missing'), { code: 'ResourceNotFoundException' });
    return { Items: [], LastEvaluatedKey: { scheduleId: 'repeat' } };
  } }));
  await expect(h.store.revoke('admin', policy.userId)).rejects.toThrow();
  expect(h.db.delete).not.toHaveBeenCalled();
  expect(h.record().status).toBe('revoked');
});
