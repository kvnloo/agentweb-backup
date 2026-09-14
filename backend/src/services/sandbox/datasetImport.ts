import { readDatasetFile } from './datasetFiles';
import AWS from 'aws-sdk';
import { createHash } from 'crypto';
import { realpath } from 'fs/promises';
import path from 'path';
import { getSandboxDatasetStore, validateDataset } from './sandboxDatasetStore';
import type { SandboxDataset } from './types';

/** Upload content-addressed seed assets first, then atomically publish the dataset's manifest.
 * Account reset/purge never deletes this shared immutable prefix. No packet paths are trusted. */
export async function importSandboxDataset(directory: string, actor: string, deps = {
  s3: new AWS.S3({ region: process.env.AWS_REGION || 'us-west-2' }),
  store: getSandboxDatasetStore(),
}) {
  if (typeof actor !== 'string' || !/^[A-Za-z0-9-]{1,100}$/.test(actor)) throw new Error('Dataset import requires an audit actor');
  const root = await realpath(directory);
  const dataset: SandboxDataset = JSON.parse(readDatasetFile(path.join(root, 'dataset.json')).toString('utf8'));
  validateDataset(dataset);
  validateReconciliation(dataset);
  if (!Array.isArray(dataset.assetsManifest) || dataset.assetsManifest.length > 256) throw new Error('Compiled assets manifest is required');
  const assets: Array<{ key: string; bytes: Buffer }> = [];
  let totalBytes = 0;
  for (const asset of dataset.assetsManifest) {
    if (!asset || typeof asset.assetKey !== 'string' || !/^assets\/[a-f0-9]{64}\.png$/.test(asset.assetKey) ||
        !/^[a-f0-9]{64}$/.test(asset.sha256) || !Number.isSafeInteger(asset.bytes) || asset.bytes < 1) throw new Error('Invalid compiled asset manifest');
    const file = await realpath(path.join(root, asset.assetKey));
    if (!file.startsWith(root + path.sep)) throw new Error('Compiled asset escapes dataset directory');
    const bytes = readDatasetFile(file);
    totalBytes += bytes.length;
    if (totalBytes > 64 * 1024 * 1024) throw new Error('Dataset asset byte limit exceeded');
    if (bytes.length !== asset.bytes || createHash('sha256').update(bytes).digest('hex') !== asset.sha256 ||
        path.basename(asset.assetKey, '.png') !== asset.sha256) throw new Error('Compiled asset integrity mismatch');
    assets.push({ key: asset.assetKey, bytes });
  }
  // Check the immutable version before external writes. putDataset still uses conditional writes.
  if (await deps.store.loadDatasetSummary(dataset.meta.datasetId, dataset.meta.version)) throw new Error('Dataset version already exists');
  for (const asset of assets) {
    await deps.s3.putObject({ Bucket: process.env.AWS_S3_BUCKET || 'agentweb-user-files',
      Key: `sandbox-datasets/${dataset.meta.datasetId}/${dataset.meta.version}/${asset.key}`,
      Body: asset.bytes, ContentType: 'image/png', CacheControl: 'private, no-store', ACL: 'private',
    }).promise();
  }
  return deps.store.putDataset(dataset, actor);
}

/** periodRows and packetManifestSha256 are compiler-only provenance: the source
 * exports are intentionally absent from an import. Only daily totals are derivable. */
export function validateReconciliation(dataset: SandboxDataset): void {
  const r = dataset.reconciliation;
  const fail = (): never => { throw new Error('Invalid or stale compiled reconciliation'); };
  if (!r || typeof r !== 'object' || r.dailyRows !== dataset.insightsDaily.length ||
      !Number.isSafeInteger(r.periodRows) || r.periodRows < 1 || typeof r.packetManifestSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(r.packetManifestSha256) || !r.totals || typeof r.totals !== 'object') fail();
  const totals: Record<string, number> = { spend: 0, impressions: 0, clicks: 0, inline_link_clicks: 0,
    reported_leads: 0, reported_complete_registrations: 0, reported_purchases: 0 };
  const add = (key: string, value: unknown) => {
    if (!Number.isSafeInteger(value) || Number(value) < 0 || !Number.isSafeInteger(totals[key] + Number(value))) fail();
    totals[key] += Number(value);
  };
  for (const row of dataset.insightsDaily) {
    for (const key of ['spend', 'impressions', 'clicks', 'inline_link_clicks'] as const) add(key, row[key]);
    if (!Array.isArray(row.actions)) fail();
    const actions = new Map<string, number>();
    for (const action of row.actions) {
      if (!action || typeof action.action_type !== 'string' || actions.has(action.action_type) || !Number.isSafeInteger(action.value) || action.value < 0) fail();
      actions.set(action.action_type, action.value);
    }
    for (const [key, action] of [['reported_leads', 'lead'], ['reported_complete_registrations', 'offsite_conversion.fb_pixel_complete_registration'], ['reported_purchases', 'purchase']]) {
      add(key, actions.get(action));
    }
  }
  for (const [key, total] of Object.entries(totals)) if (r!.totals[key] !== total) fail();
}
