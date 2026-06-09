/**
 * Registers + runs the agent-mode tool-reliability loop (framework instance).
 *
 * AgentMode plugged into the SAME apparatus as the funnel loops:
 *   - The recorder writes run/decision/tool/outcome events into Dev-AW-LoopEvents.
 *   - This loop's sensor reads them, the policy clusters tool failures, the
 *     tools layer emits a cloud-dev fix spec, the gate DMs Harsha, and the
 *     learning store records the durable decision + (later) outcome.
 *   - The generic attribution cron grades shipped fixes; the health endpoint
 *     surfaces the loop's state — both with zero agent-mode-specific code.
 *
 * Registration is ALWAYS performed (so the loop is visible to health + the
 * ingestion route accepts agent-mode events). The recorder hook on the chat hot
 * path is gated by AGENT_RUNTIME_SPINE_ENABLED so staging can test shadow-mode
 * telemetry without enabling the daily learning loop. The daily analysis run is
 * gated separately by AGENT_MODE_LOOP_ENABLED.
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
} from '../../index';
import { CaptureGate } from '../../core/gates/captureGate';
import { DynamoLearningStore } from '../../core/learning/dynamoLearningStore';
import { CooldownRuleSet } from '../../core/policy/cooldownRuleSet';
import { EventTableEventSource } from '../../core/sensors/eventTableEventSource';
import { SpecOutputTool } from '../../core/tools/specOutputTool';
import { runLoop } from '../../core/orchestrator';
import { productionLoopPorts } from '../../adapters/awsAdapters';
import type { LoopRunResult } from '../../core/types';
import { AGENT_MODE_LOOP_ID } from './eventTypes';
import { AgentFailureRuleSet } from './failureRuleSet';
import { agentModeManifest } from './manifest';
import { AgentRunRecorder } from './runRecorder';

let agentModeGate: CaptureGate | null = null;
let recorderSingleton: AgentRunRecorder | null = null;

/**
 * Register the loop. Idempotent. Does NOT reset the registry, so it coexists
 * with the funnel loops regardless of boot order.
 */
export function registerAgentModeLoop(): void {
  if ((getRegisteredLoopIds() as readonly string[]).includes(AGENT_MODE_LOOP_ID)) return;

  const ports = productionLoopPorts();

  const sensor = new EventTableEventSource(ports.dynamo, AGENT_MODE_LOOP_ID);
  const learning = new DynamoLearningStore(ports.dynamo);
  const policy = new AgentFailureRuleSet();
  const ruleSet = new CooldownRuleSet(policy, learning, AGENT_MODE_LOOP_ID);
  const tools = new SpecOutputTool(AGENT_MODE_LOOP_ID, ['cloud-dev', 'auto-loop', 'agent-mode']);
  const gate = new CaptureGate();

  registerOrReplaceSensor('agentModeSensor', sensor);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerOrReplaceRuleSet('agentModeFailurePolicy', ruleSet as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerOrReplaceTools('agentModeSpecTool', tools as any);
  registerOrReplaceGate('agentModeGate', gate);
  registerOrReplaceLearningStore('agentModeLearning', learning);
  registerOrReplaceLoop(agentModeManifest);

  agentModeGate = gate;
}

/**
 * Lazily build the singleton recorder used by the agent-mode hot path. Returns
 * null when the runtime spine is disabled, so the hook is a cheap no-op in that
 * case. AGENT_MODE_LOOP_ENABLED also enables the recorder for backwards
 * compatibility, but staging should prefer AGENT_RUNTIME_SPINE_ENABLED=true
 * when testing observability-only telemetry.
 */
export function getAgentRunRecorder(): AgentRunRecorder | null {
  if (!isAgentRuntimeSpineEnabled()) return null;
  if (!recorderSingleton) {
    const ports = productionLoopPorts();
    recorderSingleton = new AgentRunRecorder(ports.dynamo, ports.clock);
  }
  return recorderSingleton;
}

export function isAgentRuntimeSpineEnabled(): boolean {
  return process.env.AGENT_RUNTIME_SPINE_ENABLED === 'true'
    || process.env.AGENT_MODE_LOOP_ENABLED === 'true';
}

/**
 * Run one analysis tick: register, run the orchestrator over the 7d window,
 * drain the gate, and DM the failing-tool fix specs. Never throws — errors are
 * logged. Scheduled from server.ts behind AGENT_MODE_LOOP_ENABLED.
 */
export async function runAgentModeLoopOnce(): Promise<LoopRunResult> {
  registerAgentModeLoop();

  const ports = productionLoopPorts();
  const manifest = getLoopManifest(AGENT_MODE_LOOP_ID);
  const result = await runLoop(manifest, ports);

  if (agentModeGate) {
    const drained = agentModeGate.drain();
    await postDigest(result, drained.length, ports.slack, manifest.approval.slackUserId);
  }

  return result;
}

async function postDigest(
  result: LoopRunResult,
  drainedCount: number,
  slack: { postMessage: (channelOrUserId: string, markdown: string) => Promise<unknown> },
  slackUserId: string | undefined,
): Promise<void> {
  if (!slackUserId) {
    console.warn('[agent-mode-loop] no approval.slackUserId — skipping DM');
    return;
  }
  const lines: string[] = [];
  lines.push(`*🤖 Agent Mode — tool reliability ${new Date().toISOString().slice(0, 10)}*`);
  lines.push(`Run ID: \`${result.runId}\``);
  lines.push(`Tool events scanned: ${result.eventsScanned}  |  Failing tools: ${result.proposals.length}`);
  lines.push('');

  if (result.eventsScanned === 0) {
    lines.push(`_No agent-mode tool events in the 7d window — recorder off, or no tool use. Not "healthy", just empty._`);
  } else if (result.proposals.length === 0) {
    lines.push(`_No tool crossed the failure threshold this window. Tool reliability looks healthy._`);
  } else {
    lines.push(`*Failing tools (fix specs dispatched: ${drainedCount})*`);
    for (let i = 0; i < result.proposals.length; i++) {
      const p = result.proposals[i];
      lines.push(`${i + 1}. ${p.hypothesis}`);
    }
  }
  lines.push('');
  lines.push(`React ✅ to dispatch all to cloud-dev  |  ❌ to skip  |  🛑 to pause loop`);

  try {
    await slack.postMessage(slackUserId, lines.join('\n'));
  } catch (err) {
    console.error('[agent-mode-loop] Slack DM post failed:', err);
  }
}

/** Test seam. */
export const _internal = {
  get agentModeGate() {
    return agentModeGate;
  },
  resetForTesting() {
    agentModeGate = null;
    recorderSingleton = null;
  },
};
