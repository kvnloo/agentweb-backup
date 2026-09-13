import AWS from 'aws-sdk';
import { createHash } from 'crypto';
import { readFile, realpath } from 'fs/promises';
import path from 'path';
import { getSandboxDatasetStore, validateDataset } from './sandboxDatasetStore';
import type { SandboxDataset } from './types';

/** Upload content-addressed seed assets first, then atomically publish the dataset's manifest.
 * Account reset/purge never deletes this shared immutable prefix. No packet paths are trusted. */
export async function importSandboxDataset(directory: string, deps = {
  s3: new AWS.S3({ region: process.env.AWS_REGION || 'us-west-2' }),
  store: getSandboxDatasetStore(),
}) {
  const root = await realpath(directory);
  const dataset: SandboxDataset = JSON.parse(await readFile(path.join(root, 'dataset.json'), 'utf8'));
  validateDataset(dataset);
  if (!Array.isArray(dataset.assetsManifest)) throw new Error('Compiled assets manifest is required');
  const assets: Array<{ key: string; bytes: Buffer }> = [];
  for (const asset of dataset.assetsManifest) {
    if (!asset || typeof asset.assetKey !== 'string' || !/^assets\/[a-f0-9]{64}\.png$/.test(asset.assetKey) ||
        !/^[a-f0-9]{64}$/.test(asset.sha256) || !Number.isSafeInteger(asset.bytes) || asset.bytes < 1) throw new Error('Invalid compiled asset manifest');
    const file = await realpath(path.join(root, asset.assetKey));
    if (!file.startsWith(root + path.sep)) throw new Error('Compiled asset escapes dataset directory');
    const bytes = await readFile(file);
    if (bytes.length !== asset.bytes || createHash('sha256').update(bytes).digest('hex') !== asset.sha256 ||
        path.basename(asset.assetKey, '.png') !== asset.sha256) throw new Error('Compiled asset integrity mismatch');
    assets.push({ key: asset.assetKey, bytes });
  }
  // Check the immutable version before external writes. putDataset still uses conditional writes.
  if (await deps.store.loadDatasetSummary(dataset.meta.datasetId, dataset.meta.version)) throw new Error('Dataset version already exists');
  for (const asset of assets) {
    await deps.s3.putObject({ Bucket: process.env.AWS_S3_BUCKET || 'agentweb-user-files',
      Key: `sandbox-datasets/${dataset.meta.datasetId}/${dataset.meta.version}/${asset.key}`,
      Body: asset.bytes, ContentType: 'image/png', CacheControl: 'public, max-age=31536000, immutable', ACL: 'public-read',
    }).promise();
  }
  return deps.store.putDataset(dataset);
}
