// Human contract: ENG-1870 follow-up — connector-free campaign simulation and reset.
import { EvaluationStore } from '../services/evaluationStore';
import http from 'http';
import https from 'https';

const userId = 'eval_simulation';
const packet = {
  approved: true,
  objects: [
    { key: 'campaign', kind: 'campaign', name: 'Approved acquisition', objective: 'LEADS', budget: 5000, budgetType: 'daily', metrics: { impressions: 1000, clicks: 30, spend: 1200, conversions: 3 } },
    { key: 'set', kind: 'adset', name: 'Approved audience', parentKey: 'campaign', targeting: 'Sanitized B2B audience' },
    { key: 'creative', kind: 'creative', name: 'Approved creative', text: 'Sanitized message' },
    { key: 'ad', kind: 'ad', name: 'Approved ad', parentKey: 'set', creativeKey: 'creative' },
  ],
};

function copy(value: any): any {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (Array.isArray(value)) return value.map(copy);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, copy(v)]));
  return value;
}

// Transactional evaluation-table fake: rejects every unexpected table/operation.
function fixture() {
  const rows = new Map<string, any>();
  rows.set(`evaluation/${userId}`, { userId, email: 'synthetic@example.invalid', status: 'active', expiresAt: Date.now() + 3600000, remaining: 5, materials: [], provisionedBy: 'admin' });
  const get = jest.fn((p: any) => ({ promise: async () => {
    if (p.TableName !== 'AW-Evaluations' || p.ConsistentRead !== true) throw new Error('Unexpected read boundary');
    return { Item: copy(rows.get(p.Key.evaluationKey)) };
  } }));
  const transactWrite = jest.fn((p: any) => ({ promise: async () => {
    const draft = new Map(rows);
    for (const entry of p.TransactItems) {
      const op = entry.Update || entry.Put || entry.Delete || entry.ConditionCheck;
      if (op.TableName !== 'AW-Evaluations') throw new Error('Unexpected write boundary');
      if (entry.Put) { draft.set(op.Item.evaluationKey, copy(op.Item)); continue; }
      if (entry.Delete) { draft.delete(op.Key.evaluationKey); continue; }
      const record = copy(draft.get(op.Key.evaluationKey));
      const v = op.ExpressionAttributeValues;
      if (!record || record.status !== 'active' || record.expiresAt <= v[':now'] ||
          (v[':revision'] !== undefined && (record.simulationRevision || 0) !== v[':revision']) ||
          (v[':epoch'] !== undefined && !v[':simulation'] && (record.artifactEpoch || 0) !== v[':epoch'])) {
        throw Object.assign(new Error('Conditional denial'), { code: 'ConditionalCheckFailedException' });
      }
      if (entry.Update) {
        if (v[':simulation']) { record.simulation = copy(v[':simulation']); record.simulationRevision = v[':next']; }
        if (v[':empty']) record.artifacts = [];
        if (v[':epoch'] !== undefined && v[':empty']) record.artifactEpoch = v[':epoch'];
        if (v[':pending']) record.resetArtifacts = copy(v[':pending']);
        if (op.UpdateExpression === 'REMOVE resetArtifacts') delete record.resetArtifacts;
        draft.set(op.Key.evaluationKey, record);
      }
    }
    rows.clear(); for (const [key, row] of draft) rows.set(key, row);
  } }));
  const scan = jest.fn((p: any) => ({ promise: async () => ({ Items: [...rows.values()].filter(r => r.userId === p.ExpressionAttributeValues[':user'] && r.evaluationKey?.startsWith(p.ExpressionAttributeValues[':prefix'])) }) }));
  const store = new EvaluationStore({ get, transactWrite, scan } as any);
  return { rows, get, transactWrite, store, record: () => rows.get(`evaluation/${userId}`) };
}

describe('connector-free evaluation simulator', () => {
  let f: ReturnType<typeof fixture>;
  let fetchSpy: jest.SpyInstance; let httpSpy: jest.SpyInstance; let httpsSpy: jest.SpyInstance;
  const command = (input: any) => (f.store as any).simulate(userId, input);
  beforeEach(() => {
    f = fixture();
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network forbidden'));
    httpSpy = jest.spyOn(http, 'request').mockImplementation(() => { throw new Error('Network forbidden'); });
    httpsSpy = jest.spyOn(https, 'request').mockImplementation(() => { throw new Error('Network forbidden'); });
  });
  afterEach(() => {
    expect(fetchSpy).not.toHaveBeenCalled(); expect(httpSpy).not.toHaveBeenCalled(); expect(httpsSpy).not.toHaveBeenCalled();
    jest.restoreAllMocks();
  });
  async function seed() {
    // Provisioning seeds from this same approved packet; legacy workspaces are empty.
    const { createSimulation } = require('../services/evaluationSimulation');
    f.record().simulation = createSimulation(userId, packet);
    f.record().simulationRevision = 0;
  }
  it('retains strongly consistent evaluation-only reads (passing control)', async () => {
    expect(await f.store.get(userId)).toMatchObject({ userId, status: 'active' });
  });
  it('queries a frozen approved dataset after candidate edits', async () => {
    await seed();
    const initial = await command({ operation: 'query', source: 'approved', kind: 'campaign' });
    expect(initial.objects).toHaveLength(1);
    expect(initial.objects[0]).toMatchObject({ name: 'Approved acquisition', metrics: { clicks: 30 } });
    const id = initial.objects[0].id;
    expect(id).toContain(userId);
    await command({ operation: 'update', id, fields: { name: 'Candidate proposal', budget: 9000 } });
    expect((await command({ operation: 'query', source: 'approved' })).objects[0].name).toBe('Approved acquisition');
    expect((await command({ operation: 'inspect', id })).object.budget).toBe(9000);
  });
  it('creates campaign → ad set → creative/upload → ad and returns publish/pause/activate state', async () => {
    const campaign = await command({ operation: 'create', kind: 'campaign', fields: { name: 'Proposal', objective: 'LEADS', budget: 5000, budgetType: 'daily' } });
    expect(campaign).toMatchObject({ ok: true, disclosure: 'Simulation complete — not sent to Meta' });
    const adset = await command({ operation: 'create', kind: 'adset', fields: { name: 'Audience', parentId: campaign.object.id, targeting: 'B2B leaders', startTime: '2030-01-01T00:00:00.000Z', endTime: '2030-02-01T00:00:00.000Z' } });
    const creative = await command({ operation: 'create', kind: 'creative', fields: { name: 'Creative', text: 'Approved concept', upload: { mime: 'text/plain', base64: Buffer.from('synthetic creative bytes').toString('base64') } } });
    const ad = await command({ operation: 'create', kind: 'ad', fields: { name: 'Ad', parentId: adset.object.id, creativeId: creative.object.id } });
    for (const object of [campaign.object, adset.object, ad.object]) {
      expect((await command({ operation: 'publish', id: object.id })).object).toMatchObject({ published: true, status: 'PAUSED' });
      expect((await command({ operation: 'activate', id: object.id })).object.status).toBe('ACTIVE');
      expect((await command({ operation: 'pause', id: object.id })).object.status).toBe('PAUSED');
    }
    expect((await command({ operation: 'inspect', id: creative.object.id })).object.upload.base64).toBe(Buffer.from('synthetic creative bytes').toString('base64'));
    expect(f.record().remaining).toBe(5);
  });
  it.each([
    { operation: 'create', kind: 'campaign', fields: { name: 'x', objective: 'INVALID', budget: -1 } },
    { operation: 'create', kind: 'adset', fields: { name: 'x', parentId: 'act_123', targeting: 'x' } },
    { operation: 'create', kind: 'creative', fields: { name: 'x', imageUrl: 'https://example.invalid/asset' } },
    { operation: 'create', kind: 'creative', fields: { name: 'x', upload: { mime: 'image/svg+xml', base64: 'abcd' } } },
    { operation: 'create', kind: 'campaign', fields: { name: 'x', objective: 'LEADS', budget: 1.5 } },
    { operation: 'create', kind: 'campaign', fields: { name: 'x', objective: 'LEADS', budget: 5000, startTime: '2030-02-01T00:00:00.000Z', endTime: '2030-01-01T00:00:00.000Z' } },
    { operation: 'create', kind: 'creative', fields: { name: 'x', text: 'https://graph.facebook.com/secret' } },
  ])('returns safe validation without mutating objects: %p', async input => {
    const result = await command(input);
    expect(result).toMatchObject({ ok: false, disclosure: 'Simulation complete — not sent to Meta' });
    expect(result.errors.length).toBeGreaterThan(0);
    expect((await command({ operation: 'query' })).objects).toEqual([]);
  });
  it('refuses activation before publish and warns when a parent is paused', async () => {
    await seed();
    const objects = (await command({ operation: 'query' })).objects;
    const ad = objects.find((o: any) => o.kind === 'ad');
    expect((await command({ operation: 'activate', id: ad.id })).ok).toBe(false);
    expect((await command({ operation: 'publish', id: ad.id })).ok).toBe(true);
    const active = await command({ operation: 'activate', id: ad.id });
    expect(active.object.effectiveStatus).toBe('PARENT_PAUSED');
    expect(active.warnings.length).toBeGreaterThan(0);
  });
  it('foreign IDs and identity/destination overrides fail without exposing another evaluation', async () => {
    await seed();
    expect((await command({ operation: 'inspect', id: 'sim_eval_foreign_campaign' })).ok).toBe(false);
    await expect(command({ operation: 'query', userId: 'eval_other' })).rejects.toThrow();
    await expect(command({ operation: 'query', url: 'https://graph.facebook.com' })).rejects.toThrow();
    expect(f.get.mock.calls.every(([p]) => p.Key.evaluationKey === `evaluation/${userId}`)).toBe(true);
  });
  it('reset is idempotent, restores frozen seed, wipes QA artifacts and does not refund generation spend', async () => {
    await seed();
    const baseline = (await command({ operation: 'query' })).objects;
    await command({ operation: 'update', id: baseline[0].id, fields: { budget: 10000 } });
    f.record().artifacts = [{ artifactId: 'disposable', mime: 'text/plain' }];
    f.rows.set(`evaluation/${userId}/artifact/disposable`, { userId, content: Buffer.from('disposable') });
    await command({ operation: 'reset' });
    await command({ operation: 'reset' });
    expect((await command({ operation: 'query' })).objects).toEqual(baseline);
    expect(f.record().artifacts).toEqual([]);
    expect(f.rows.has(`evaluation/${userId}/artifact/disposable`)).toBe(false);
    expect(f.record().remaining).toBe(5);
    expect([...f.rows.values()].some(r => r.action === 'simulation:reset')).toBe(true);
  });
  it.each(['revoked', 'expired', 'missing'])('%s workspaces deny queries, reset, and writes', async condition => {
    if (condition === 'missing') f.rows.clear();
    else if (condition === 'expired') f.record().expiresAt = 1;
    else f.record().status = 'revoked';
    for (const operation of ['query', 'create', 'reset']) await expect(command({ operation })).rejects.toThrow();
    expect(f.transactWrite).not.toHaveBeenCalled();
  });
  it('concurrent edits cannot overwrite one another silently', async () => {
    const results = await Promise.allSettled([1, 2].map(i => command({ operation: 'create', kind: 'creative', fields: { name: `Proposal ${i}`, text: 'Synthetic' } })));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
  });
  it('revocation racing the transaction prevents state and audit writes', async () => {
    const original = f.transactWrite.getMockImplementation()!;
    f.transactWrite.mockImplementationOnce(p => { f.record().status = 'revoked'; return original(p); });
    await expect(command({ operation: 'create', kind: 'creative', fields: { name: 'Late', text: 'Late' } })).rejects.toThrow();
    expect(f.record().simulation).toBeUndefined();
  });
  it('resets all 100 legacy artifacts, including retry after cleanup fails', async () => {
    f.record().artifacts = Array.from({ length: 100 }, (_, i) => ({ artifactId: `file-${i}`, mime: 'text/plain' }));
    for (const a of f.record().artifacts) f.rows.set(`evaluation/${userId}/artifact/${a.artifactId}`, { userId, content: Buffer.from('QA') });
    const original = f.transactWrite.getMockImplementation()!;
    let failed = false;
    f.transactWrite.mockImplementation(p => {
      if (!failed && p.TransactItems.some((t: any) => t.Delete)) {
        failed = true; return { promise: async () => { throw new Error('Cleanup unavailable'); } };
      }
      return original(p);
    });
    await expect(command({ operation: 'reset' })).rejects.toThrow('Cleanup unavailable');
    expect(f.record().artifacts).toEqual([]);
    expect(f.record().resetArtifacts).toHaveLength(100);
    await expect(f.store.getArtifact(userId, 'file-0')).rejects.toThrow();
    await command({ operation: 'reset' });
    expect([...f.rows.keys()].filter(k => k.includes('/artifact/'))).toEqual([]);
    expect(f.record().resetArtifacts).toBeUndefined();
    expect(f.transactWrite.mock.calls.every(([p]) => p.TransactItems.length <= 100)).toBe(true);
  });
  it('late generated artifacts cannot cross a reset epoch', async () => {
    f.record().artifactEpoch = 1;
    await expect(f.store.saveArtifact(userId, Buffer.from('late'), 'text/plain', 0)).rejects.toThrow();
  });
  it('explicit reviewer assignment permits review after revoke, but foreign admins get no artifacts', async () => {
    await seed();
    await command({ operation: 'create', kind: 'creative', fields: { name: 'Proposal', text: 'Synthetic' } });
    f.record().status = 'revoked';
    expect(await (f.store as any).review('admin', userId)).toMatchObject({ status: 'revoked', audit: [expect.objectContaining({ action: 'simulation:create' })] });
    f.record().reviewerUserIds = ['reviewer'];
    expect((await (f.store as any).review('reviewer', userId)).simulation.objects.length).toBe(5);
    await expect((f.store as any).review('foreign-admin', userId)).rejects.toThrow();
  });

  it.each([
    { seed: [null], objects: [] }, { seed: [], objects: ['bad'] },
    { seed: [], objects: [{ id: 'foreign', kind: 'creative', name: 'x', text: 'x', status: 'DRAFT', published: false }] },
    { seed: [], objects: [{ id: `sim_${userId}_bad`, kind: 'creative', name: 'x', text: 'x', status: 'DRAFT', published: false, accessToken: 'secret' }] },
  ])('malformed persisted simulation fails closed on every read/write path: %p', async simulation => {
    f.record().simulation = simulation;
    for (const operation of ['query', 'reset', 'create']) await expect(command({ operation })).rejects.toThrow();
    await expect((f.store as any).review('admin', userId)).rejects.toThrow();
  });
  it('artifact reset racing a download suppresses the stale bytes', async () => {
    f.record().artifacts = [{ artifactId: 'race', mime: 'text/plain' }];
    f.rows.set(`evaluation/${userId}/artifact/race`, { userId, content: Buffer.from('stale'), mime: 'text/plain' });
    const original = f.get.getMockImplementation()!;
    f.get.mockImplementation(p => {
      const result = original(p);
      if (p.Key.evaluationKey.includes('/artifact/')) { f.record().artifacts = []; f.record().artifactEpoch = 1; }
      return result;
    });
    await expect(f.store.getArtifact(userId, 'race')).rejects.toThrow();
  });
  it('expired parent schedules deny publishing a child', async () => {
    await seed();
    const campaign = f.record().simulation.objects.find((o: any) => o.kind === 'campaign');
    const adset = f.record().simulation.objects.find((o: any) => o.kind === 'adset');
    campaign.startTime = '2000-01-01T00:00:00.000Z'; campaign.endTime = '2001-01-01T00:00:00.000Z';
    expect((await command({ operation: 'publish', id: adset.id })).ok).toBe(false);
  });

  it('frozen query effective status cannot change when candidate parents are edited', async () => {
    await seed();
    const current = f.record().simulation;
    for (const o of [...current.seed, ...current.objects]) { if (o.kind !== 'creative') { o.status = 'ACTIVE'; o.published = true; } }
    const before = await command({ operation: 'query', source: 'approved' });
    await command({ operation: 'pause', id: current.objects.find((o: any) => o.kind === 'campaign').id });
    expect((await command({ operation: 'query', source: 'approved' })).objects).toEqual(before.objects);
  });

});
