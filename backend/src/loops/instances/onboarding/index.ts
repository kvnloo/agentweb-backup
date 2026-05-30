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
  getLoopManifest,
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
import { runLoop } from '../../core/orchestrator';
import { productionLoopPorts } from '../../adapters/awsAdapters';
import type { LoopRunResult } from '../../core/types';
import { userDb } from '../../../services/db';
import { ONBOARDING_FLOW_DESCRIPTION, ONBOARDING_LOOP_ID, onboardingManifest } from './manifest';

// Held so the tick can drain the gate's captured mutations after the
// orchestrator returns and post a single digest DM.
let onboardingGate: CaptureGate | null = null;

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

  onboardingGate = gate;
  return true;
}

/**
 * Run one onboarding-loop tick: register (gated), run the orchestrator over the
 * onboardingEvents window, drain the gate, and DM Harsha the analyst's findings.
 * Returns null when the loop is gated off. Never throws — errors are logged.
 */
export async function runOnboardingLoopV2Once(): Promise<LoopRunResult | null> {
  if (!registerOnboardingLoopV2()) return null;

  const ports = productionLoopPorts();
  const manifest = getLoopManifest(ONBOARDING_LOOP_ID);
  const result = await runLoop(manifest, ports);

  if (onboardingGate) {
    onboardingGate.drain();
    await postOnboardingDigest(result, ports.slack, manifest.approval.slackUserId);
  }
  return result;
}

async function postOnboardingDigest(
  result: LoopRunResult,
  slack: { postMessage: (channelOrUserId: string, markdown: string) => Promise<unknown> },
  slackUserId: string | undefined,
): Promise<void> {
  if (!slackUserId) {
    console.warn('[onboarding-loop-v2] no approval.slackUserId — skipping DM');
    return;
  }
  const lines: string[] = [];
  lines.push(`*🚀 Onboarding loop — daily run ${new Date().toISOString().slice(0, 10)}*`);
  lines.push(`Run ID: \`${result.runId}\``);
  lines.push(`Users/events scanned: ${result.eventsScanned}  |  Findings: ${result.proposals.length}`);
  lines.push('');

  if (result.eventsScanned === 0) {
    lines.push(`_No onboarding events in the window — too thin to judge._`);
  } else if (result.proposals.length === 0) {
    lines.push(`_Funnel looks healthy — no issues surfaced._`);
  } else {
    lines.push(`*What I found*`);
    for (let i = 0; i < result.proposals.length; i++) {
      const p = result.proposals[i];
      const directive =
        (p.payload as { directive?: string } | undefined)?.directive ?? '';
      lines.push(`${i + 1}. ${p.hypothesis}`);
      lines.push(`   Kind: \`${p.kind}\`${directive ? `  |  Fix: ${directive}` : ''}`);
    }
  }
  lines.push('');
  lines.push(`React ✅ to dispatch all to cloud-dev  |  ❌ to skip  |  🛑 to pause loop`);

  try {
    await slack.postMessage(slackUserId, lines.join('\n'));
  } catch (err) {
    console.error('[onboarding-loop-v2] Slack DM post failed:', err);
  }
}
