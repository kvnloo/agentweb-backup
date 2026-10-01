import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { importSandboxDataset } from '../../services/sandbox/datasetImport';

let directory: string;
let dataset: any;
let deps: any;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'sandbox-import-'));
  const source = join(__dirname, '../../../datasets/agentweb-2026q2/1');
  dataset = JSON.parse(readFileSync(join(source, 'dataset.json'), 'utf8'));
  mkdirSync(join(directory, 'assets'));
  for (const asset of dataset.assetsManifest) writeFileSync(join(directory, asset.assetKey), readFileSync(join(source, asset.assetKey)));
  deps = { s3: { putObject: jest.fn(() => ({ promise: async () => ({}) })) }, store: {
    loadDatasetSummary: jest.fn(async () => null), putDataset: jest.fn(async () => ({ sha256: 'hash' })),
  } };
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));
const run = () => {
  writeFileSync(join(directory, 'dataset.json'), JSON.stringify(dataset));
  return importSandboxDataset(directory, 'admin', deps);
};
it.each(['missing', 'rows', 'spend', 'action', 'malformed-action'])('rejects %s reconciliation before any external writes', async kind => {
  if (kind === 'missing') delete dataset.reconciliation;
  if (kind === 'rows') dataset.reconciliation.dailyRows++;
  if (kind === 'spend') dataset.insightsDaily[0].spend++;
  if (kind === 'action') dataset.insightsDaily[0].actions.find((a: any) => a.action_type === 'lead').value++;
  if (kind === 'malformed-action') dataset.insightsDaily[0].actions = [null];
  await expect(run()).rejects.toThrow();
  expect(deps.s3.putObject).not.toHaveBeenCalled();
  expect(deps.store.putDataset).not.toHaveBeenCalled();
});
it('publishes validated assets privately before the immutable dataset', async () => {
  await run();
  expect(deps.s3.putObject).toHaveBeenCalled();
  for (const [request] of deps.s3.putObject.mock.calls) {
    expect(request).toMatchObject({ ACL: 'private', CacheControl: 'private, no-store' });
  }
  expect(deps.store.putDataset).toHaveBeenCalledWith(dataset, 'admin');
});

it('requires an explicit import audit actor before touching storage', async () => {
  await expect(importSandboxDataset(directory, '', deps)).rejects.toThrow(/actor/);
  expect(deps.s3.putObject).not.toHaveBeenCalled();
  expect(deps.store.putDataset).not.toHaveBeenCalled();
});
