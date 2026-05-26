/**
 * Wires the /ai-eval-funnel loop into the LOOP_REGISTRY. Called once at
 * process startup (the cron + the smoke runner both call this).
 *
 * Idempotent: safe to call multiple times in the same process. (Re-throws
 * any errors other than "already registered".)
 */

import {
  registerGate,
  registerLearningStore,
  registerLoop,
  registerRuleSet,
  registerSensor,
  registerTools,
} from '../../index';
import { CaptureGate } from '../../core/gates/captureGate';
import { InMemoryLearningStore } from '../../core/learning/inMemoryLearningStore';
import { DslRuleSet } from '../../core/policy/dslRuleSet';
import { InMemoryEventSource } from '../../core/sensors/inMemoryEventSource';
import { SpecOutputTool } from '../../core/tools/specOutputTool';
import type { NormalizedEvent } from '../../core/types';
import { AI_EVAL_LOOP_ID, aiEvalManifest } from './manifest';
import type { AiEvalProposalPayload } from './rules';
import { aiEvalRules } from './rules';

interface AiEvalRegistry {
  sensor: InMemoryEventSource;
  ruleSet: DslRuleSet<AiEvalProposalPayload>;
  tools: SpecOutputTool<AiEvalProposalPayload>;
  gate: CaptureGate;
  learning: InMemoryLearningStore;
}

let registered: AiEvalRegistry | null = null;

export function registerAiEvalFunnel(events: readonly NormalizedEvent[] = []): AiEvalRegistry {
  if (registered) {
    return registered;
  }

  const sensor = new InMemoryEventSource(events);
  const ruleSet = new DslRuleSet<AiEvalProposalPayload>(AI_EVAL_LOOP_ID, aiEvalRules);
  const tools = new SpecOutputTool<AiEvalProposalPayload>(AI_EVAL_LOOP_ID);
  const gate = new CaptureGate();
  const learning = new InMemoryLearningStore();

  registerSensor('aiEvalSensor', sensor);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerRuleSet('aiEvalRules', ruleSet as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerTools('aiEvalSpecTool', tools as any);
  registerGate('aiEvalCaptureGate', gate);
  registerLearningStore('aiEvalLearning', learning);
  registerLoop(aiEvalManifest);

  registered = { sensor, ruleSet, tools, gate, learning };
  return registered;
}
