import { createHash } from 'crypto';
import { SandboxDatasetStore, SandboxDatasetExists, SandboxDatasetInvalid, DATASET_CHUNK_CHARS } from '../../services/sandbox/sandboxDatasetStore';
import { buildFixtureDataset, FIXTURE_ACCOUNT_ID } from './fixtures/fixtureDataset';

/**
 * ENG-1906 decision 7: the frozen dataset lives as immutable chunked items in the existing
 * AW-Evaluations table (no new table). Versions are write-once; reads verify integrity.
 */
function fakeDb() {
  const items = new Map<string, any>();
  const put = jest.fn((params: any) => ({ promise: async () => {
    if (params.ConditionExpression === 'attribute_not_exists(evaluationKey)' && items.has(params.Item.evaluationKey)) {
      throw Object.assign(new Error('The conditional request failed'), { code: 'ConditionalCheckFailedException' });
    }
    items.set(params.Item.evaluationKey, params.Item); return {};
  } }));
  const get = jest.fn((params: any) => ({ promise: async () => ({ Item: items.get(params.Key.evaluationKey) }) }));
  return { db: { put, get } as any, items, put, get };
}

describe('sandbox dataset store', () => {
  it('rejects a structurally invalid dataset before writing anything', async () => {
    const { db, put } = fakeDb();
    const store = new SandboxDatasetStore(db);
    const broken = buildFixtureDataset();
    broken.ads[0].adset_id = '999';
    await expect(store.putDataset(broken)).rejects.toBeInstanceOf(SandboxDatasetInvalid);
    const alien = buildFixtureDataset();
    alien.campaigns[0].account_id = '1';
    await expect(store.putDataset(alien)).rejects.toBeInstanceOf(SandboxDatasetInvalid);
    const nonNumeric = buildFixtureDataset();
    nonNumeric.campaigns[0].id = 'CAMPAIGN_01';
    await expect(store.putDataset(nonNumeric)).rejects.toBeInstanceOf(SandboxDatasetInvalid);
    const outside = buildFixtureDataset();
    outside.insightsDaily[0].date = '2026-05-01';
    await expect(store.putDataset(outside)).rejects.toBeInstanceOf(SandboxDatasetInvalid);
    expect(put).not.toHaveBeenCalled();
  });

  it('writes an immutable version as chunks + meta, and refuses to overwrite it', async () => {
    const { db, items, put } = fakeDb();
    const store = new SandboxDatasetStore(db);
    const dataset = buildFixtureDataset();
    const result = await store.putDataset(dataset);
    const json = JSON.stringify(dataset);
    expect(result).toMatchObject({ datasetId: 'fixture-agentweb', version: 1, bytes: Buffer.byteLength(json), sha256: createHash('sha256').update(json).digest('hex') });
    expect(result.chunkCount).toBe(Math.ceil(json.length / DATASET_CHUNK_CHARS));
    expect(items.get('dataset/fixture-agentweb/1/meta')).toMatchObject({ datasetId: 'fixture-agentweb', version: 1, chunkCount: result.chunkCount,
      account: { account_id: FIXTURE_ACCOUNT_ID, currency: 'USD', name: 'AgentWeb Sandbox', timezone_name: 'UTC' } });
    const chunkPrefix = items.get('dataset/fixture-agentweb/1/meta').chunkPrefix;
    expect(chunkPrefix).toMatch(/^dataset\/fixture-agentweb\/1\/attempt\/[0-9a-f-]+\/chunk$/);
    for (let n = 0; n < result.chunkCount; n++) expect(items.has(`${chunkPrefix}/${n}`)).toBe(true);
    const metaPut = put.mock.calls.find(([p]) => p.Item.evaluationKey === 'dataset/fixture-agentweb/1/meta')![0];
    expect(metaPut.ConditionExpression).toBe('attribute_not_exists(evaluationKey)');
    // Every item stays inside the one approved table.
    expect(put.mock.calls.every(([p]) => p.TableName === 'AW-Evaluations')).toBe(true);
    await expect(store.putDataset(dataset)).rejects.toBeInstanceOf(SandboxDatasetExists);
  });

  it('chunks a large dataset and reassembles it byte-for-byte', async () => {
    const { db, items } = fakeDb();
    const store = new SandboxDatasetStore(db);
    const big = buildFixtureDataset();
    big.meta.approximations = [ 'x'.repeat(DATASET_CHUNK_CHARS * 2 + 17) ];
    const result = await store.putDataset(big);
    expect(result.chunkCount).toBeGreaterThanOrEqual(3);
    expect([...items.keys()].filter(k => k.includes('/chunk/'))).toHaveLength(result.chunkCount);
    const loaded = await store.loadDataset('fixture-agentweb', 1);
    expect(loaded).toEqual(big);
  });

  it('verifies the sha256 on load and refuses a corrupted chunk', async () => {
    const { db, items } = fakeDb();
    const store = new SandboxDatasetStore(db);
    await store.putDataset(buildFixtureDataset());
    const chunk = items.get(`${items.get('dataset/fixture-agentweb/1/meta').chunkPrefix}/0`);
    chunk.data = chunk.data.replace('"AgentWeb Sandbox"', '"Tampered Sandbox"');
    await expect(new SandboxDatasetStore(db).loadDataset('fixture-agentweb', 1)).rejects.toThrow(/integrity/i);
  });

  it('caches loaded versions in an LRU of eight and reads with strong consistency', async () => {
    const { db, get } = fakeDb();
    const store = new SandboxDatasetStore(db);
    for (let v = 1; v <= 9; v++) { const d = buildFixtureDataset(); d.meta.version = v; await store.putDataset(d); }
    get.mockClear();
    await store.loadDataset('fixture-agentweb', 1);
    const readsForFirstLoad = get.mock.calls.length;
    expect(readsForFirstLoad).toBeGreaterThan(0);
    expect(get.mock.calls.every(([p]) => p.ConsistentRead === true)).toBe(true);
    await store.loadDataset('fixture-agentweb', 1);
    expect(get.mock.calls.length).toBe(readsForFirstLoad); // cache hit, no new reads
    for (let v = 2; v <= 9; v++) await store.loadDataset('fixture-agentweb', v); // evicts version 1
    get.mockClear();
    await store.loadDataset('fixture-agentweb', 1);
    expect(get.mock.calls.length).toBeGreaterThan(0);
  });

  it('summary reads only the meta item; a missing version is null', async () => {
    const { db, get } = fakeDb();
    const store = new SandboxDatasetStore(db);
    await store.putDataset(buildFixtureDataset());
    get.mockClear();
    const summary = await store.loadDatasetSummary('fixture-agentweb', 1);
    expect(summary).toMatchObject({ account: { account_id: FIXTURE_ACCOUNT_ID, currency: 'USD' }, meta: { frozenWindow: { since: '2026-04-09', until: '2026-04-30' } } });
    expect(get).toHaveBeenCalledTimes(1);
    expect(await store.loadDatasetSummary('fixture-agentweb', 2)).toBeNull();
    await expect(store.loadDataset('fixture-agentweb', 2)).rejects.toThrow(/not found/i);
  });

  it('rejects dataset ids and versions that would escape the key space', async () => {
    const { db } = fakeDb();
    const store = new SandboxDatasetStore(db);
    await expect(store.loadDataset('../evaluation', 1)).rejects.toBeInstanceOf(SandboxDatasetInvalid);
    await expect(store.loadDataset('fixture', 0)).rejects.toBeInstanceOf(SandboxDatasetInvalid);
  });
});

it('publishes the manifest and privileged import audit in one transaction, failing closed on audit failure', async () => {
  const f = fakeDb();
  f.db.transactWrite = jest.fn(() => ({ promise: async () => { throw new Error('audit unavailable'); } }));
  const seed = buildFixtureDataset();
  await expect(new SandboxDatasetStore(f.db).putDataset(seed, 'admin')).rejects.toThrow('audit unavailable');
  const transaction = f.db.transactWrite.mock.calls[0][0].TransactItems;
  expect(transaction[0].Put.Item).toMatchObject({ kind: 'dataset', datasetId: seed.meta.datasetId });
  expect(transaction[1].Put.Item).toMatchObject({ actor: 'admin', action: 'load-dataset', outcome: 'published',
    sha256: createHash('sha256').update(JSON.stringify(seed)).digest('hex') });
  expect([...f.items.keys()].some(key => key.endsWith('/meta'))).toBe(false);
});

it('retries a failed privileged publication with a fresh chunk attempt', async () => {
  const f = fakeDb();
  const transactWrite = jest.fn()
    .mockImplementationOnce(() => ({ promise: async () => { throw new Error('audit unavailable'); } }))
    .mockImplementationOnce((request: any) => ({ promise: async () => {
      for (const item of request.TransactItems) f.items.set(item.Put.Item.evaluationKey, item.Put.Item);
    } }));
  f.db.transactWrite = transactWrite;
  const store = new SandboxDatasetStore(f.db);
  const seed = buildFixtureDataset();
  await expect(store.putDataset(seed, 'admin')).rejects.toThrow('audit unavailable');
  await expect(store.putDataset(seed, 'admin')).resolves.toMatchObject({ datasetId: seed.meta.datasetId, version: seed.meta.version });
  const chunkAttempts = new Set([...f.items.keys()].filter(key => key.includes('/attempt/')).map(key => key.split('/chunk/')[0]));
  expect(chunkAttempts.size).toBe(2);
  await expect(store.loadDataset(seed.meta.datasetId, seed.meta.version)).resolves.toEqual(seed);
});

// Data integrity: partial writes must not poison retries or expose unpublished data.
it('retries a partial chunk write and publishes only a complete attempt', async () => {
  const f = fakeDb();
  const originalPut = f.put.getMockImplementation()!;
  let chunks = 0;
  f.put.mockImplementation((request: any) => {
    if (request.Item.kind === 'dataset_chunk' && ++chunks === 2) {
      return { promise: async () => { throw new Error('chunk unavailable'); } };
    }
    return originalPut(request);
  });
  const seed = buildFixtureDataset();
  seed.meta.approximations = ['x'.repeat(DATASET_CHUNK_CHARS * 2)];
  const store = new SandboxDatasetStore(f.db);
  await expect(store.putDataset(seed)).rejects.toThrow('chunk unavailable');
  expect(await store.loadDatasetSummary(seed.meta.datasetId, 1)).toBeNull();
  await expect(store.loadDataset(seed.meta.datasetId, 1)).rejects.toThrow(/not found/);
  await store.putDataset(seed);
  await expect(store.loadDataset(seed.meta.datasetId, 1)).resolves.toEqual(seed);
});

it('continues reading immutable versions published with legacy chunk keys', async () => {
  const f = fakeDb();
  const seed = buildFixtureDataset();
  await new SandboxDatasetStore(f.db).putDataset(seed);
  const meta = f.items.get('dataset/fixture-agentweb/1/meta');
  for (let n = 0; n < meta.chunkCount; n++) {
    const oldKey = `${meta.chunkPrefix}/${n}`;
    f.items.set(`dataset/fixture-agentweb/1/chunk/${n}`, f.items.get(oldKey));
    f.items.delete(oldKey);
  }
  delete meta.chunkPrefix;
  await expect(new SandboxDatasetStore(f.db).loadDataset(seed.meta.datasetId, 1)).resolves.toEqual(seed);
});

it.each([null, [], true, '', 'dataset/other/1/attempt/123/chunk'])('rejects a malformed or cross-dataset chunk pointer %p on both read paths', async chunkPrefix => {
  const f = fakeDb();
  await new SandboxDatasetStore(f.db).putDataset(buildFixtureDataset());
  f.items.get('dataset/fixture-agentweb/1/meta').chunkPrefix = chunkPrefix;
  const store = new SandboxDatasetStore(f.db);
  await expect(store.loadDatasetSummary('fixture-agentweb', 1)).rejects.toThrow(/integrity/);
  await expect(store.loadDataset('fixture-agentweb', 1)).rejects.toThrow(/integrity/);
});

it('concurrent imports publish exactly one complete dataset and its matching audit', async () => {
  const f = fakeDb();
  f.db.transactWrite = jest.fn((request: any) => ({ promise: async () => {
    const puts = request.TransactItems.map((entry: any) => entry.Put);
    if (puts.some((put: any) => f.items.has(put.Item.evaluationKey))) {
      throw Object.assign(new Error('publication collision'), { code: 'TransactionCanceledException' });
    }
    // All conditions are checked before any transactional write becomes visible.
    for (const put of puts) {
      expect(put.ConditionExpression).toBe('attribute_not_exists(evaluationKey)');
      f.items.set(put.Item.evaluationKey, put.Item);
    }
  } }));
  const first = buildFixtureDataset(), second = buildFixtureDataset();
  first.meta.approximations = ['a'.repeat(DATASET_CHUNK_CHARS * 2)];
  second.meta.approximations = ['b'.repeat(DATASET_CHUNK_CHARS * 2)];
  const results = await Promise.allSettled([
    new SandboxDatasetStore(f.db).putDataset(first, 'first'),
    new SandboxDatasetStore(f.db).putDataset(second, 'second'),
  ]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
  const winner = results[0].status === 'fulfilled' ? first : second;
  const meta = f.items.get('dataset/fixture-agentweb/1/meta');
  const audit = f.items.get('dataset/fixture-agentweb/1/audit/import');
  expect(audit).toMatchObject({ sha256: meta.sha256, actor: winner === first ? 'first' : 'second' });
  await expect(new SandboxDatasetStore(f.db).loadDataset('fixture-agentweb', 1)).resolves.toEqual(winner);
});
