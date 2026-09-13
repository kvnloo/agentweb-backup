import { sandboxAdAccountId } from './sentinel';
import type { SandboxDataset } from './types';

/** Runtime account/asset projection. The immutable store and its seed checksum stay untouched. */
export function projectSandboxDataset(seed: SandboxDataset, userId: string, assetBaseUrl = `https://${process.env.AWS_S3_BUCKET || 'agentweb-user-files'}.s3.${process.env.AWS_REGION || 'us-west-2'}.amazonaws.com`): SandboxDataset {
  if (!/^eval_[A-Za-z0-9-]+$/.test(userId)) throw new Error('Expected sandbox principal');
  const accountId = sandboxAdAccountId(userId);
  const urls = new Map((seed.assetsManifest ?? []).map(asset => [
    `https://assets.example.invalid/${asset.assetKey}`,
    `${assetBaseUrl.replace(/\/$/, '')}/sandbox-datasets/${seed.meta.datasetId}/${seed.meta.version}/${asset.assetKey}`,
  ]));
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
