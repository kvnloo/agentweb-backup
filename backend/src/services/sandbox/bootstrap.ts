import { installMetaSandboxInterceptor } from './metaInterceptor';
import { createMetaSimulator, type MetaSimulatorDeps } from './metaSimulator';
import { getSandboxDatasetStore } from './sandboxDatasetStore';
import { EMPTY_OVERLAY } from './types';
import { EvaluationDenied, requireActiveEvaluation } from '../evaluationPolicy';

/**
 * Wires the process-level Meta interceptor to the real policy/dataset stores and installs it
 * (ENG-1908). Must run once, exactly at boot, before anything makes a Meta call — a sandbox
 * account provisioned while this hasn't run would see every Graph call fail for real (the
 * sentinel token is not a real Meta credential), not leak anything, but it defeats the whole
 * point of the sandbox. Idempotent: installMetaSandboxInterceptor no-ops on a second call.
 *
 * loadOverlay always returns the empty overlay for now — phase 3 (ENG-1909) is what actually
 * writes an account's overlay; until it ships there is nothing else to read. Update this once
 * that lands.
 */
const deps: MetaSimulatorDeps = {
  async loadPolicy(userId) {
    try {
      const record = await requireActiveEvaluation(userId);
      if (!record.datasetId || record.datasetVersion === null || record.datasetVersion === undefined) return null;
      return { datasetId: record.datasetId, datasetVersion: record.datasetVersion };
    } catch (error) {
      if (error instanceof EvaluationDenied) return null;
      throw error;
    }
  },
  loadDataset(datasetId, version) {
    return getSandboxDatasetStore().loadDataset(datasetId, version);
  },
  async loadOverlay() {
    return EMPTY_OVERLAY;
  },
};

export function installSandboxMetaInterceptorAtBoot(): void {
  const simulator = createMetaSimulator(deps);
  installMetaSandboxInterceptor({ handle: (request) => simulator.handle(request) });
}
