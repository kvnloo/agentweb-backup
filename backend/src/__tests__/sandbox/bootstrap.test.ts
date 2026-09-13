import { buildFixtureDataset } from './fixtures/fixtureDataset';
import { sandboxAdAccountId } from '../../services/sandbox/sentinel';
import { EvaluationDenied } from '../../services/evaluationPolicy';
import * as metaSimulatorModule from '../../services/sandbox/metaSimulator';

/**
 * ENG-1908/ENG-1909: `installSandboxMetaInterceptorAtBoot` is the one call server.ts makes at
 * boot to wire the interceptor to real policy/dataset/overlay stores. Without it the
 * interceptor module is fully built but never installed — every Graph call from a sandbox
 * account would try to reach the real graph.facebook.com with a sentinel token instead of
 * being simulated.
 */
const requireActiveEvaluation = jest.fn();
jest.mock('../../services/evaluationPolicy', () => ({
  ...jest.requireActual('../../services/evaluationPolicy'),
  requireActiveEvaluation: (...args: unknown[]) => requireActiveEvaluation(...args),
}));

const loadOverlay = jest.fn(async () => ({ revision: 1 }));
const recordAction = jest.fn(async () => {});
jest.mock('../../services/sandbox/sandboxStateStore', () => ({ sandboxStateStore: { loadOverlay, recordAction } }));
const loadDataset = jest.fn();
jest.mock('../../services/sandbox/sandboxDatasetStore', () => ({
  getSandboxDatasetStore: () => ({ loadDataset }),
}));

const load = jest.fn();
const mutate = jest.fn();
jest.mock('../../services/sandbox/sandboxOverlayStore', () => ({
  getSandboxOverlayStore: () => ({ load, mutate }),
}));

const installMetaSandboxInterceptor = jest.fn();
jest.mock('../../services/sandbox/metaInterceptor', () => ({ installMetaSandboxInterceptor }));

// metaSimulator itself is real — createMetaSimulator is pure glue with no side effects on
// import — so the spy captures the exact deps object bootstrap.ts built, and every test
// exercises the wiring through it rather than reconstructing it by hand.
const createMetaSimulator = jest.spyOn(metaSimulatorModule, 'createMetaSimulator');

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { installSandboxMetaInterceptorAtBoot } = require('../../services/sandbox/bootstrap');

beforeEach(() => { jest.clearAllMocks(); });

function install() {
  installSandboxMetaInterceptorAtBoot();
  return createMetaSimulator.mock.calls[0][0];
}

describe('installSandboxMetaInterceptorAtBoot', () => {
  it('installs the interceptor with a handle that delegates to the wired simulator', async () => {
    installSandboxMetaInterceptorAtBoot();
    expect(installMetaSandboxInterceptor).toHaveBeenCalledTimes(1);
    expect(createMetaSimulator).toHaveBeenCalledTimes(1);
    const { handle } = installMetaSandboxInterceptor.mock.calls[0][0];
    requireActiveEvaluation.mockRejectedValue(new EvaluationDenied());
    const res = await handle({ userId: 'eval_x', token: 'sbx.eval_x.abc', method: 'GET', version: 'v25.0', path: 'me', query: {} });
    // No dataset wired for this user → the real simulator's own invalidToken() path, proving
    // the handle genuinely reaches the wired deps rather than being a disconnected stub.
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe(190);
  });
});

describe('the wired MetaSimulatorDeps', () => {
  it('loadPolicy returns null (→ 190) when the evaluation is denied, without throwing', async () => {
    requireActiveEvaluation.mockRejectedValue(new EvaluationDenied());
    await expect(install().loadPolicy('eval_x')).resolves.toBeNull();
  });

  it('loadPolicy returns {datasetId, datasetVersion} for an active record with both set', async () => {
    requireActiveEvaluation.mockResolvedValue({ userId: 'eval_x', status: 'active', datasetId: 'agentweb-2026q2', datasetVersion: 1 });
    await expect(install().loadPolicy('eval_x')).resolves.toEqual({ datasetId: 'agentweb-2026q2', datasetVersion: 1 });
  });

  it('loadPolicy returns null when the active record is missing a dataset pin (legacy row)', async () => {
    requireActiveEvaluation.mockResolvedValue({ userId: 'eval_x', status: 'active', datasetId: null, datasetVersion: null });
    await expect(install().loadPolicy('eval_x')).resolves.toBeNull();
  });

  it('a non-EvaluationDenied failure from requireActiveEvaluation still propagates', async () => {
    requireActiveEvaluation.mockRejectedValue(new Error('DynamoDB is unavailable'));
    await expect(install().loadPolicy('eval_x')).rejects.toThrow('DynamoDB is unavailable');
  });

  it('loadDataset delegates to immutable store and projects the provisioned account', async () => {
    loadDataset.mockResolvedValue(buildFixtureDataset());
    await expect(install().loadDataset('agentweb-2026q2', 1, 'eval_x')).resolves.toMatchObject({ account: { id: `act_${sandboxAdAccountId('eval_x')}` } });
    expect(loadDataset).toHaveBeenCalledWith('agentweb-2026q2', 1);
  });

  it('loadOverlay delegates to the sandbox overlay store (ENG-1909)', async () => {
    const { EMPTY_OVERLAY } = require('../../services/sandbox/types');
    load.mockResolvedValue(EMPTY_OVERLAY);
    await expect(install().loadOverlay('eval_x')).resolves.toBe(EMPTY_OVERLAY);
    expect(load).toHaveBeenCalledWith('eval_x');
  });

  it('mutateOverlay delegates to the sandbox overlay store, forwarding the mutate fn and audit (ENG-1909)', async () => {
    const { EMPTY_OVERLAY } = require('../../services/sandbox/types');
    mutate.mockResolvedValue(EMPTY_OVERLAY);
    const fn = (current: import('../../services/sandbox/types').SandboxOverlay) => current;
    const audit = { action: 'sandbox.create' };
    const deps = install();
    await expect(deps.mutateOverlay!('eval_x', fn, audit)).resolves.toBe(EMPTY_OVERLAY);
    expect(mutate).toHaveBeenCalledWith('eval_x', fn, audit);
  });

  it('recordAction delegates to the durable sandbox audit store (ENG-1910)', async () => {
    const req = { userId: 'eval_x' } as any;
    const response = { status: 200 } as any;
    const at = new Date('2026-09-13T00:00:00Z');
    await install().recordAction!(req, response, at);
    expect(recordAction).toHaveBeenCalledWith(req, response, at);
  });
});
