/**
 * /ai-eval lander funnel loop manifest.
 *
 * Names which layer impl each step uses + the loop-specific parameters
 * (target metric, mutation surface, thresholds, generator + critic prompts,
 * approval channel).
 */

import type { LoopManifest, NormalizedEvent } from '../../core/types';
import { asLoopId } from '../../core/types';
import type { AiEvalProposalPayload } from './rules';

export const AI_EVAL_LOOP_ID = asLoopId('ai-eval-funnel');

export const aiEvalManifest: LoopManifest<NormalizedEvent, AiEvalProposalPayload> = {
  loopId: AI_EVAL_LOOP_ID,
  displayName: 'AI Eval Lander Funnel',
  paused: false,
  targetMetric: {
    name: 'eval_to_signup_rate',
    numeratorEvent: 'signed_up',
    denominatorEvent: 'form_submitted',
    windowDays: 7,
  },
  allowedEventTypes: [
    'landed',
    'form_submitted',
    'eval_started',
    'eval_completed',
    'eval_failed',
    'eval_abandoned',
    'report_viewed',
    'signup_clicked',
    'signed_up',
    'onboarding_started',
    'complaint_received',
    'icp_match',
  ],
  mutationSurface: [
    { key: 'hero_heading', kind: 'copy' },
    { key: 'hero_cta', kind: 'copy' },
    { key: 'loading_state_message', kind: 'copy' },
    { key: 'report_view_cta', kind: 'copy' },
    { key: 'ai_eval_emma_prompt', kind: 'code_change' },
    { key: 'complaint_review', kind: 'code_change' },
    { key: 'forward_to_onboarding_loop', kind: 'cross_surface_signal' },
  ],
  sensorImpl: 'aiEvalSensor',
  rulesetImpl: 'aiEvalRules',
  toolsImpl: 'aiEvalSpecTool',
  gateImpl: 'aiEvalCaptureGate',
  learningImpl: 'aiEvalLearning',
  thresholds: {
    promoteLiftPct: 15,
    // Lowered from default 80 for the proof window — the framework needs to
    // fire promote/retire decisions to be considered proven, and the lander
    // is launching with limited traffic data.
    promoteMinNPerArm: 30,
    retireLiftPct: -10,
    retireMinNPerArm: 20,
    watchdogRollbackPct24h: 25,
    watchdogPausePct7d: 15,
    maxActiveArmsPerKey: 4,
    maxTokensPerCycleUsd: 3,
  },
  generator: {
    candidatesPerCycle: 30,
    model: 'claude-sonnet-4-6',
    systemPrompt: [
      'You write copy + spec fixes for the AgentWeb /ai-eval landing-page funnel.',
      'Audience: B2B technical founders (ICP-1) evaluating their AI marketing stack.',
      'Voice: direct, founder-to-founder, no jargon, no hedging, no exclamation marks.',
      'Concrete > abstract. Specific numbers > vague qualifiers. Time-anchored > timeless.',
      '',
      'When a code_change is proposed, output a Notion-task-ready spec with: ',
      '  - "What was wrong" (1-2 sentences from triggering data, including any errorSample / complaintSample)',
      '  - "Proposed fix" (concrete code change description; reference the agent-mode endpoint or component file)',
      '  - "Acceptance criteria" (3 behavioral assertions Harsha could verify)',
      '',
      'When a copy mutation is proposed, output exactly the new copy text + a 1-sentence hypothesis.',
      '',
      'Never name competitors. Never promise specific outcomes ("7% CTR", "$10M ARR").',
    ].join('\n'),
  },
  critic: {
    model: 'claude-sonnet-4-6',
    rubric: [
      'brand_voice: matches AgentWeb tone (direct, founder-to-founder, no fluff)',
      'icp_fit: speaks to a B2B technical founder, not a marketer',
      'clarity: a 5th-grader could explain what to do next',
      'length: under 80 chars for hero copy unless explanation required',
      'specificity: concrete > abstract; numbers > qualifiers',
    ],
    minScore: 0.72,
  },
  approval: {
    slackUserId: 'U08TM4QFQ1L', // Harsha
    dmTitleTemplate: '🌅 AI Eval Funnel — {date} ({proposalCount} proposed fixes)',
    autoShipCutoffHourPT: 18,
    autoShipConditions: ['signal_trending_up_or_flat', 'no_business_rule_violations', 'no_watchdog_warnings'],
  },
  businessRules: [
    {
      id: 1,
      rule: 'Cannot mutate variants touching billing, auth, payment, or subscription flow',
      enforcement: 'forbidden_path_prefix',
      pathPrefixes: ['routes/billing', 'routes/auth', 'middleware/auth', 'services/stripe'],
    },
    {
      id: 2,
      rule: 'Cannot generate copy that names competitors',
      enforcement: 'keyword_blacklist',
      keywords: ['Mutiny', 'Jasper', 'Copy.ai', 'Clay', 'Apollo', 'Lavender', 'Smartlead'],
    },
    {
      id: 3,
      rule: 'Cannot promise specific outcomes',
      enforcement: 'keyword_blacklist',
      keywords: ['guaranteed', '$10M', '7% CTR', '10x', '100% conversion'],
    },
    {
      id: 4,
      rule: 'Cannot ship new variants Fri 5pm PT through Mon 9am PT',
      enforcement: 'weekend_freeze',
    },
    {
      id: 5,
      rule: 'Cannot exceed $3/day in Bedrock token spend on this loop',
      enforcement: 'daily_budget_cap',
    },
  ],
};
