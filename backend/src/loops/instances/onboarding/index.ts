/**
 * Registers the onboarding loop as a framework instance — the REVAMP port.
 *
 * GATED PARALLEL: only registers when ONBOARDING_LOOP_V2=true, and runs
 * ALONGSIDE the legacy onboarding cron (`cron/onboardingLoop.ts`) — it does not
 * touch or replace it. Cutover (pointing the live cron at this + disabling the
 * old path) is the final step, after this parallel loop is verified
 * equal-or-better.
 *
 * Layer mapping:
 *   sensor   = userArrayEventSource over AW-Users.onboardingEvents[]
 *   policy   = LlmAnalystRuleSet (reasons over journeys, not threshold rules)
 *   tools    = SpecOutputTool (records the proposal spec; the DM is the value
 *              during verification — swap to a cloud-dev dispatch tool at cutover)
 *   gate     = CaptureGate (Slack DM + reactions)
 *   learning = InMemoryLearningStore (swap to the durable store + attribution
 *              engine at cutover)
 */

import {
  getRegisteredLoopIds,
  registerGate,
  registerLearningStore,
  registerLoop,
  registerRuleSet,
  registerSensor,
  registerTools,
} from '../../index';
import { CaptureGate } from '../../core/gates/captureGate';
import { InMemoryLearningStore } from '../../core/learning/inMemoryLearningStore';
import { LlmAnalystRuleSet } from '../../core/policy/llmAnalystRuleSet';
import {
  UserArrayEventSource,
  type UserArrayRecord,
} from '../../core/sensors/userArrayEventSource';
import { SpecOutputTool } from '../../core/tools/specOutputTool';
import { productionLoopPorts } from '../../adapters/awsAdapters';
import { userDb } from '../../../services/db';
import { ONBOARDING_FLOW_DESCRIPTION, ONBOARDING_LOOP_ID, onboardingManifest } from './manifest';

/**
 * Register the framework onboarding loop. No-op (returns false) unless
 * ONBOARDING_LOOP_V2=true. Idempotent. Does NOT touch the legacy cron.
 */
export function registerOnboardingLoopV2(): boolean {
  if (process.env.ONBOARDING_LOOP_V2 !== 'true') return false;
  if ((getRegisteredLoopIds() as readonly string[]).includes(ONBOARDING_LOOP_ID)) return true;

  const ports = productionLoopPorts();

  const sensor = new UserArrayEventSource(
    async () => (await userDb.getAllUsers(true)) as UserArrayRecord[],
  );
  const ruleSet = new LlmAnalystRuleSet(ONBOARDING_LOOP_ID, ports.bedrock, {
    model: onboardingManifest.generator.model,
    targetMetricName: onboardingManifest.targetMetric.name,
    flowDescription: ONBOARDING_FLOW_DESCRIPTION,
    maxProposals: 3,
  });
  const tools = new SpecOutputTool(ONBOARDING_LOOP_ID);
  const gate = new CaptureGate();
  const learning = new InMemoryLearningStore();

  registerSensor('onboardingUserSensor', sensor);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerRuleSet('onboardingAnalyst', ruleSet as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerTools('onboardingSpecTool', tools as any);
  registerGate('onboardingGate', gate);
  registerLearningStore('onboardingLearning', learning);
  registerLoop(onboardingManifest);

  return true;
}
