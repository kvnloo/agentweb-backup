import AWS from 'aws-sdk';
import { sandboxAdAccountId } from './sentinel';
import type { SandboxDataset } from './types';

// Await credential resolution (including instance roles) before signing, as with
// other AWS SDK calls. Never fall back to an unsigned public URL.
const s3 = new AWS.S3({ region: process.env.AWS_REGION || 'us-west-2', signatureVersion: 'v4' });
const signDatasetAsset = (key: string) => s3.getSignedUrlPromise('getObject', {
  Bucket: process.env.AWS_S3_BUCKET || 'agentweb-user-files', Key: key, Expires: 900,
});

/** Runtime account/asset projection. The immutable store and its seed checksum stay untouched. */
export async function projectSandboxDataset(seed: SandboxDataset, userId: string, signAsset: (key: string) => Promise<string> = signDatasetAsset): Promise<SandboxDataset> {
  if (!/^eval_[A-Za-z0-9-]+$/.test(userId)) throw new Error('Expected sandbox principal');
  if ((seed.assetsManifest ?? []).some(asset => !asset || typeof asset.assetKey !== 'string' || !/^assets\/[a-f0-9]{64}\.png$/.test(asset.assetKey))) throw new Error('Invalid compiled asset key');
  const accountId = sandboxAdAccountId(userId);
  const urls = new Map<string, string>(await Promise.all((seed.assetsManifest ?? []).map(async asset => [
    `https://assets.example.invalid/${asset.assetKey}`,
    await signAsset(`sandbox-datasets/${seed.meta.datasetId}/${seed.meta.version}/${asset.assetKey}`),
  ] as const)));
  const project = (value: unknown, key?: string): unknown => {
    if (typeof value === 'string') {
      if (key === 'account_id' && value === seed.account.account_id) return accountId;
      return urls.get(value) ?? value;
    }
    if (Array.isArray(value)) return value.map(item => project(item));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, project(item, name)]));
    return value;
  };
  const dataset = project(seed) as SandboxDataset;
  dataset.account.id = `act_${accountId}`;
  dataset.account.account_id = accountId;
  return dataset;
}
