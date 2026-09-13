import {
  EvaluationDenied,
  requireActiveEvaluation,
} from '../evaluationPolicy';
import {
  createMetaSimulator,
  type MetaSimulator,
  type MetaSimulatorDeps,
} from './metaSimulator';
import { installMetaSandboxInterceptor } from './metaInterceptor';
import {
  getSandboxDatasetStore,
  type SandboxDatasetStore,
} from './sandboxDatasetStore';
import { EMPTY_OVERLAY } from './types';

type EvaluationLoader = typeof requireActiveEvaluation;
type DatasetLoader = Pick<SandboxDatasetStore, 'loadDataset'>;

interface SimulatorDependencyOverrides {
  requireActiveEvaluation?: EvaluationLoader;
  datasetStore?: DatasetLoader;
}

interface BootstrapDependencyOverrides extends SimulatorDependencyOverrides {
  createSimulator?: (deps: MetaSimulatorDeps) => MetaSimulator;
  installInterceptor?: typeof installMetaSandboxInterceptor;
}

/** Compose the simulator with the authoritative evaluation policy and frozen dataset store. */
export function createSandboxMetaSimulatorDeps(
  overrides: SimulatorDependencyOverrides = {},
): MetaSimulatorDeps {
  const loadEvaluation = overrides.requireActiveEvaluation ?? requireActiveEvaluation;
  const datasetStore = overrides.datasetStore ?? getSandboxDatasetStore();

  return {
    async loadPolicy(userId) {
      try {
        const evaluation = await loadEvaluation(userId);
        if (
          typeof evaluation.datasetId !== 'string' ||
          evaluation.datasetId.length === 0 ||
          !Number.isInteger(evaluation.datasetVersion) ||
          (evaluation.datasetVersion ?? 0) < 1
        ) {
          return null;
        }
        return {
          datasetId: evaluation.datasetId,
          datasetVersion: evaluation.datasetVersion as number,
        };
      } catch (error) {
        if (error instanceof EvaluationDenied) return null;
        throw error;
      }
    },
    loadDataset: (datasetId, version) => datasetStore.loadDataset(datasetId, version),
    loadOverlay: async () => EMPTY_OVERLAY,
  };
}

/** Install once at real process boot; the interceptor itself is also idempotent. */
export function installSandboxMetaInterceptorAtBoot(
  overrides: BootstrapDependencyOverrides = {},
): void {
  const simulator = (overrides.createSimulator ?? createMetaSimulator)(
    createSandboxMetaSimulatorDeps(overrides),
  );
  (overrides.installInterceptor ?? installMetaSandboxInterceptor)({
    handle: simulator.handle,
  });
}
