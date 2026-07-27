/**
 * instanceRunner — shared register/run plumbing for production loop instances.
 *
 * Every instance module repeated the same choreography: env-gated idempotent
 * registration of the 4 layers + manifest and a runOnce that registers, runs
 * the orchestrator, and posts the digest. `createInstanceRunner(config)` owns that; the
 * instance keeps only layer construction, env gating, and its digest template.
 *
 * Boundary note: core/ normally only depends on ports, but the runner exists
 * precisely to wrap the registry (../index), so that import is deliberate.
 * Adapters stay out: production ports arrive via `config.ports` injection.
 */

import {
  getLoopManifest,
  getRegisteredLoopIds,
  registerOrReplaceLearningStore,
  registerOrReplaceLoop,
  registerOrReplaceRuleSet,
  registerOrReplaceSensor,
  registerOrReplaceTools,
} from '../index';
import { runLoop } from './orchestrator';
import type { LoopPorts } from './ports';
import {
  asLoopId,
  type EventSource,
  type LearningStore,
  type LoopManifest,
  type LoopRunResult,
  type Mutation,
  type MutationTools,
  type NormalizedEvent,
  type RuleSet,
} from './types';

/** The four layer implementations one instance registers. `ruleSet` and
 * `tools` are type-erased here (the registry stores them erased anyway), so
 * instances can return their concrete generics without per-call casts. */
export interface InstanceLayers {
  sensor: EventSource<NormalizedEvent>;
  ruleSet: unknown;
  tools: unknown;
  learning: LearningStore;
}

/** Registry names for the four layers (the manifest's *Impl values). */
export interface InstanceImplNames {
  sensor: string;
  ruleSet: string;
  tools: string;
  learning: string;
}

export interface InstanceRunContext {
  result: LoopRunResult;
  /** Mutations produced during this tick. */
  mutations: readonly Mutation[];
  ports: LoopPorts;
  manifest: LoopManifest;
}

export interface InstanceRunnerConfig {
  loopId: string;
  /** Ports factory — injected so core/ never imports the AWS adapters. */
  ports: () => LoopPorts;
  implNames: InstanceImplNames;
  buildLayers: (ports: LoopPorts) => InstanceLayers;
  manifest: () => LoopManifest;
  /** Env gating. When false, register() returns false and runOnce() → null. */
  isEnabled?: () => boolean;
  /** Custom already-registered check (default: loopId present in registry). */
  isAlreadyRegistered?: () => boolean;
  /** When false, runOnce() skips register() and relies on app-boot wiring. */
  registerOnRun?: boolean;
  /** Post-tick hook: post the digest DM. Errors propagate to the caller. */
  onRunComplete: (ctx: InstanceRunContext) => Promise<void>;
}

export interface InstanceRunner {
  /** Idempotent. Returns false only when the instance is env-gated off. */
  register: () => boolean;
  /** One tick: register (unless disabled by config), run, drain, digest.
   * Returns null only when the instance is env-gated off. */
  runOnce: () => Promise<LoopRunResult | null>;
  /** The layers built at registration time (test seam). */
  readonly layers: InstanceLayers | null;
  /** Drop the held gate/layers so tests can simulate a fresh module. */
  resetForTesting: () => void;
}

export function createInstanceRunner(config: InstanceRunnerConfig): InstanceRunner {
  let heldLayers: InstanceLayers | null = null;

  function isAlreadyRegistered(): boolean {
    if (config.isAlreadyRegistered) return config.isAlreadyRegistered();
    return (getRegisteredLoopIds() as readonly string[]).includes(config.loopId);
  }

  function register(): boolean {
    if (config.isEnabled && !config.isEnabled()) return false;
    if (isAlreadyRegistered()) return true;

    const ports = config.ports();
    const layers = config.buildLayers(ports);

    registerOrReplaceSensor(config.implNames.sensor, layers.sensor);
    registerOrReplaceRuleSet(config.implNames.ruleSet, layers.ruleSet as RuleSet<NormalizedEvent, unknown>);
    registerOrReplaceTools(config.implNames.tools, layers.tools as MutationTools<unknown>);
    registerOrReplaceLearningStore(config.implNames.learning, layers.learning);
    registerOrReplaceLoop(config.manifest());

    heldLayers = layers;
    return true;
  }

  async function runOnce(): Promise<LoopRunResult | null> {
    if (config.registerOnRun !== false && !register()) return null;

    const ports = config.ports();
    const manifest = getLoopManifest(asLoopId(config.loopId));
    const result = await runLoop(manifest, ports);

    await config.onRunComplete({ result, mutations: result.mutations, ports, manifest });

    return result;
  }

  return {
    register,
    runOnce,
    get layers() {
      return heldLayers;
    },
    resetForTesting() {
      heldLayers = null;
    },
  };
}
