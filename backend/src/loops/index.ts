/**
 * LOOP_REGISTRY — central directory of loop instances and the named
 * implementations they consume.
 *
 * A loop instance is registered here by calling `registerLoop()` from its
 * `instances/<loopId>/index.ts` module. Implementations of the 5 layer
 * interfaces (`EventSource`, `RuleSet`, `MutationTools`, `ApprovalGate`,
 * `LearningStore`) are registered separately by their owning modules so that
 * multiple instances can share an implementation.
 *
 * The orchestrator and watchdog cron look up loops + implementations through
 * this registry. The host's cron scheduler iterates `getRegisteredLoopIds()`
 * to know what to run.
 *
 * Phase 1a (this commit) ships the registry with no instances or
 * implementations registered. Phase 2 registers the onboarding instance;
 * Phase 3 registers the ai-eval-funnel instance.
 */

import {
  ApprovalGate,
  EventSource,
  LearningStore,
  LoopId,
  LoopManifest,
  MutationTools,
  NormalizedEvent,
  RuleSet,
} from './core/types';

// ---------------------------------------------------------------------------
// Implementation registry — one named impl per layer per implementation
// ---------------------------------------------------------------------------

interface ImplementationRegistry {
  sensors: Map<string, EventSource<NormalizedEvent>>;
  rulesets: Map<string, RuleSet<NormalizedEvent, unknown>>;
  tools: Map<string, MutationTools<unknown>>;
  gates: Map<string, ApprovalGate>;
  learning: Map<string, LearningStore>;
}

const impls: ImplementationRegistry = {
  sensors: new Map(),
  rulesets: new Map(),
  tools: new Map(),
  gates: new Map(),
  learning: new Map(),
};

export function registerSensor(name: string, impl: EventSource<NormalizedEvent>): void {
  if (impls.sensors.has(name)) {
    throw new Error(`[loops] sensor impl already registered: ${name}`);
  }
  impls.sensors.set(name, impl);
}

export function registerRuleSet(name: string, impl: RuleSet<NormalizedEvent, unknown>): void {
  if (impls.rulesets.has(name)) {
    throw new Error(`[loops] ruleset impl already registered: ${name}`);
  }
  impls.rulesets.set(name, impl);
}

export function registerTools(name: string, impl: MutationTools<unknown>): void {
  if (impls.tools.has(name)) {
    throw new Error(`[loops] tools impl already registered: ${name}`);
  }
  impls.tools.set(name, impl);
}

export function registerGate(name: string, impl: ApprovalGate): void {
  if (impls.gates.has(name)) {
    throw new Error(`[loops] gate impl already registered: ${name}`);
  }
  impls.gates.set(name, impl);
}

export function registerLearningStore(name: string, impl: LearningStore): void {
  if (impls.learning.has(name)) {
    throw new Error(`[loops] learning impl already registered: ${name}`);
  }
  impls.learning.set(name, impl);
}

export function getSensor(name: string): EventSource<NormalizedEvent> {
  const impl = impls.sensors.get(name);
  if (!impl) throw new Error(`[loops] sensor impl not registered: ${name}`);
  return impl;
}

export function getRuleSet(name: string): RuleSet<NormalizedEvent, unknown> {
  const impl = impls.rulesets.get(name);
  if (!impl) throw new Error(`[loops] ruleset impl not registered: ${name}`);
  return impl;
}

export function getTools(name: string): MutationTools<unknown> {
  const impl = impls.tools.get(name);
  if (!impl) throw new Error(`[loops] tools impl not registered: ${name}`);
  return impl;
}

export function getGate(name: string): ApprovalGate {
  const impl = impls.gates.get(name);
  if (!impl) throw new Error(`[loops] gate impl not registered: ${name}`);
  return impl;
}

export function getLearningStore(name: string): LearningStore {
  const impl = impls.learning.get(name);
  if (!impl) throw new Error(`[loops] learning impl not registered: ${name}`);
  return impl;
}

// ---------------------------------------------------------------------------
// Loop instance registry
// ---------------------------------------------------------------------------

const loops: Map<LoopId, LoopManifest> = new Map();

export function registerLoop(manifest: LoopManifest): void {
  if (loops.has(manifest.loopId)) {
    throw new Error(`[loops] loop already registered: ${manifest.loopId}`);
  }
  loops.set(manifest.loopId, manifest);
}

export function getLoopManifest(loopId: LoopId): LoopManifest {
  const manifest = loops.get(loopId);
  if (!manifest) throw new Error(`[loops] loop not registered: ${loopId}`);
  return manifest;
}

export function getRegisteredLoopIds(): readonly LoopId[] {
  return Array.from(loops.keys());
}

/** Reset everything. Used only by tests + the smoke harness. */
export function _resetRegistryForTesting(): void {
  impls.sensors.clear();
  impls.rulesets.clear();
  impls.tools.clear();
  impls.gates.clear();
  impls.learning.clear();
  loops.clear();
}
