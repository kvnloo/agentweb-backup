import { createHash } from 'crypto';
import { projectSandboxDataset } from '../../services/sandbox/runtimeDataset';
import { createMetaSimulator } from '../../services/sandbox/metaSimulator';
import { sandboxAdAccountId } from '../../services/sandbox/sentinel';
import { EMPTY_OVERLAY } from '../../services/sandbox/types';
import { buildFixtureDataset } from './fixtures/fixtureDataset';

it('serves the provisioned principal account and preserves immutable seed bytes', async () => {
  const seed = buildFixtureDataset(), before = JSON.stringify(seed);
  const projected = projectSandboxDataset(seed, 'eval_candidate');
  const id = sandboxAdAccountId('eval_candidate');
  const sim = createMetaSimulator({ loadPolicy: async () => ({ datasetId: seed.meta.datasetId, datasetVersion: 1 }), loadDataset: async () => projected, loadOverlay: async () => EMPTY_OVERLAY });
  const response = await sim.handle({ userId: 'eval_candidate', token: 'sbx.eval_candidate.0123456789abcdef01234567', method: 'GET', version: 'v25.0', path: `act_${id}/campaigns`, query: { fields: 'id,account_id' } });
  expect(response.status).toBe(200);
  expect(JSON.parse(response.body).data[0].account_id).toBe(id);
  expect(projected.account.id).toBe(`act_${id}`);
  expect(createHash('sha256').update(JSON.stringify(seed)).digest('hex')).toBe(createHash('sha256').update(before).digest('hex'));
});
it('projects seeded asset URLs onto the uploaded dataset prefix including nested creative fields', () => {
  const seed = buildFixtureDataset();
  seed.assetsManifest = [{ assetKey: 'assets/a.png', sourcePath: 'a.png', sha256: 'a'.repeat(64), bytes: 10, width: 1, height: 1 }];
  seed.adcreatives[0].image_url = 'https://assets.example.invalid/assets/a.png';
  seed.adcreatives[0].object_story_spec = { link_data: { picture: seed.adcreatives[0].image_url } };
  const projected = projectSandboxDataset(seed, 'eval_candidate', 'https://bucket.s3.us-west-2.amazonaws.com');
  const url = `https://bucket.s3.us-west-2.amazonaws.com/sandbox-datasets/${seed.meta.datasetId}/1/assets/a.png`;
  expect(projected.adcreatives[0].image_url).toBe(url);
  expect(projected.adcreatives[0].object_story_spec).toEqual({ link_data: { picture: url } });
  expect(seed.adcreatives[0].image_url).toBe('https://assets.example.invalid/assets/a.png');
});
