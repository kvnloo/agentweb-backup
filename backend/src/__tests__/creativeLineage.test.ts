/**
 * ENG-2141 (ENG-2128 T9): creative lineage record + Meta publish stamping.
 */
import type AWS from 'aws-sdk';
import {
  collectCreativeMedia,
  creativeIdForS3Key,
  creativeIdForUrl,
  hashPrompt,
  readCreativeLineageConfig,
  recordGeneratedCreative,
  stampMetaAdCreated,
  stampMetaCreativeCreated,
  stampMetaImageUpload,
  stampMetaPublish,
  summarizeGates,
  type CreativeLineageDb,
  type CreativeLineageRecord,
} from '../services/creativeLineage';
import { evaluateCreativeGates } from '../services/creativeGates';

type Item = Record<string, unknown>;
type Values = Record<string, unknown>;

/** DocumentClient's set shape. aws-sdk is auto-mocked in tests (src/__mocks__), so build it directly. */
function stringSet(values: string[]): AWS.DynamoDB.DocumentClient.DynamoDbSet {
  return { wrapperName: 'Set', type: 'String', values } as AWS.DynamoDB.DocumentClient.DynamoDbSet;
}

function conditionFailed(): Error {
  return Object.assign(new Error('The conditional request failed'), { code: 'ConditionalCheckFailedException' });
}

function setValues(v: unknown): string[] {
  return (v as AWS.DynamoDB.DocumentClient.DynamoDbSet | undefined)?.values as string[] | undefined ?? [];
}

/**
 * In-memory stand-in for the lineage table. It interprets exactly the expressions the store
 * issues (and throws on anything else), so a change to an expression fails a test rather than
 * passing against a fake that ignores it.
 */
class FakeLineageTable implements CreativeLineageDb {
  readonly items = new Map<string, Item>();
  readonly calls: string[] = [];

  private checkCondition(item: Item | undefined, condition: string | undefined, values: Values): void {
    if (!condition) return;
    if (condition === 'attribute_not_exists(creativeId)') {
      if (item) throw conditionFailed();
    } else if (condition === 'attribute_exists(creativeId)') {
      if (!item) throw conditionFailed();
    } else if (condition === 'attribute_exists(creativeId) AND userId = :userId') {
      if (!item || item.userId !== values[':userId']) throw conditionFailed();
    } else {
      throw new Error(`fake: unsupported condition ${condition}`);
    }
  }

  async get(params: AWS.DynamoDB.DocumentClient.GetItemInput) {
    this.calls.push('get');
    const item = this.items.get(String(params.Key.creativeId));
    return item ? { Item: structuredClone(item) } : {};
  }

  async put(params: AWS.DynamoDB.DocumentClient.PutItemInput) {
    this.calls.push('put');
    const id = String(params.Item.creativeId);
    this.checkCondition(this.items.get(id), params.ConditionExpression, {});
    this.items.set(id, structuredClone(params.Item));
    return {};
  }

  async update(params: AWS.DynamoDB.DocumentClient.UpdateItemInput) {
    this.calls.push('update');
    const id = String(params.Key.creativeId);
    const values = params.ExpressionAttributeValues ?? {};
    const current = this.items.get(id);
    this.checkCondition(current, params.ConditionExpression, values);
    const item = structuredClone(current ?? { creativeId: id });
    const expr = params.UpdateExpression ?? '';
    const add = /^ADD (\w+) (:\w+) /.exec(expr);
    if (add) {
      const merged = new Set([...setValues(item[add[1]]), ...setValues(values[add[2]])]);
      item[add[1]] = stringSet([...merged]);
    }
    const set = expr.slice(expr.indexOf('SET ') + 4);
    for (const clause of set.split(/,\s*(?![^(]*\))/)) {
      const append = /^(\w+) = list_append\(if_not_exists\(\1, :empty\), (:\w+)\)$/.exec(clause.trim());
      const assign = /^(\w+) = (:\w+)$/.exec(clause.trim());
      if (append) item[append[1]] = [...((item[append[1]] as unknown[]) ?? []), ...(values[append[2]] as unknown[])];
      else if (assign) item[assign[1]] = values[assign[2]];
      else throw new Error(`fake: unsupported update clause ${clause}`);
    }
    this.items.set(id, item);
    return {};
  }

  async query(params: AWS.DynamoDB.DocumentClient.QueryInput) {
    this.calls.push('query');
    expect(params.IndexName).toBe('userId-createdAt-index');
    expect(params.KeyConditionExpression).toBe('userId = :userId AND createdAt >= :since');
    expect(params.FilterExpression).toBe('contains(#attr, :value)');
    const v = params.ExpressionAttributeValues ?? {};
    const attr = params.ExpressionAttributeNames?.['#attr'] ?? '';
    const Items = [...this.items.values()].filter(
      (i) => i.userId === v[':userId'] && String(i.createdAt) >= String(v[':since']) && setValues(i[attr]).includes(String(v[':value'])),
    );
    return { Items: structuredClone(Items) };
  }

  stringSet(values: string[]) {
    return stringSet(values);
  }

  record(id: string): CreativeLineageRecord {
    return this.items.get(id) as unknown as CreativeLineageRecord;
  }
}

const ON = { CREATIVE_LINEAGE_ENABLED: 'true', CREATIVE_LINEAGE_TABLE: 'Dev-AW-Creatives' };
const NOW = new Date('2026-09-25T12:00:00.000Z');
const USER = 'user-1';
const S3_KEY = 'users/user-1/files/1790000000000/abc123/ad.png';
const S3_URL = `https://agentweb-user-files.s3.us-west-2.amazonaws.com/${S3_KEY}`;
const PROMPT = 'A 4:5 ad for a leasing office, bold headline';

function generated(overrides: Partial<Parameters<typeof recordGeneratedCreative>[0]> = {}) {
  return { userId: USER, artifactUrl: S3_URL, sessionId: 'sess-1', category: 'ad', prompt: PROMPT, generatorModel: 'gemini-3-pro-image-preview', ...overrides };
}

describe('creative lineage config', () => {
  it('is off unless the flag is "true" AND a valid table name is set', () => {
    expect(readCreativeLineageConfig({}).tableName).toBeNull();
    expect(readCreativeLineageConfig({ CREATIVE_LINEAGE_TABLE: 'AW-Creatives' }).tableName).toBeNull();
    expect(readCreativeLineageConfig({ CREATIVE_LINEAGE_ENABLED: 'true' }).tableName).toBeNull();
    expect(readCreativeLineageConfig({ CREATIVE_LINEAGE_ENABLED: '1', CREATIVE_LINEAGE_TABLE: 'AW-Creatives' }).tableName).toBeNull();
    expect(readCreativeLineageConfig({ CREATIVE_LINEAGE_ENABLED: 'true', CREATIVE_LINEAGE_TABLE: 'bad name!' }).tableName).toBeNull();
    expect(readCreativeLineageConfig({ CREATIVE_LINEAGE_ENABLED: 'true', CREATIVE_LINEAGE_TABLE: ' AW-Creatives ' }).tableName).toBe('AW-Creatives');
  });
});

describe('creativeId resolution', () => {
  it('derives the id from the S3 key, for virtual-hosted, path-style and percent-encoded URLs alike', () => {
    const id = creativeIdForS3Key(S3_KEY);
    expect(id).toMatch(/^cr_[0-9a-f]{32}$/);
    expect(creativeIdForUrl(S3_URL)).toBe(id);
    expect(creativeIdForUrl(`https://s3.us-west-2.amazonaws.com/agentweb-user-files/${S3_KEY}`)).toBe(id);
    expect(creativeIdForUrl(S3_URL.replace('/abc123/', '/abc%31%323/'))).toBe(id);
  });

  it('resolves nothing for a URL that is not one of our S3 objects', () => {
    expect(creativeIdForUrl('https://scontent.xx.fbcdn.net/v/t45/ad.png')).toBeNull();
    expect(creativeIdForUrl('not a url')).toBeNull();
    expect(creativeIdForUrl(undefined)).toBeNull();
  });

  it('collects image refs from the single image, carousel cards and placement assets', () => {
    expect(collectCreativeMedia({
      image_hash: 'h1',
      carousel_cards: [{ image_url: 'u1' }, { image_hash: 'h2' }],
      placement_assets: [{ image_hash: 'h1' }, { image_url: 'u2' }],
    })).toEqual({ imageUrls: ['u1', 'u2'], imageHashes: ['h1', 'h2'] });
  });

  it('takes the hash over the URL on the same reference, as Meta does', () => {
    // A swap passing a new image_url while carrying the old image_hash still serves the old image.
    expect(collectCreativeMedia({ image_hash: 'old', image_url: 'new-url' })).toEqual({ imageUrls: [], imageHashes: ['old'] });
    expect(collectCreativeMedia({ carousel_cards: [{ image_hash: 'h', image_url: 'u' }] })).toEqual({ imageUrls: [], imageHashes: ['h'] });
  });
});

describe('recordGeneratedCreative', () => {
  it('is a no-op that touches no table when the flag is off', async () => {
    const db = new FakeLineageTable();
    const candidate = jest.fn();
    for (const env of [{}, { CREATIVE_LINEAGE_TABLE: 'AW-Creatives' }, { CREATIVE_LINEAGE_ENABLED: 'true' }]) {
      await expect(recordGeneratedCreative(generated(), candidate(), { env, db })).resolves.toBeNull();
    }
    await expect(stampMetaImageUpload({ userId: USER, imageUrl: S3_URL, imageHash: 'h' }, { env: {}, db })).resolves.toBeNull();
    await expect(stampMetaCreativeCreated({ userId: USER, accountId: 'a', metaCreativeId: 'c', params: { image_url: S3_URL } }, { env: {}, db })).resolves.toEqual([]);
    await expect(stampMetaAdCreated({ userId: USER, accountId: 'a', metaCreativeId: 'c', adId: 'ad' }, { env: {}, db })).resolves.toEqual([]);
    await expect(stampMetaPublish({ userId: USER, accountId: 'a', metaCreativeId: 'c', adId: 'ad', params: { image_url: S3_URL }, via: 'copy_ad' }, { env: {}, db })).resolves.toEqual([]);
    expect(db.calls).toEqual([]);
  });

  it('writes the record with a prompt hash (never the prompt), gate summary, and the human-eval candidate link', async () => {
    const db = new FakeLineageTable();
    const gates = evaluateCreativeGates(
      { bytes: 2048, decoded: true, width: 1024, height: 1024, format: 'png', luminanceStdDev: 30 },
      { requestedSize: '9:16' },
    );

    const id = await recordGeneratedCreative(
      generated({ gates }),
      Promise.resolve({ candidateId: 'cand-1' }),
      { env: ON, db, now: () => NOW },
    );

    expect(id).toBe(creativeIdForS3Key(S3_KEY));
    const record = db.record(id!);
    expect(record).toEqual({
      creativeId: id,
      userId: USER,
      s3Key: S3_KEY,
      artifactUrl: S3_URL,
      sessionId: 'sess-1',
      category: 'ad',
      promptHash: hashPrompt(PROMPT),
      generatorModel: 'gemini-3-pro-image-preview',
      gatesSummary: summarizeGates(gates),
      humanEvalCandidateId: 'cand-1',
      schemaVersion: 1,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    });
    expect(record.gatesSummary).toMatchObject({ passed: false, failedChecks: expect.arrayContaining(['aspect_ratio']) });
    expect(JSON.stringify(record)).not.toContain('leasing office');
  });

  it('keeps the first record when the same image is recorded twice, and skips non-S3 URLs', async () => {
    const db = new FakeLineageTable();
    await recordGeneratedCreative(generated(), undefined, { env: ON, db, now: () => NOW });
    const later = new Date(NOW.getTime() + 60_000);
    await expect(recordGeneratedCreative(generated({ sessionId: 'other' }), undefined, { env: ON, db, now: () => later }))
      .resolves.toBe(creativeIdForS3Key(S3_KEY));
    expect(db.record(creativeIdForS3Key(S3_KEY)).sessionId).toBe('sess-1');

    await expect(recordGeneratedCreative(generated({ artifactUrl: 'https://example.com/x.png' }), undefined, { env: ON, db }))
      .resolves.toBeNull();
    expect(db.items.size).toBe(1);
  });

  it('never throws: a DynamoDB failure resolves to null', async () => {
    const db = new FakeLineageTable();
    jest.spyOn(db, 'put').mockRejectedValue(new Error('ProvisionedThroughputExceeded'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(recordGeneratedCreative(generated(), undefined, { env: ON, db })).resolves.toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('publish stamping', () => {
  async function seeded(): Promise<{ db: FakeLineageTable; id: string }> {
    const db = new FakeLineageTable();
    const id = (await recordGeneratedCreative(generated(), undefined, { env: ON, db, now: () => NOW }))!;
    return { db, id };
  }
  const deps = (db: FakeLineageTable) => ({ env: ON, db, now: () => NOW });

  it('links generated image → uploaded hash → Meta creative → ad (the agent-mode sequence)', async () => {
    const { db, id } = await seeded();

    await expect(stampMetaImageUpload({ userId: USER, imageUrl: S3_URL, imageHash: 'hash-1' }, deps(db))).resolves.toBe(id);
    await expect(stampMetaCreativeCreated(
      { userId: USER, accountId: '1000', metaCreativeId: 'mc-1', params: { image_hash: 'hash-1' } },
      deps(db),
    )).resolves.toEqual([id]);
    await expect(stampMetaAdCreated({ userId: USER, accountId: '1000', metaCreativeId: 'mc-1', adId: 'ad-1' }, deps(db)))
      .resolves.toEqual([id]);

    const record = db.record(id);
    expect(setValues(record.metaImageHashes)).toEqual(['hash-1']);
    expect(setValues(record.metaCreativeIds)).toEqual(['mc-1']);
    expect(record.metaCreativeLinks).toEqual([
      { accountId: '1000', metaCreativeId: 'mc-1', imageHash: 'hash-1', via: 'create_creative', linkedAt: NOW.toISOString() },
    ]);
    expect(record.metaAdLinks).toEqual([
      { accountId: '1000', adId: 'ad-1', metaCreativeId: 'mc-1', imageHash: 'hash-1', via: 'create_ad', linkedAt: NOW.toISOString() },
    ]);

    // A retried create_ad for the same ad does not append a duplicate link.
    await stampMetaAdCreated({ userId: USER, accountId: '1000', metaCreativeId: 'mc-1', adId: 'ad-1' }, deps(db));
    expect(db.record(id).metaAdLinks).toHaveLength(1);
  });

  it('resolves a creative built straight from our S3 URL (no upload step)', async () => {
    const { db, id } = await seeded();
    await expect(stampMetaCreativeCreated(
      { userId: USER, accountId: '1000', metaCreativeId: 'mc-2', params: { carousel_cards: [{ image_url: S3_URL }] } },
      deps(db),
    )).resolves.toEqual([id]);
    expect(db.record(id).metaCreativeLinks).toEqual([
      { accountId: '1000', metaCreativeId: 'mc-2', via: 'create_creative', linkedAt: NOW.toISOString() },
    ]);
  });

  it('never links across users: another user\'s hash, URL or Meta creative id resolves to nothing', async () => {
    const { db, id } = await seeded();
    await stampMetaImageUpload({ userId: USER, imageUrl: S3_URL, imageHash: 'hash-1' }, deps(db));

    await expect(stampMetaImageUpload({ userId: 'intruder', imageUrl: S3_URL, imageHash: 'hash-x' }, deps(db))).resolves.toBeNull();
    await expect(stampMetaCreativeCreated({ userId: 'intruder', accountId: '9', metaCreativeId: 'mc-9', params: { image_hash: 'hash-1' } }, deps(db)))
      .resolves.toEqual([]);
    await expect(stampMetaCreativeCreated({ userId: 'intruder', accountId: '9', metaCreativeId: 'mc-9', params: { image_url: S3_URL } }, deps(db)))
      .resolves.toEqual([]);
    expect(setValues(db.record(id).metaImageHashes)).toEqual(['hash-1']);
    expect(db.record(id).metaCreativeLinks).toBeUndefined();
  });

  it('skips images the agent did not generate and images with no record', async () => {
    const { db } = await seeded();
    const otherKeyUrl = S3_URL.replace('abc123', 'zzz999');
    await expect(stampMetaImageUpload({ userId: USER, imageUrl: otherKeyUrl, imageHash: 'h' }, deps(db))).resolves.toBeNull();
    await expect(stampMetaCreativeCreated(
      { userId: USER, accountId: '1', metaCreativeId: 'mc', params: { image_url: 'https://scontent.xx.fbcdn.net/a.png', image_hash: 'unknown' } },
      deps(db),
    )).resolves.toEqual([]);
    await expect(stampMetaAdCreated({ userId: USER, accountId: '1', metaCreativeId: 'never-stamped', adId: 'ad' }, deps(db))).resolves.toEqual([]);
  });

  it('stamps creative and ad together for a copy/swap, without relying on the eventually consistent index', async () => {
    const { db, id } = await seeded();
    await stampMetaImageUpload({ userId: USER, imageUrl: S3_URL, imageHash: 'hash-1' }, deps(db));
    const query = jest.spyOn(db, 'query');

    await expect(stampMetaPublish(
      { userId: USER, accountId: '1000', metaCreativeId: 'mc-3', adId: 'ad-3', params: { image_url: S3_URL }, via: 'swap_creative' },
      deps(db),
    )).resolves.toEqual([id]);

    expect(query).not.toHaveBeenCalled();
    expect(db.record(id).metaAdLinks).toEqual([
      { accountId: '1000', adId: 'ad-3', metaCreativeId: 'mc-3', via: 'swap_creative', linkedAt: NOW.toISOString() },
    ]);
  });

  it('never throws from a stamp when DynamoDB fails', async () => {
    const { db } = await seeded();
    jest.spyOn(db, 'query').mockRejectedValue(new Error('boom'));
    jest.spyOn(db, 'update').mockRejectedValue(new Error('boom'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(stampMetaImageUpload({ userId: USER, imageUrl: S3_URL, imageHash: 'h' }, deps(db))).resolves.toBeNull();
    await expect(stampMetaCreativeCreated({ userId: USER, accountId: '1', metaCreativeId: 'mc', params: { image_hash: 'h' } }, deps(db))).resolves.toEqual([]);
    await expect(stampMetaAdCreated({ userId: USER, accountId: '1', metaCreativeId: 'mc', adId: 'ad' }, deps(db))).resolves.toEqual([]);
    warn.mockRestore();
  });
});
