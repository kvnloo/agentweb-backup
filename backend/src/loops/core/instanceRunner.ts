/**
 * instanceRunner — shared register/run plumbing for production loop instances.
 *
 * Every instance module (agent-mode, onboarding, ai-readiness, ai-eval prod)
 * repeated the same choreography:
 *
 *   register():  gate on env flag → skip if already in the registry →
 *                build the 5 layers → registerOrReplace* each → register the
 *                manifest → hold the CaptureGate in a module singleton
 *   runOnce():   register → runLoop(manifest, ports) → drain the gate →
 *                post the digest DM
 *
 * `createInstanceRunner(config)` owns that choreography; the instance module
 * keeps only what is actually loop-specific (layer construction, env gating,
 * digest template) and re-exports its public function names unchanged.
 *
 * Boundary note: core/ normally only depends on ports, but the runner exists
 * precisely to wrap the registry (../index), so that import is deliberate.
 * Adapters stay out: production ports arrive via `config.ports` injection.
 */

import {
  getLoopManifest,
  getRegisteredLoopIds,
  registerOrReplaceGate,
  registerOrReplaceLearningStore,
  registerOrReplaceLoop,
  registerOrReplaceRuleSet,
  registerOrReplaceSensor,
  registerOrReplaceTools,
} from '../index';
import type { CaptureGate } from './gates/captureGate';
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

/** The five layer implementations one instance registers. */
export interface InstanceLayers {
  sensor: EventSource<NormalizedEvent>;
  ruleSet: RuleSet<NormalizedEvent, unknown>;
  tools: MutationTools<unknown>;
  /** Must be a CaptureGate — the runner drains it after each tick. */
  gate: CaptureGate;
  learning: LearningStore;
}

/** Registry names for the five layers (the manifest's *Impl values). */
export interface InstanceImplNames {
  sensor: string;
  ruleSet: string;
  tools: string;
  gate: string;
  learning: string;
}

export interface InstanceRunContext {
  result: LoopRunResult;
  /** Mutations drained from the held gate, or null when no gate is held
   * (i.e. this module instance never performed the registration). */
  drained: readonly Mutation[] | null;
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
  /** The CaptureGate held since this module instance registered, if any. */
  readonly gate: CaptureGate | null;
  /** The layers built at registration time (test seam). */
  readonly layers: InstanceLayers | null;
  /** Drop the held gate/layers so tests can simulate a fresh module. */
  resetForTesting: () => void;
}

export function createInstanceRunner(config: InstanceRunnerConfig): InstanceRunner {
  // Held so runOnce can drain the gate's captured mutations after the
  // orchestrator returns and post a single digest DM.
  let heldGate: CaptureGate | null = null;
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
    registerOrReplaceRuleSet(config.implNames.ruleSet, layers.ruleSet);
    registerOrReplaceTools(config.implNames.tools, layers.tools);
    registerOrReplaceGate(config.implNames.gate, layers.gate);
    registerOrReplaceLearningStore(config.implNames.learning, layers.learning);
    registerOrReplaceLoop(config.manifest());

    heldGate = layers.gate;
    heldLayers = layers;
    return true;
  }

  async function runOnce(): Promise<LoopRunResult | null> {
    if (config.registerOnRun !== false && !register()) return null;

    const ports = config.ports();
    const manifest = getLoopManifest(asLoopId(config.loopId));
    const result = await runLoop(manifest, ports);

    const drained = heldGate ? heldGate.drain() : null;
    await config.onRunComplete({ result, drained, ports, manifest });

    return result;
  }

  return {
    register,
    runOnce,
    get gate() {
      return heldGate;
    },
    get layers() {
      return heldLayers;
    },
    resetForTesting() {
      heldGate = null;
      heldLayers = null;
    },
  };
}
