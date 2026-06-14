/**
 * Registers the onboarding loop as a framework instance — the REVAMP port.
 *
 * LIVE DEFAULT (Phase 2 cutover, 2026-06): this V2 instance is now the live
 * onboarding loop. The legacy heartbeat (`cron/onboardingLoop.ts`) is OFF
 * unless explicitly opted back in (ONBOARDING_LOOP_ENABLED=true), in which case
 * V2 yields so the two never double-fire. The live/off decision is owned by the
 * shared `cutover` policy module so the cron and the runner stay in agreement.
 * (Legacy code is not deleted yet — that is PR 2, pure subtraction.)
 *
 * Layer mapping:
 *   sensor   = userArrayEventSource over AW-Users.onboardingEvents[]
 *   policy   = LlmAnalystRuleSet (reasons over journeys, not threshold rules)
 *   tools    = SpecOutputTool (records the proposal spec; the DM is the value
 *              during verification — swap to a cloud-dev dispatch tool at cutover)
 *   gate     = CaptureGate (Slack DM + reactions)
 *   learning = DynamoLearningStore + CooldownRuleSet read-back
 */

import { CaptureGate } from '../../core/gates/captureGate';
import {
  analystFindingsBody,
  postLoopDigest,
  type LoopDigestTemplate,
} from '../../core/digest/loopDigest';
import { createInstanceRunner } from '../../core/instanceRunner';
import { DynamoLearningStore } from '../../core/learning/dynamoLearningStore';
import { CooldownRuleSet } from '../../core/policy/cooldownRuleSet';
import { LlmAnalystRuleSet } from '../../core/policy/llmAnalystRuleSet';
import {
  UserArrayEventSource,
  type UserArrayRecord,
} from '../../core/sensors/userArrayEventSource';
import { SpecOutputTool } from '../../core/tools/specOutputTool';
import { productionLoopPorts } from '../../adapters/awsAdapters';
import type { LoopRunResult } from '../../core/types';
import { userDb } from '../../../services/db';
import { isOnboardingV2Live } from './cutover';
import { ONBOARDING_FLOW_DESCRIPTION, ONBOARDING_LOOP_ID, onboardingManifest } from './manifest';

const runner = createInstanceRunner({
  loopId: ONBOARDING_LOOP_ID,
  ports: productionLoopPorts,
  // Phase 2 cutover: V2 is live by default. Honors the same cutover policy the
  // server boot uses, so a live cron tick actually runs under the default env.
  isEnabled: isOnboardingV2Live,
  implNames: {
    sensor: 'onboardingUserSensor',
    ruleSet: 'onboardingAnalyst',
    tools: 'onboardingSpecTool',
    gate: 'onboardingGate',
    learning: 'onboardingLearning',
  },
  buildLayers: (ports) => {
    const learning = new DynamoLearningStore(ports.dynamo);
    const analyst = new LlmAnalystRuleSet(ONBOARDING_LOOP_ID, ports.bedrock, {
      model: onboardingManifest.generator.model,
      targetMetricName: onboardingManifest.targetMetric.name,
      flowDescription: ONBOARDING_FLOW_DESCRIPTION,
      maxProposals: 3,
    });
    return {
      sensor: new UserArrayEventSource(
        async () => (await userDb.getAllUsers(true)) as UserArrayRecord[],
      ),
      ruleSet: new CooldownRuleSet(analyst, learning, ONBOARDING_LOOP_ID),
      tools: new SpecOutputTool(ONBOARDING_LOOP_ID),
      gate: new CaptureGate(),
      learning,
    };
  },
  manifest: () => onboardingManifest,
  onRunComplete: async ({ result, drained, ports, manifest }) => {
    if (drained === null) return;
    await postLoopDigest(result, ports.slack, manifest.approval.slackUserId, onboardingDigestTemplate, undefined);
  },
});

/**
 * Register the framework onboarding loop. No-op (returns false) when the
 * cutover policy says V2 is not the live path (legacy opted in, or V2 explicitly
 * disabled). Idempotent. Does NOT touch the legacy cron.
 */
export function registerOnboardingLoopV2(): boolean {
  return runner.register();
}

/**
 * Run one onboarding-loop tick: register (gated), run the orchestrator over the
 * onboardingEvents window, drain the gate, and DM Harsha the analyst's findings.
 * Returns null when the loop is gated off. Never throws — errors are logged.
 */
export async function runOnboardingLoopV2Once(): Promise<LoopRunResult | null> {
  return runner.runOnce();
}

const onboardingDigestTemplate: LoopDigestTemplate = {
  logTag: '[onboarding-loop-v2]',
  header: (date) => `*🚀 Onboarding loop — daily run ${date}*`,
  counts: (result) =>
    `Users/events scanned: ${result.eventsScanned}  |  Findings: ${result.proposals.length}`,
  emptyBody: () => [`_No onboarding events in the window — too thin to judge._`],
  quietBody: () => [`_Funnel looks healthy — no issues surfaced._`],
  findingsBody: analystFindingsBody,
};
