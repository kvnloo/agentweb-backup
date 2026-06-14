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

import { CaptureGate } from '../../core/gates/captureGate';
import { SlackReactionGate } from '../../core/gates/slackReactionGate';
import { postLoopDigest, type LoopDigestTemplate } from '../../core/digest/loopDigest';
import { createInstanceRunner } from '../../core/instanceRunner';
import { DynamoLearningStore } from '../../core/learning/dynamoLearningStore';
import { CooldownRuleSet } from '../../core/policy/cooldownRuleSet';
import { EventTableEventSource } from '../../core/sensors/eventTableEventSource';
import { SpecOutputTool } from '../../core/tools/specOutputTool';
import { productionLoopPorts } from '../../adapters/awsAdapters';
import type { LoopRunResult } from '../../core/types';
import { AGENT_MODE_LOOP_ID } from './eventTypes';
import { AgentFailureRuleSet } from './failureRuleSet';
import { agentModeManifest } from './manifest';
import { AgentRunRecorder } from './runRecorder';

let recorderSingleton: AgentRunRecorder | null = null;

const runner = createInstanceRunner({
  loopId: AGENT_MODE_LOOP_ID,
  ports: productionLoopPorts,
  implNames: {
    sensor: 'agentModeSensor',
    ruleSet: 'agentModeFailurePolicy',
    tools: 'agentModeSpecTool',
    gate: 'agentModeGate',
    learning: 'agentModeLearning',
  },
  buildLayers: (ports) => {
    const learning = new DynamoLearningStore(ports.dynamo);
    return {
      sensor: new EventTableEventSource(ports.dynamo, AGENT_MODE_LOOP_ID),
      ruleSet: new CooldownRuleSet(new AgentFailureRuleSet(), learning, AGENT_MODE_LOOP_ID),
      tools: new SpecOutputTool(AGENT_MODE_LOOP_ID, ['cloud-dev', 'auto-loop', 'agent-mode']),
      gate: new CaptureGate(),
      learning,
    };
  },
  manifest: () => agentModeManifest,
  onRunComplete: async ({ result, drained, ports, manifest }) => {
    if (drained === null) return;
    await postLoopDigest(result, ports.slack, manifest.approval.slackUserId, agentModeDigestTemplate, drained.length);
  },
});

/**
 * Register the loop. Idempotent. Does NOT reset the registry, so it coexists
 * with the funnel loops regardless of boot order.
 */
export function registerAgentModeLoop(): void {
  runner.register();
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
 * Opt-in flag for the real Slack-reaction approval gate (INCREMENT C1).
 *
 * Production still runs `CaptureGate` (pollDecision() always pending, so
 * shippedAt is never stamped). This flag gates the SlackReactionGate capability
 * WITHOUT auto-flipping the live runner: the runner's drain path is tied to
 * CaptureGate, so promoting this gate into the runner is a separate, larger
 * wiring change. This increment ships the capability + tests behind the flag;
 * Harsha enables + wires it explicitly. Default OFF.
 */
export function isSlackReactionGateEnabled(): boolean {
  return process.env.AGENT_MODE_SLACK_REACTION_GATE === 'true';
}

/**
 * Factory for the agent-mode Slack-reaction approval gate. Returns null when the
 * flag is off so callers stay on CaptureGate. The gate resolves ✅/❌ on the
 * proposal DM into a decision and stamps shippedAt on approval (Layer 4→5).
 *
 * Wiring is intentionally deferred: this builds the gate, it does not register
 * it as the loop's `gateImpl`. See isSlackReactionGateEnabled() for why.
 */
export function buildAgentModeSlackReactionGate(): SlackReactionGate | null {
  if (!isSlackReactionGateEnabled()) return null;
  const ports = productionLoopPorts();
  return new SlackReactionGate({
    slack: ports.slack,
    approver: agentModeManifest.approval.slackUserId ?? '',
    clock: ports.clock,
    channel: agentModeManifest.approval.slackChannel,
    dmTitle: agentModeManifest.displayName,
  });
}

/**
 * Run one analysis tick: register, run the orchestrator over the 7d window,
 * drain the gate, and DM the failing-tool fix specs. Never throws — errors are
 * logged. Scheduled from server.ts behind AGENT_MODE_LOOP_ENABLED.
 */
export async function runAgentModeLoopOnce(): Promise<LoopRunResult> {
  // Never null: this instance has no env gate, so register() always succeeds.
  return (await runner.runOnce()) as LoopRunResult;
}

/** TExtra = the count of fix specs drained from the gate this tick. */
const agentModeDigestTemplate: LoopDigestTemplate<number> = {
  logTag: '[agent-mode-loop]',
  header: (date) => `*🤖 Agent Mode — tool reliability ${date}*`,
  counts: (result) =>
    `Tool events scanned: ${result.eventsScanned}  |  Failing tools: ${result.proposals.length}`,
  emptyBody: () => [
    `_No agent-mode tool events in the 7d window — recorder off, or no tool use. Not "healthy", just empty._`,
  ],
  quietBody: () => [
    `_No tool crossed the failure threshold this window. Tool reliability looks healthy._`,
  ],
  findingsBody: (result, drainedCount) => [
    `*Failing tools (fix specs dispatched: ${drainedCount})*`,
    ...result.proposals.map((p, i) => `${i + 1}. ${p.hypothesis}`),
  ],
};

/** Test seam. */
export const _internal = {
  get agentModeGate() {
    return runner.gate;
  },
  resetForTesting() {
    runner.resetForTesting();
    recorderSingleton = null;
  },
};
