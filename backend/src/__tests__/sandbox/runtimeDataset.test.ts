import { createHash } from 'crypto';
import { projectSandboxDataset } from '../../services/sandbox/runtimeDataset';
import { createMetaSimulator } from '../../services/sandbox/metaSimulator';
import { sandboxAdAccountId } from '../../services/sandbox/sentinel';
import { EMPTY_OVERLAY } from '../../services/sandbox/types';
import { buildFixtureDataset } from './fixtures/fixtureDataset';

it('serves the provisioned principal account and preserves immutable seed bytes', async () => {
  const seed = buildFixtureDataset(), before = JSON.stringify(seed);
  const projected = await projectSandboxDataset(seed, 'eval_candidate');
  const id = sandboxAdAccountId('eval_candidate');
  const sim = createMetaSimulator({ loadPolicy: async () => ({ datasetId: seed.meta.datasetId, datasetVersion: 1 }), loadDataset: async () => projected, loadOverlay: async () => EMPTY_OVERLAY });
  const response = await sim.handle({ userId: 'eval_candidate', token: 'sbx.eval_candidate.0123456789abcdef01234567', method: 'GET', version: 'v25.0', path: `act_${id}/campaigns`, query: { fields: 'id,account_id' } });
  expect(response.status).toBe(200);
  expect(JSON.parse(response.body).data[0].account_id).toBe(id);
  expect(projected.account.id).toBe(`act_${id}`);
  expect(createHash('sha256').update(JSON.stringify(seed)).digest('hex')).toBe(createHash('sha256').update(before).digest('hex'));
});
it('projects seeded asset URLs onto the uploaded dataset prefix including nested creative fields', async () => {
  const seed = buildFixtureDataset();
  seed.assetsManifest = [{ assetKey: `assets/${'a'.repeat(64)}.png`, sourcePath: 'a.png', sha256: 'a'.repeat(64), bytes: 10, width: 1, height: 1 }];
  seed.adcreatives[0].image_url = `https://assets.example.invalid/assets/${'a'.repeat(64)}.png`;
  seed.adcreatives[0].object_story_spec = { link_data: { picture: seed.adcreatives[0].image_url } };
  const sign = jest.fn(async key => `https://private.invalid/${key}?signed=temporary`);
  const projected = await projectSandboxDataset(seed, 'eval_candidate', sign);
  const url = `https://private.invalid/sandbox-datasets/${seed.meta.datasetId}/1/assets/${'a'.repeat(64)}.png?signed=temporary`;
  expect(projected.adcreatives[0].image_url).toBe(url);
  expect(projected.adcreatives[0].object_story_spec).toEqual({ link_data: { picture: url } });
  expect(seed.adcreatives[0].image_url).toBe(`https://assets.example.invalid/assets/${'a'.repeat(64)}.png`);
});

it('rejects cross-prefix asset keys before signing', async () => {
  const seed = buildFixtureDataset();
  seed.assetsManifest = [{ assetKey: '../../users/private.png', sourcePath: 'a.png', sha256: 'a'.repeat(64), bytes: 10, width: 1, height: 1 }];
  const sign = jest.fn();
  await expect(projectSandboxDataset(seed, 'eval_candidate', sign)).rejects.toThrow();
  expect(sign).not.toHaveBeenCalled();
});

it('refreshes asset signatures on each runtime projection and propagates signing failures', async () => {
  const seed = buildFixtureDataset();
  const key = `assets/${'a'.repeat(64)}.png`;
  seed.assetsManifest = [{ assetKey: key, sourcePath: 'a.png', sha256: 'a'.repeat(64), bytes: 10, width: 1, height: 1 }];
  seed.adcreatives[0].image_url = `https://assets.example.invalid/${key}`;
  const sign = jest.fn().mockResolvedValueOnce('https://private.invalid/first').mockResolvedValueOnce('https://private.invalid/second').mockRejectedValueOnce(new Error('credentials unavailable'));
  expect((await projectSandboxDataset(seed, 'eval_candidate', sign)).adcreatives[0].image_url).toBe('https://private.invalid/first');
  expect((await projectSandboxDataset(seed, 'eval_candidate', sign)).adcreatives[0].image_url).toBe('https://private.invalid/second');
  await expect(projectSandboxDataset(seed, 'eval_candidate', sign)).rejects.toThrow('credentials unavailable');
});
