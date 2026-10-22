import AWS from 'aws-sdk';
import { newGoldenCase, type GoldenCase } from '../loops/eval/goldenSet';
import {
  createGoldenSetStore,
  documentClientDb,
  GoldenCaseNotFoundError,
  GoldenCaseVersionConflictError,
  GoldenSetStoreNotProvisionedError,
  goldenSetStoreFromEnv,
  resolveGoldenCasesTable,
  SURFACE_INDEX,
  type GoldenSetDb,
} from '../loops/eval/goldenSetStore';

type DocClient = AWS.DynamoDB.DocumentClient;

const NOW = new Date('2026-09-25T00:00:00.000Z');

function conditionalFailure(): Error {
  return Object.assign(new Error('The conditional request failed'), { code: 'ConditionalCheckFailedException' });
}

/** In-memory DynamoDB for the calls the store makes (conditions evaluated like DynamoDB's). */
function fakeDb(pageSize = 100) {
  const items = new Map<string, Record<string, unknown>>();
  const db: jest.Mocked<GoldenSetDb> = {
    get: jest.fn(async (p: AWS.DynamoDB.DocumentClient.GetItemInput) => ({ Item: items.get(String(p.Key.caseId)) })),
    put: jest.fn(async (p: AWS.DynamoDB.DocumentClient.PutItemInput) => {
      const id = String(p.Item.caseId);
      if (p.ConditionExpression === 'attribute_not_exists(caseId)' && items.has(id)) throw conditionalFailure();
      items.set(id, JSON.parse(JSON.stringify(p.Item)));
      return {};
    }),
    update: jest.fn(async (p: AWS.DynamoDB.DocumentClient.UpdateItemInput) => {
      const id = String(p.Key.caseId);
      const item = items.get(id);
      const v = p.ExpressionAttributeValues ?? {};
      if (p.UpdateExpression?.includes('#excluded')) {
        if (!item) throw conditionalFailure();
        const next: Record<string, unknown> = { ...item };
        if (':excluded' in v) next.excluded = v[':excluded'];
        else delete next.excluded;
        items.set(id, next);
        return { Attributes: next };
      }
      if (!item || item.version !== v[':expected']) throw conditionalFailure();
      const next: Record<string, unknown> = { ...item, labels: v[':labels'], labeller: v[':labeller'], labelledAt: v[':labelledAt'], version: v[':next'] };
      if (':notes' in v) next.notes = v[':notes'];
      else delete next.notes;
      items.set(id, next);
      return { Attributes: next };
    }),
    query: jest.fn(async (p: AWS.DynamoDB.DocumentClient.QueryInput) => {
      const surface = p.ExpressionAttributeValues?.[':surface'];
      const all = [...items.values()].filter((i) => i.surface === surface).sort((a, b) => String(a.caseId).localeCompare(String(b.caseId)));
      const start = p.ExclusiveStartKey ? all.findIndex((i) => i.caseId === p.ExclusiveStartKey?.caseId) + 1 : 0;
      const page = all.slice(start, start + pageSize);
      const more = start + pageSize < all.length;
      return { Items: page, ...(more ? { LastEvaluatedKey: { caseId: page[page.length - 1].caseId, surface } } : {}) };
    }),
  };
  return { db, items };
}

function agentCase(id: string): GoldenCase {
  return newGoldenCase({ surface: 'agent', taskType: 'fp_catalogue', sourceId: id, seedSource: 'fp_catalogue:ENG-47', now: NOW });
}

describe('goldenSetStore (ENG-2135)', () => {
  describe('not provisioned (EVAL_GOLDEN_CASES_TABLE unset)', () => {
    it('reports not provisioned and throws a clear error on every read and write without touching DynamoDB', async () => {
      const { db } = fakeDb();
      const store = createGoldenSetStore({ tableName: null, db });
      expect(store.isProvisioned()).toBe(false);
      expect(store.tableName).toBeNull();
      await expect(store.createCase(agentCase('s1'))).rejects.toBeInstanceOf(GoldenSetStoreNotProvisionedError);
      await expect(store.saveLabels('x', { labels: {}, expectedVersion: 0 }, 'a@b.c')).rejects.toThrow(/not provisioned.*EVAL_GOLDEN_CASES_TABLE/);
      await expect(store.getCase('x')).rejects.toBeInstanceOf(GoldenSetStoreNotProvisionedError);
      await expect(store.listCases('agent')).rejects.toBeInstanceOf(GoldenSetStoreNotProvisionedError);
      expect(db.get).not.toHaveBeenCalled();
      expect(db.put).not.toHaveBeenCalled();
      expect(db.update).not.toHaveBeenCalled();
      expect(db.query).not.toHaveBeenCalled();
    });

    it('reads the table name from the environment, blank meaning unset', () => {
      expect(resolveGoldenCasesTable({})).toBeNull();
      expect(resolveGoldenCasesTable({ EVAL_GOLDEN_CASES_TABLE: '  ' })).toBeNull();
      expect(resolveGoldenCasesTable({ EVAL_GOLDEN_CASES_TABLE: 'Dev-AW-EvalGoldenCases' })).toBe('Dev-AW-EvalGoldenCases');
      expect(() => resolveGoldenCasesTable({ EVAL_GOLDEN_CASES_TABLE: 'bad name!' })).toThrow(/not a valid DynamoDB table name/);
      expect(goldenSetStoreFromEnv({}).isProvisioned()).toBe(false);
      expect(goldenSetStoreFromEnv({ EVAL_GOLDEN_CASES_TABLE: 'AW-EvalGoldenCases' }).tableName).toBe('AW-EvalGoldenCases');
    });
  });

  it('creates a case once and never overwrites an existing one or its labels', async () => {
    const { db, items } = fakeDb();
    const store = createGoldenSetStore({ tableName: 'T', db });
    const c = agentCase('s1');
    expect(await store.createCase(c)).toBe('created');
    await store.saveLabels(c.caseId, { labels: { task_success: 'fail' }, expectedVersion: 0 }, 'matt@example.com', NOW);
    expect(await store.createCase(c)).toBe('exists');
    expect(items.get(c.caseId)?.labels).toEqual({ task_success: 'fail' });
    expect(db.put.mock.calls[0][0]).toMatchObject({ TableName: 'T', ConditionExpression: 'attribute_not_exists(caseId)' });
  });

  it('refuses to seed an invalid case', async () => {
    const { db } = fakeDb();
    const store = createGoldenSetStore({ tableName: 'T', db });
    await expect(store.createCase({ ...agentCase('s1'), criteria: [] })).rejects.toThrow(/criteria/);
    expect(db.put).not.toHaveBeenCalled();
  });

  it('saves labels with optimistic concurrency, bumping the version and recording the labeller', async () => {
    const { db } = fakeDb();
    const store = createGoldenSetStore({ tableName: 'T', db });
    const c = agentCase('s1');
    await store.createCase(c);
    const saved = await store.saveLabels(c.caseId, { labels: { task_success: 'pass', groundedness: 'na' }, notes: ' ok ', expectedVersion: 0 }, 'matt@example.com', NOW);
    expect(saved).toMatchObject({ version: 1, labels: { task_success: 'pass', groundedness: 'na' }, notes: 'ok', labeller: 'matt@example.com', labelledAt: NOW.toISOString() });

    await expect(store.saveLabels(c.caseId, { labels: {}, expectedVersion: 0 }, 'other@example.com')).rejects.toBeInstanceOf(GoldenCaseVersionConflictError);
    await expect(store.saveLabels('agent#sessionId#missing', { labels: {}, expectedVersion: 0 }, 'x')).rejects.toBeInstanceOf(GoldenCaseVersionConflictError);

    const cleared = await store.saveLabels(c.caseId, { labels: { task_success: 'fail' }, expectedVersion: 1 }, 'matt@example.com', NOW);
    expect(cleared.version).toBe(2);
    expect(cleared.notes).toBeUndefined();
    expect(db.update.mock.calls[2][0].UpdateExpression).toContain('REMOVE #notes');
  });

  it('lists a surface through SurfaceIndex across pages, filtering by split and skipping invalid rows', async () => {
    const { db, items } = fakeDb(2);
    const store = createGoldenSetStore({ tableName: 'T', db });
    const cases = ['a', 'b', 'c', 'd', 'e'].map(agentCase);
    for (const c of cases) await store.createCase(c);
    await store.createCase(newGoldenCase({ surface: 'creative', taskType: 'creative_image', sourceId: 'k', seedSource: 's', now: NOW }));
    items.set('agent#sessionId#broken', { caseId: 'agent#sessionId#broken', surface: 'agent' });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    const all = await store.listCases('agent');
    expect(all.map((c) => c.caseId).sort()).toEqual(cases.map((c) => c.caseId).sort());
    expect(db.query.mock.calls[0][0]).toMatchObject({ TableName: 'T', IndexName: SURFACE_INDEX });
    expect(db.query.mock.calls.length).toBeGreaterThan(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('agent#sessionId#broken'));

    const test = await store.listCases('agent', { split: 'test' });
    expect(test.map((c) => c.caseId).sort()).toEqual(cases.filter((c) => c.split === 'test').map((c) => c.caseId).sort());
    warn.mockRestore();
  });

  it('excludes a case and restores it, leaving its labels and version alone (ENG-2608)', async () => {
    const { db } = fakeDb();
    const store = createGoldenSetStore({ tableName: 'T', db });
    const kept = agentCase('kept');
    const empty = agentCase('empty');
    await store.createCase(kept);
    await store.createCase(empty);
    await store.saveLabels(empty.caseId, { labels: { task_success: 'fail' }, expectedVersion: 0 }, 'a@example.com', NOW);

    const exclusion = { reason: 'empty_session', by: 'admin@example.com', at: NOW.toISOString() };
    const excluded = await store.setExclusion(empty.caseId, exclusion);
    expect(excluded).toMatchObject({ excluded: exclusion, labels: { task_success: 'fail' }, version: 1 });
    expect((await store.listCases('agent')).map((c) => c.caseId)).toEqual([kept.caseId]);
    expect((await store.listCases('agent', { includeExcluded: true })).map((c) => c.caseId).sort()).toEqual([empty.caseId, kept.caseId].sort());
    expect(await store.getCase(empty.caseId)).toMatchObject({ excluded: exclusion });

    const restored = await store.setExclusion(empty.caseId, null);
    expect(restored).not.toHaveProperty('excluded');
    expect((await store.listCases('agent')).map((c) => c.caseId).sort()).toEqual([empty.caseId, kept.caseId].sort());
    await expect(store.setExclusion('agent#sessionId#missing', exclusion)).rejects.toBeInstanceOf(GoldenCaseNotFoundError);
  });

  it('wraps a DocumentClient, passing params through and awaiting .promise()', async () => {
    const promise = (value: unknown) => ({ promise: () => Promise.resolve(value) });
    const client = {
      get: jest.fn(() => promise({ Item: { caseId: 'x' } })),
      put: jest.fn(() => promise({})),
      update: jest.fn(() => promise({ Attributes: {} })),
      query: jest.fn(() => promise({ Items: [] })),
    };
    const db = documentClientDb(client as unknown as DocClient);
    await expect(db.get({ TableName: 'T', Key: { caseId: 'x' } })).resolves.toEqual({ Item: { caseId: 'x' } });
    await db.query({ TableName: 'T', KeyConditionExpression: 'a = :a' });
    expect(client.get).toHaveBeenCalledWith({ TableName: 'T', Key: { caseId: 'x' } });
    expect(client.query).toHaveBeenCalledWith({ TableName: 'T', KeyConditionExpression: 'a = :a' });
  });
});
