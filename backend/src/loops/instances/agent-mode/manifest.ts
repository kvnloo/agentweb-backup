/**
 * Agent-mode loop manifest.
 *
 * AgentMode/Emma as a first-class loop instance — same 4 layers, same registry,
 * same attribution cron + health endpoint as the funnel loops. This is the
 * audit's "plug AgentMode into the same apparatus" made concrete:
 *
 *   sensor   = EventTableEventSource over Dev-AW-LoopEvents (loopId=agent-mode)
 *   policy   = AgentFailureRuleSet (cluster tool failures) wrapped in
 *              CooldownRuleSet (don't re-propose an in-flight / failed fix)
 *   tools    = SpecOutputTool (emit a cloud-dev fix spec — the AgentLearningEvent)
 *   learning = DynamoLearningStore (durable decision + outcome records)
 *
 * Target metric = tool reliability: agent_tool_succeeded / agent_tool_invoked.
 * Attribution grades whether a shipped tool fix actually lifted that rate.
 */

import type { LoopManifest, NormalizedEvent } from '../../core/types';
import { AGENT_MODE_EVENT_TYPES, AGENT_MODE_LOOP_ID, EVT_TOOL_INVOKED, EVT_TOOL_SUCCEEDED } from './eventTypes';
import type { AgentFailureProposalPayload } from './failureRuleSet';

export const agentModeManifest: LoopManifest<NormalizedEvent, AgentFailureProposalPayload> = {
  loopId: AGENT_MODE_LOOP_ID,
  displayName: 'Agent Mode — Tool Reliability',
  paused: false,
  targetMetric: {
    name: 'tool_success_rate',
    numeratorEvent: EVT_TOOL_SUCCEEDED,
    denominatorEvent: EVT_TOOL_INVOKED,
    windowDays: 7,
  },
  allowedEventTypes: AGENT_MODE_EVENT_TYPES,
  // The loop proposes code-change fix specs for failing tools; it never mutates
  // copy or product surfaces directly. The "surface" is the tool handler set.
  mutationSurface: [{ key: 'agent_tool_handler', kind: 'code_change' }],
  sensorImpl: 'agentModeSensor',
  rulesetImpl: 'agentModeFailurePolicy',
  toolsImpl: 'agentModeSpecTool',
  learningImpl: 'agentModeLearning',
  thresholds: {
    // A shipped tool fix must lift the tool's success rate by >=10% over the
    // window with >=20 graded invocations to count as "improved".
    promoteLiftPct: 10,
    promoteMinNPerArm: 20,
    retireLiftPct: -10,
    retireMinNPerArm: 20,
    watchdogRollbackPct24h: 25,
    watchdogPausePct7d: 15,
    // One proposal per failing tool; the surface has 1 key so the orchestrator
    // cap = maxActiveArmsPerKey * 1. Keep this generous — many tools can be
    // failing at once and each deserves its own task.
    maxActiveArmsPerKey: 8,
    maxTokensPerCycleUsd: 1,
  },
  generator: {
    candidatesPerCycle: 1,
    model: 'claude-sonnet-4-6',
    systemPrompt:
      'You write robustness fixes for AgentWeb agent-mode tool handlers. Given a failing tool + its ' +
      'dominant error class, output a cloud-dev-ready spec: the suspected root cause, the handler fix ' +
      '(validation / retry / clearer error), and a regression test that reproduces the failure.',
  },
  critic: {
    model: 'claude-sonnet-4-6',
    rubric: ['addresses_the_error_class', 'has_regression_test', 'low_blast_radius'],
    minScore: 0.7,
  },
  approval: {
    // Harsha — same operator as the funnel loops.
    slackUserId: 'U08TM4QFQ1L',
    dmTitleTemplate: '🤖 Agent Mode tool reliability — {date} ({proposalCount} failing tools)',
    // Code changes are NEVER auto-shipped — always require a human.
    autoShipConditions: [],
  },
  businessRules: [
    {
      id: 1,
      rule: 'Cannot mutate billing, auth, payment, or subscription flow',
      enforcement: 'forbidden_path_prefix',
      pathPrefixes: ['routes/billing', 'routes/auth', 'middleware/auth', 'services/stripe'],
    },
  ],
};
