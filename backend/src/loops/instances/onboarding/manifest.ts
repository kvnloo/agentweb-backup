/**
 * Onboarding loop manifest — framework port (Phase 2, REVAMP scope).
 *
 * Unlike the legacy onboarding loop (a threshold heartbeat that just reported
 * "N people tried"), this instance uses the LLM analyst as its policy: it
 * reasons over the real onboardingEvents[] journeys and surfaces concrete
 * issues + fixes. Target metric is a real OUTCOME (completion rate), not a
 * proxy — per the local-maxima guardrail.
 */

import type { LoopManifest, NormalizedEvent } from '../../core/types';
import { asLoopId } from '../../core/types';
import type { LlmAnalystProposalPayload } from '../../core/policy/llmAnalystRuleSet';

export const ONBOARDING_LOOP_ID = asLoopId('onboarding');

/** The lens the analyst reasons with. Encodes the flow + what to watch for. */
export const ONBOARDING_FLOW_DESCRIPTION = [
  'AgentWeb onboarding. A user signs up, picks a goal (goal_selected), submits brand info',
  '(brand_submitted, or brand_skipped), picks a channel (channel_selected), optionally provides',
  'data (data_skipped if skipped), Emma generates ads (ads_generated / ads_regenerated), sees a',
  'welcome offer (welcome_offer_shown -> welcome_offer_outcome), and finishes (onboarding_completed).',
  'Users may skip the whole thing (onboarding_skipped) or hit a "deviation" (went off the expected',
  'path). Goal: more signed-up users reach onboarding_completed.',
  '',
  'Watch especially for: users LOOPING BACK to an earlier step (e.g. goal_selected firing again',
  'AFTER channel_selected = broken back-navigation / a step reset); "deviation" events that precede',
  'a drop or skip; and a high onboarding_skipped rate. Reason about the journeys, not just counts.',
].join(' ');

export const onboardingManifest: LoopManifest<NormalizedEvent, LlmAnalystProposalPayload> = {
  loopId: ONBOARDING_LOOP_ID,
  displayName: 'Onboarding Funnel',
  paused: false,
  // Real outcome metric (completion rate), not a proxy: of users who entered
  // the flow (goal_selected), how many finished (onboarding_completed).
  targetMetric: {
    name: 'onboarding_completion_rate',
    numeratorEvent: 'onboarding_completed',
    denominatorEvent: 'goal_selected',
    windowDays: 7,
  },
  allowedEventTypes: [
    'signed_up',
    'onboarding_started',
    'goal_selected',
    'brand_submitted',
    'brand_skipped',
    'channel_selected',
    'data_skipped',
    'ads_generated',
    'ads_regenerated',
    'welcome_offer_shown',
    'welcome_offer_outcome',
    'onboarding_completed',
    'onboarding_skipped',
    'deviation',
  ],
  // Structural changes allowed, not just copy — so the loop can escape a
  // local maximum (guardrail #1), not just polish wording on a broken flow.
  mutationSurface: [
    { key: 'onboarding_flow_structure', kind: 'code_change' },
    { key: 'step_navigation', kind: 'code_change' },
    { key: 'step_copy', kind: 'copy' },
    { key: 'welcome_offer_copy', kind: 'copy' },
  ],
  sensorImpl: 'onboardingUserSensor',
  rulesetImpl: 'onboardingAnalyst',
  toolsImpl: 'onboardingSpecTool',
  gateImpl: 'onboardingGate',
  learningImpl: 'onboardingLearning',
  thresholds: {
    promoteLiftPct: 15,
    promoteMinNPerArm: 20,
    retireLiftPct: -10,
    retireMinNPerArm: 15,
    watchdogRollbackPct24h: 25,
    watchdogPausePct7d: 15,
    maxActiveArmsPerKey: 4,
    maxTokensPerCycleUsd: 3,
  },
  // The analyst supplies its own prompt; these satisfy the manifest contract
  // and are used if a loop ever falls back to the generator/critic path.
  generator: {
    candidatesPerCycle: 3,
    model: 'claude-sonnet-4-6',
    systemPrompt:
      'You write onboarding fixes for AgentWeb. Direct, founder-to-founder voice. ' +
      'For code_change, output a Notion-task-ready spec with what was wrong + the fix + ' +
      '3 behavioral acceptance assertions. For copy, output the new text + a 1-line hypothesis.',
  },
  critic: {
    model: 'claude-sonnet-4-6',
    rubric: ['clarity', 'addresses_the_evidence', 'low_risk_if_autoship'],
    minScore: 0.7,
  },
  approval: {
    slackUserId: 'U08TM4QFQ1L', // Harsha
    dmTitleTemplate: '🚀 Onboarding loop — {date} ({proposalCount} findings)',
    autoShipCutoffHourPT: 18,
    autoShipConditions: ['no_business_rule_violations', 'no_watchdog_warnings'],
  },
  businessRules: [
    {
      id: 1,
      rule: 'Cannot mutate billing, auth, payment, or subscription flow',
      enforcement: 'forbidden_path_prefix',
      pathPrefixes: ['routes/billing', 'routes/auth', 'middleware/auth', 'services/stripe'],
    },
    {
      id: 2,
      rule: 'Cannot exceed $3/day in Bedrock token spend on this loop',
      enforcement: 'daily_budget_cap',
    },
  ],
};
