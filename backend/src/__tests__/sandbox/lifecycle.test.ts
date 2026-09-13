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
    purge: jest.fn(async () => { events.push('artifacts'); return { sessions: 1, executions: 1, files: 3 }; }),
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
    expect(h.cleanup.purge).toHaveBeenCalledWith(policy.userId);
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

it('bounds review scans including empty filtered pages and marks the result truncated', async () => {
  const h = harness(); let pages = 0;
  h.db.scan.mockImplementation(() => ({ promise: async () => ({ Items: [], LastEvaluatedKey: { evaluationKey: String(++pages) } }) }));
  const review = await h.store.review('reviewer', policy.userId);
  expect(pages).toBe(20);
  expect(review.truncated).toBe(true);
  expect(review.markdown).toContain('Audit is truncated');
});
it('does not silently complete a purge when the material scan exceeds its budget', async () => {
  const h = harness(); let pages = 0;
  h.db.scan.mockImplementation(({ TableName, ExpressionAttributeValues }: any) => ({ promise: async () =>
    TableName.endsWith('AW-Evaluations') && ExpressionAttributeValues?.[':prefix']
      ? { Items: [], LastEvaluatedKey: { evaluationKey: String(++pages) } } : { Items: [] } }));
  await expect(h.store.purge('admin', policy.userId)).rejects.toThrow(/limit/);
  expect(pages).toBe(20);
  expect(h.record().lifecycleState).toBe('purging');
  expect(h.db.delete).not.toHaveBeenCalled();
});
