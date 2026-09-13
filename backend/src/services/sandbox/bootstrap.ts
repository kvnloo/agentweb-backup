import { installMetaSandboxInterceptor } from './metaInterceptor';
import { createMetaSimulator, type MetaSimulatorDeps } from './metaSimulator';
import { getSandboxDatasetStore } from './sandboxDatasetStore';
import { projectSandboxDataset } from './runtimeDataset';
import { sandboxStateStore } from './sandboxStateStore';
import { getSandboxOverlayStore } from './sandboxOverlayStore';
import { EvaluationDenied, requireActiveEvaluation } from '../evaluationPolicy';

/**
 * Wires the process-level Meta interceptor to the real policy/dataset/overlay/audit stores and
 * installs it (ENG-1908/ENG-1909/ENG-1910). Must run once, exactly at boot, before anything makes a
 * Meta call — a sandbox account provisioned while this hasn't run would see every Graph call
 * fail for real (the sentinel token is not a real Meta credential), not leak anything, but it
 * defeats the whole point of the sandbox. Idempotent: installMetaSandboxInterceptor no-ops on
 * a second call.
 */
const overlayStore = getSandboxOverlayStore();
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
  async loadDataset(datasetId, version, userId) {
    const seed = await getSandboxDatasetStore().loadDataset(datasetId, version);
    if (!userId) throw new EvaluationDenied();
    return projectSandboxDataset(seed, userId);
  },
  loadOverlay(userId) {
    return overlayStore.load(userId);
  },
  mutateOverlay(userId, mutate, audit) {
    return overlayStore.mutate(userId, mutate, audit);
  },
  recordAction: (req, response, at) => sandboxStateStore.recordAction(req, response, at),
};

export function installSandboxMetaInterceptorAtBoot(): void {
  const simulator = createMetaSimulator(deps);
  installMetaSandboxInterceptor({ handle: (request) => simulator.handle(request) });
}
