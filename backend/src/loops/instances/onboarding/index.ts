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
 *   learning = DynamoLearningStore + CooldownRuleSet read-back
 */

import {
  analystFindingsBody,
  postLoopDigest,
  type LoopDigestTemplate,
} from '../../core/digest/loopDigest';
import { claimLoopDailyDigestPost } from '../../core/digest/dailyDigestClaim';
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
import { ONBOARDING_FLOW_DESCRIPTION, ONBOARDING_LOOP_ID, onboardingManifest } from './manifest';

const runner = createInstanceRunner({
  loopId: ONBOARDING_LOOP_ID,
  ports: productionLoopPorts,
  isEnabled: () => process.env.ONBOARDING_LOOP_V2 === 'true',
  implNames: {
    sensor: 'onboardingUserSensor',
    ruleSet: 'onboardingAnalyst',
    tools: 'onboardingSpecTool',
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
      learning,
    };
  },
  manifest: () => onboardingManifest,
  onRunComplete: async ({ result, ports, manifest }) => {
    await postLoopDigest(result, ports.slack, manifest.approval.slackUserId, onboardingDigestTemplate, undefined, {
      claimDailyDigest: (digestDate, slackUserId, runId) =>
        claimLoopDailyDigestPost(ports.dynamo, {
          loopId: ONBOARDING_LOOP_ID,
          digestDate,
          slackUserId,
          runId,
        }),
    });
  },
});

/**
 * Register the framework onboarding loop. No-op (returns false) unless
 * ONBOARDING_LOOP_V2=true. Idempotent. Does NOT touch the legacy cron.
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
  quietBody: () => [
    `_No analyst proposal fired this window. Check the reliability heartbeat before treating onboarding as clear._`,
  ],
  findingsBody: analystFindingsBody,
};
