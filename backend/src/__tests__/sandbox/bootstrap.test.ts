import fs from 'fs';
import path from 'path';
import { EvaluationDenied } from '../../services/evaluationPolicy';
import { EMPTY_OVERLAY } from '../../services/sandbox/types';
import {
  createSandboxMetaSimulatorDeps,
  installSandboxMetaInterceptorAtBoot,
} from '../../services/sandbox/bootstrap';

describe('sandbox Meta production bootstrap', () => {
  const activeRecord = {
    userId: 'eval_fixture',
    status: 'active' as const,
    datasetId: 'fixture-agentweb',
    datasetVersion: 3,
  };

  it('starts from the existing immutable empty overlay contract', () => {
    expect(Object.isFrozen(EMPTY_OVERLAY)).toBe(true);
  });

  it('maps an active evaluation dataset pin into simulator policy', async () => {
    const deps = createSandboxMetaSimulatorDeps({
      requireActiveEvaluation: jest.fn(async () => activeRecord as any),
      datasetStore: { loadDataset: jest.fn() } as any,
    });

    await expect(deps.loadPolicy('eval_fixture')).resolves.toEqual({
      datasetId: 'fixture-agentweb',
      datasetVersion: 3,
    });
  });

  it.each([
    ['denied evaluation', jest.fn(async () => { throw new EvaluationDenied(); })],
    ['expired evaluation', jest.fn(async () => { throw new EvaluationDenied(); })],
    ['missing evaluation', jest.fn(async () => { throw new EvaluationDenied(); })],
    ['missing dataset pin', jest.fn(async () => ({ ...activeRecord, datasetId: undefined }))],
    ['invalid dataset version', jest.fn(async () => ({ ...activeRecord, datasetVersion: 0 }))],
  ])('maps %s to no simulator policy', async (_label, requireEvaluation) => {
    const deps = createSandboxMetaSimulatorDeps({
      requireActiveEvaluation: requireEvaluation as any,
      datasetStore: { loadDataset: jest.fn() } as any,
    });

    await expect(deps.loadPolicy('eval_fixture')).resolves.toBeNull();
  });

  it('uses the real dataset loader and the immutable empty overlay', async () => {
    const dataset = { meta: { datasetId: 'fixture-agentweb', version: 3 } };
    const loadDataset = jest.fn(async () => dataset as any);
    const deps = createSandboxMetaSimulatorDeps({
      requireActiveEvaluation: jest.fn(async () => activeRecord as any),
      datasetStore: { loadDataset } as any,
    });

    await expect(deps.loadDataset('fixture-agentweb', 3)).resolves.toBe(dataset);
    await expect(deps.loadOverlay('eval_fixture')).resolves.toBe(EMPTY_OVERLAY);
    expect(loadDataset).toHaveBeenCalledWith('fixture-agentweb', 3);
  });

  it('installs the simulator handle exactly once per bootstrap call', () => {
    const handle = jest.fn();
    const createSimulator = jest.fn(() => ({ handle }));
    const installInterceptor = jest.fn();

    installSandboxMetaInterceptorAtBoot({ createSimulator, installInterceptor } as any);

    expect(createSimulator).toHaveBeenCalledTimes(1);
    expect(installInterceptor).toHaveBeenCalledTimes(1);
    expect(installInterceptor).toHaveBeenCalledWith({ handle });
  });

  it('wires one production install after the Jest background-job guard', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../server.ts'), 'utf8');
    const guard = source.indexOf('if (!shouldBootstrapBackgroundJobs())');
    const guardReturn = source.indexOf('return;', guard);
    const calls = source.match(/installSandboxMetaInterceptorAtBoot\(\)/g) ?? [];

    expect(guard).toBeGreaterThanOrEqual(0);
    expect(guardReturn).toBeGreaterThan(guard);
    expect(calls).toHaveLength(1);
    expect(source.indexOf('installSandboxMetaInterceptorAtBoot()')).toBeGreaterThan(guardReturn);
  });

  it('does not hide unexpected policy-store failures', async () => {
    const failure = new Error('dynamo unavailable');
    const deps = createSandboxMetaSimulatorDeps({
      requireActiveEvaluation: jest.fn(async () => { throw failure; }),
      datasetStore: { loadDataset: jest.fn() } as any,
    });

    await expect(deps.loadPolicy('eval_fixture')).rejects.toBe(failure);
  });
});
