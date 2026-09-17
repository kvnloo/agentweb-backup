import { runSandboxLifecycle, parseDatasetPin } from '../../services/sandbox/lifecycleCommand';
import { evaluationStore } from '../../services/evaluationStore';
import { requireEvaluationAdmin, requireEvaluationReviewer } from '../../services/evaluationPolicy';
import { readFile } from 'fs/promises';

jest.mock('fs/promises', () => ({ readFile: jest.fn() }));
jest.mock('../../services/evaluationStore', () => ({ evaluationStore: { provision: jest.fn(), reset: jest.fn(), purge: jest.fn(), revoke: jest.fn(), review: jest.fn() } }));
jest.mock('../../services/evaluationPolicy', () => ({ requireEvaluationAdmin: jest.fn(), requireEvaluationReviewer: jest.fn() }));
jest.mock('../../services/sandbox/datasetImport', () => ({ importSandboxDataset: jest.fn() }));

describe('sandbox lifecycle command authorization and dataset pin', () => {
  beforeEach(() => { jest.resetAllMocks(); process.env.NODE_ENV = 'development'; });
  afterAll(() => { process.env.NODE_ENV = 'test'; });
  it('provision --dataset supplies the exact version and reads password from a file', async () => {
    (readFile as jest.Mock).mockResolvedValue(JSON.stringify({ email: 'candidate@example.invalid', password: 'private', datasetId: 'ignored' }));
    await runSandboxLifecycle(['provision', '--actor', 'admin', '--dataset', 'agentweb-2026q2@1', '--input', '/tmp/private.json']);
    expect(requireEvaluationAdmin).toHaveBeenCalledWith('admin');
    expect(evaluationStore.provision).toHaveBeenCalledWith('admin', { email: 'candidate@example.invalid', password: 'private', datasetId: 'agentweb-2026q2', datasetVersion: 1 });
  });
  it.each(['reset', 'purge', 'revoke'])('denies %s before any mutation for a non-admin', async action => {
    (requireEvaluationAdmin as jest.Mock).mockRejectedValue(new Error('denied'));
    await expect(runSandboxLifecycle([action, '--actor', 'candidate', '--user', 'eval_user'])).rejects.toThrow('denied');
    expect(evaluationStore[action as 'reset']).not.toHaveBeenCalled();
  });
  it('review markdown authorizes reviewer before and after the read', async () => {
    (evaluationStore.review as jest.Mock).mockResolvedValue({ markdown: '# Sandbox review' });
    await expect(runSandboxLifecycle(['review', '--actor', 'reviewer', '--user', 'eval_user', '--format', 'markdown'])).resolves.toBe('# Sandbox review');
    expect(requireEvaluationReviewer).toHaveBeenCalledTimes(2);
    expect(requireEvaluationAdmin).not.toHaveBeenCalled();
  });
  it.each(['dataset', 'dataset@0', 'dataset@1.5', '../escape@1', 'dataset@999999999999999999999'])('rejects malformed pin %s', pin => {
    expect(() => parseDatasetPin(pin)).toThrow();
  });
  it('requires an explicit environment for destructive commands', async () => {
    delete process.env.NODE_ENV;
    await expect(runSandboxLifecycle(['purge', '--actor', 'admin', '--user', 'eval_user'])).rejects.toThrow('NODE_ENV');
    expect(evaluationStore.purge).not.toHaveBeenCalled();
  });
});

it('denies privileged import before publication and forwards the authenticated admin actor', async () => {
  const { importSandboxDataset } = await import('../../services/sandbox/datasetImport');
  process.env.NODE_ENV = 'development';
  (requireEvaluationAdmin as jest.Mock).mockRejectedValueOnce(new Error('denied'));
  await expect(runSandboxLifecycle(['load-dataset', '--actor', 'candidate', '--directory', '/tmp/dataset'])).rejects.toThrow('denied');
  expect(importSandboxDataset).not.toHaveBeenCalled();
  await runSandboxLifecycle(['load-dataset', '--actor', 'admin', '--directory', '/tmp/dataset']);
  expect(importSandboxDataset).toHaveBeenCalledWith('/tmp/dataset', 'admin');
});
