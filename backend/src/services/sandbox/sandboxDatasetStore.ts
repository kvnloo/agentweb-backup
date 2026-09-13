import AWS from 'aws-sdk';
import { createHash } from 'crypto';
import { isDay } from './dateShift';
import type { SandboxAccount, SandboxDataset, SandboxDatasetMeta } from './types';

/**
 * Frozen-dataset persistence (ENG-1906 decision 7): immutable, chunked versions inside the
 * existing AW-Evaluations table. No new table, no mutable rows — a version is written once
 * (every item conditional on absence) and verified by sha256 on every cold read.
 *
 *   dataset/<datasetId>/<version>/meta      summary: account, meta, counts, sha256, chunkCount
 *   dataset/<datasetId>/<version>/chunk/<n>  JSON slice n of the serialized dataset
 */
export const DATASET_CHUNK_CHARS = 100_000; // ≤ 300 KB even if every character is 3 bytes of UTF-8
const CACHE_MAX = 8;
const DATASET_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const NUMERIC_ID = /^\d{5,20}$/;

export class SandboxDatasetInvalid extends Error {
  constructor(message: string) { super(message); this.name = 'SandboxDatasetInvalid'; }
}
export class SandboxDatasetExists extends Error {
  constructor(datasetId: string, version: number) { super(`Dataset ${datasetId} v${version} already exists; versions are immutable`); this.name = 'SandboxDatasetExists'; }
}
export class SandboxDatasetNotFound extends Error {
  constructor(datasetId: string, version: number) { super(`Dataset ${datasetId} v${version} not found`); this.name = 'SandboxDatasetNotFound'; }
}

export interface DatasetSummary {
  datasetId: string;
  version: number;
  meta: SandboxDatasetMeta;
  account: SandboxAccount;
  counts: Record<string, number>;
  sha256: string;
  bytes: number;
  chunkCount: number;
  createdAt: string;
}

export interface PutDatasetResult { datasetId: string; version: number; bytes: number; sha256: string; chunkCount: number }

type Db = Pick<AWS.DynamoDB.DocumentClient, 'get' | 'put' | 'transactWrite'>;

export function validateDataset(dataset: SandboxDataset): void {
  const fail = (message: string): never => { throw new SandboxDatasetInvalid(message); };
  if (!dataset || typeof dataset !== 'object') fail('dataset must be an object');
  const { meta, account } = dataset;
  if (!meta || meta.schemaVersion !== 1) fail('meta.schemaVersion must be 1');
  if (!DATASET_ID_PATTERN.test(meta.datasetId)) fail('meta.datasetId must be lowercase alphanumeric/hyphen, ≤64 chars');
  if (!Number.isInteger(meta.version) || meta.version < 1) fail('meta.version must be a positive integer');
  if (!isDay(meta.frozenWindow?.since) || !isDay(meta.frozenWindow?.until) || meta.frozenWindow.since > meta.frozenWindow.until) fail('meta.frozenWindow must be a valid YYYY-MM-DD range');
  if (meta.dateShift !== 'anchor_until_to_yesterday_utc') fail('meta.dateShift must be anchor_until_to_yesterday_utc');
  if (!account || !NUMERIC_ID.test(account.account_id) || account.id !== `act_${account.account_id}`) fail('account.id must be act_<account_id> with a numeric account_id');
  for (const list of ['pages', 'pixels', 'customAudiences', 'campaigns', 'adsets', 'adcreatives', 'adimages', 'ads', 'insightsDaily', 'insightsBreakdownDaily', 'landers'] as const) {
    if (!Array.isArray(dataset[list])) fail(`${list} must be an array`);
  }
  const ids = new Set<string>();
  const checkId = (kind: string, id: string) => {
    if (!NUMERIC_ID.test(id)) fail(`${kind} id ${id} must be a numeric string`);
    if (ids.has(id)) fail(`duplicate object id ${id}`);
    ids.add(id);
  };
  const campaignIds = new Set<string>(), adsetIds = new Set<string>(), adIds = new Set<string>(), creativeIds = new Set<string>();
  for (const c of dataset.campaigns) {
    checkId('campaign', c.id); campaignIds.add(c.id);
    if (c.account_id !== account.account_id) fail(`campaign ${c.id} belongs to account ${c.account_id}, expected ${account.account_id}`);
    if (!c.name || !c.objective || !c.status) fail(`campaign ${c.id} needs name, objective and status`);
  }
  for (const a of dataset.adsets) {
    checkId('adset', a.id); adsetIds.add(a.id);
    if (a.account_id !== account.account_id) fail(`adset ${a.id} has a foreign account_id`);
    if (!campaignIds.has(a.campaign_id)) fail(`adset ${a.id} references unknown campaign ${a.campaign_id}`);
    if (!a.optimization_goal || !a.billing_event || !a.targeting) fail(`adset ${a.id} needs optimization_goal, billing_event and targeting`);
  }
  for (const c of dataset.adcreatives) {
    checkId('creative', c.id); creativeIds.add(c.id);
    if (c.account_id !== account.account_id) fail(`creative ${c.id} has a foreign account_id`);
  }
  for (const ad of dataset.ads) {
    checkId('ad', ad.id); adIds.add(ad.id);
    if (ad.account_id !== account.account_id) fail(`ad ${ad.id} has a foreign account_id`);
    const adset = dataset.adsets.find((a) => a.id === ad.adset_id);
    if (!adset) fail(`ad ${ad.id} references unknown adset ${ad.adset_id}`);
    if (adset!.campaign_id !== ad.campaign_id) fail(`ad ${ad.id} campaign_id disagrees with its adset`);
    if (!creativeIds.has(ad.creative?.id)) fail(`ad ${ad.id} references unknown creative ${ad.creative?.id}`);
  }
  for (const p of dataset.pixels) { checkId('pixel', p.id); if (!Array.isArray(p.statsByDay)) fail(`pixel ${p.id} needs statsByDay`); }
  for (const p of dataset.pages) checkId('page', p.id);
  for (const a of dataset.customAudiences) checkId('audience', a.id);
  const rowChecks = (rows: Array<{ date: string; ad_id: string; adset_id: string; campaign_id: string; impressions: number; spend: number }>, label: string) => {
    for (const row of rows) {
      if (!isDay(row.date) || row.date < meta.frozenWindow.since || row.date > meta.frozenWindow.until) fail(`${label} row on ${row.date} is outside the frozen window`);
      if (!adIds.has(row.ad_id)) fail(`${label} row references unknown ad ${row.ad_id}`);
      const ad = dataset.ads.find((a) => a.id === row.ad_id)!;
      if (ad.adset_id !== row.adset_id || ad.campaign_id !== row.campaign_id) fail(`${label} row for ad ${row.ad_id} disagrees with the ad's hierarchy`);
      if (!Number.isFinite(row.impressions) || row.impressions < 0 || !Number.isInteger(row.spend) || row.spend < 0) fail(`${label} row for ad ${row.ad_id} has invalid impressions/spend (spend is integer minor units)`);
    }
  };
  rowChecks(dataset.insightsDaily, 'insightsDaily');
  rowChecks(dataset.insightsBreakdownDaily, 'insightsBreakdownDaily');
  for (const lander of dataset.landers) {
    if (!/^https?:\/\//.test(lander.url)) fail(`lander url ${lander.url} must be absolute`);
    for (const pixelId of lander.pixelIds) if (!dataset.pixels.some((p) => p.id === pixelId)) fail(`lander ${lander.url} references unknown pixel ${pixelId}`);
  }
}

/** Splits without cutting a UTF-16 surrogate pair in half (DynamoDB rejects lone surrogates). */
export function chunkString(text: string, size: number): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + size, text.length);
    if (end < text.length) { const code = text.charCodeAt(end - 1); if (code >= 0xd800 && code <= 0xdbff) end -= 1; }
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

export class SandboxDatasetStore {
  private prefix = process.env.NODE_ENV === 'development' ? 'Dev-' : '';
  private table = `${this.prefix}AW-Evaluations`;
  private cache = new Map<string, SandboxDataset>();

  constructor(private db: Db = new AWS.DynamoDB.DocumentClient({ region: process.env.AWS_REGION || 'us-west-2' })) {}

  private keyPrefix(datasetId: string, version: number): string {
    if (typeof datasetId !== 'string' || !DATASET_ID_PATTERN.test(datasetId)) throw new SandboxDatasetInvalid(`invalid datasetId ${String(datasetId)}`);
    if (!Number.isInteger(version) || version < 1) throw new SandboxDatasetInvalid(`invalid version ${String(version)}`);
    return `dataset/${datasetId}/${version}`;
  }

  async putDataset(dataset: SandboxDataset, actor?: string): Promise<PutDatasetResult> {
    validateDataset(dataset);
    if (actor !== undefined && (typeof actor !== 'string' || !/^[A-Za-z0-9-]{1,100}$/.test(actor))) throw new SandboxDatasetInvalid('invalid import audit actor');
    const { datasetId, version } = dataset.meta;
    const prefix = this.keyPrefix(datasetId, version);
    if (await this.readMeta(prefix)) throw new SandboxDatasetExists(datasetId, version);
    const json = JSON.stringify(dataset);
    const sha256 = createHash('sha256').update(json).digest('hex');
    const bytes = Buffer.byteLength(json);
    const chunks = chunkString(json, DATASET_CHUNK_CHARS);
    const createdAt = new Date().toISOString();
    const condition = { ConditionExpression: 'attribute_not_exists(evaluationKey)' };
    try {
      for (let n = 0; n < chunks.length; n++) {
        await this.db.put({ TableName: this.table, Item: { evaluationKey: `${prefix}/chunk/${n}`, kind: 'dataset_chunk', datasetId, version, chunk: n, data: chunks[n] }, ...condition }).promise();
      }
      const summary: DatasetSummary = {
        datasetId, version, meta: dataset.meta, account: dataset.account, sha256, bytes, chunkCount: chunks.length, createdAt,
        counts: {
          pages: dataset.pages.length, pixels: dataset.pixels.length, customAudiences: dataset.customAudiences.length, campaigns: dataset.campaigns.length,
          adsets: dataset.adsets.length, ads: dataset.ads.length, adcreatives: dataset.adcreatives.length, adimages: dataset.adimages.length,
          insightsDaily: dataset.insightsDaily.length, insightsBreakdownDaily: dataset.insightsBreakdownDaily.length, landers: dataset.landers.length,
        },
      };
      const metadata = { TableName: this.table, Item: { evaluationKey: `${prefix}/meta`, kind: 'dataset', ...summary }, ...condition };
      if (actor) {
        // Publication and privileged-import audit succeed atomically; a failed audit
        // cannot leave a published dataset with no accountable actor.
        await this.db.transactWrite({ TransactItems: [
          { Put: metadata },
          { Put: { TableName: this.table, Item: { evaluationKey: `${prefix}/audit/import`,
            actor, action: 'load-dataset', at: createdAt, datasetId, version, sha256, bytes, outcome: 'published',
          }, ...condition } },
        ] }).promise();
      } else await this.db.put(metadata).promise();
    } catch (error: any) {
      if (error?.code === 'ConditionalCheckFailedException' || error?.name === 'ConditionalCheckFailedException') throw new SandboxDatasetExists(datasetId, version);
      throw error;
    }
    return { datasetId, version, bytes, sha256, chunkCount: chunks.length };
  }

  private async readMeta(prefix: string): Promise<(DatasetSummary & { evaluationKey: string }) | null> {
    const result = await this.db.get({ TableName: this.table, Key: { evaluationKey: `${prefix}/meta` }, ConsistentRead: true }).promise();
    return (result.Item as (DatasetSummary & { evaluationKey: string }) | undefined) ?? null;
  }

  async loadDatasetSummary(datasetId: string, version: number): Promise<DatasetSummary | null> {
    const item = await this.readMeta(this.keyPrefix(datasetId, version));
    if (!item) return null;
    const { evaluationKey: _key, ...summary } = item;
    return summary as DatasetSummary;
  }

  async loadDataset(datasetId: string, version: number): Promise<SandboxDataset> {
    const prefix = this.keyPrefix(datasetId, version);
    const cached = this.cache.get(prefix);
    if (cached) { this.cache.delete(prefix); this.cache.set(prefix, cached); return cached; }
    const meta = await this.readMeta(prefix);
    if (!meta) throw new SandboxDatasetNotFound(datasetId, version);
    const parts: string[] = [];
    for (let n = 0; n < meta.chunkCount; n++) {
      const result = await this.db.get({ TableName: this.table, Key: { evaluationKey: `${prefix}/chunk/${n}` }, ConsistentRead: true }).promise();
      const data = (result.Item as { data?: unknown } | undefined)?.data;
      if (typeof data !== 'string') throw new Error(`Dataset ${datasetId} v${version} failed integrity check: chunk ${n} missing`);
      parts.push(data);
    }
    const json = parts.join('');
    const sha256 = createHash('sha256').update(json).digest('hex');
    if (sha256 !== meta.sha256) throw new Error(`Dataset ${datasetId} v${version} failed integrity check: sha256 mismatch`);
    const dataset = JSON.parse(json) as SandboxDataset;
    this.cache.set(prefix, dataset);
    if (this.cache.size > CACHE_MAX) this.cache.delete(this.cache.keys().next().value as string);
    return dataset;
  }
}

let singleton: SandboxDatasetStore | undefined;
export function getSandboxDatasetStore(): SandboxDatasetStore {
  if (!singleton) singleton = new SandboxDatasetStore();
  return singleton;
}
