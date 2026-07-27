/**
 * /ai-readiness lander funnel loop manifest.
 *
 * The flagship AI Marketing Readiness Roadmap funnel (served at
 * www.agentweb.pro/ai-readiness and hireemma.ai/ai-readiness). Unlike the
 * legacy ai-eval loop — which ran fixed threshold rules and defaulted to
 * "no rules fired = healthy" — this instance uses the LLM analyst as its
 * policy and is told to name the BINDING CONSTRAINT every run. At this stage
 * the constraint is almost always top-of-funnel volume, so the analyst is
 * instructed to recommend awareness actions (route existing site traffic in +
 * external volume), not page-copy tweaks on a page only a few dozen people see.
 */

import type { LoopManifest, NormalizedEvent } from '../../core/types';
import { asLoopId } from '../../core/types';
import type { LlmAnalystProposalPayload } from '../../core/policy/llmAnalystRuleSet';

export const AI_READINESS_LOOP_ID = asLoopId('ai-readiness-funnel');

/** The lens the analyst reasons with. Encodes the flow + the binding-constraint
 * discipline so it never defaults to a false "healthy". */
export const AI_READINESS_FLOW_DESCRIPTION = [
  'The /ai-readiness landing-page funnel (AI Marketing Readiness Roadmap lead magnet).',
  'A visitor LANDS (landed), starts the quiz (quiz_started), submits the contact + quiz form',
  '(form_submitted — this is the captured lead; the backend then emails them their stage-specific',
  'roadmap PDF), and is routed to one of two CTAs: qualified leads (ICP-1: marketing leaders at',
  '$1M+ companies) click "book a stack review" (book_clicked); everyone else clicks self-serve',
  'signup (signup_clicked). Goal: more captured leads (form_submitted) and more qualified bookings.',
  '',
  'CRITICAL — the `landed` event fires on EVERY marketing page, carrying a landerPath dimension.',
  'Only landerPath=/ai-readiness are real funnel entries (the sensor already scopes this), so never',
  'treat total landed as the denominator.',
  '',
  'CRITICAL — you MUST name the single BINDING CONSTRAINT every run, and recommend the NEXT BEST',
  'ACTION to relieve it. Never report the funnel as "healthy" just because no page-level issue is',
  'obvious. Reason about altitude: if absolute volume is low (few dozen landings/week), the binding',
  'constraint is TOP-OF-FUNNEL AWARENESS, not on-page conversion — the highest-leverage move is to',
  'route existing site traffic into this lander (the homepage and blog get far more traffic than',
  'this page) and add external volume, NOT to rewrite the hero on a page a few dozen people see.',
  'Only recommend on-page copy/UX changes when the page is getting real traffic AND a specific stage',
  'of the funnel is leaking disproportionately. Quantify the leak you are pointing at.',
].join(' ');

export const aiReadinessManifest: LoopManifest<NormalizedEvent, LlmAnalystProposalPayload> = {
  loopId: AI_READINESS_LOOP_ID,
  displayName: 'AI Readiness Lander Funnel',
  paused: false,
  // On-page capture efficiency: of real /ai-readiness landings, how many become
  // captured leads. The flowDescription tells the analyst that ABSOLUTE volume
  // (form_submitted count) is what actually matters at this stage.
  targetMetric: {
    name: 'landing_to_capture_rate',
    numeratorEvent: 'form_submitted',
    denominatorEvent: 'landed',
    windowDays: 7,
  },
  allowedEventTypes: [
    'landed',
    'quiz_started',
    'form_submitted',
    'book_clicked',
    'signup_clicked',
  ],
  mutationSurface: [
    { key: 'hero_heading', kind: 'copy' },
    { key: 'hero_cta', kind: 'copy' },
    { key: 'quiz_intro', kind: 'copy' },
    { key: 'thankyou_cta', kind: 'copy' },
    { key: 'awareness_routing', kind: 'cross_surface_signal' },
  ],
  sensorImpl: 'aiReadinessSensor',
  rulesetImpl: 'aiReadinessAnalyst',
  toolsImpl: 'aiReadinessSpecTool',
  learningImpl: 'aiReadinessLearning',
  thresholds: {
    promoteLiftPct: 15,
    promoteMinNPerArm: 30,
    retireLiftPct: -10,
    retireMinNPerArm: 20,
    watchdogRollbackPct24h: 25,
    watchdogPausePct7d: 15,
    maxActiveArmsPerKey: 4,
    maxTokensPerCycleUsd: 3,
  },
  // The analyst supplies its own prompt; these satisfy the manifest contract
  // and are used only if a loop ever falls back to the generator/critic path.
  generator: {
    candidatesPerCycle: 3,
    model: 'claude-sonnet-4-6',
    systemPrompt:
      'You write fixes for the AgentWeb /ai-readiness lead-magnet funnel. Audience: B2B marketing ' +
      'leaders (ICP-1). Direct, founder-to-founder voice, no hedging. For a code_change or ' +
      'cross_surface_signal, output a Notion-task-ready spec with what was wrong + the fix + 3 ' +
      'behavioral acceptance assertions. For copy, output the new text + a 1-line hypothesis.',
  },
  critic: {
    model: 'claude-sonnet-4-6',
    rubric: ['clarity', 'addresses_the_evidence', 'right_altitude_not_just_copy', 'low_risk_if_autoship'],
    minScore: 0.7,
  },
  approval: {
    slackUserId: 'U08TM4QFQ1L', // Harsha
    dmTitleTemplate: '🧭 AI Readiness Funnel — {date} ({proposalCount} findings)',
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
      rule: 'Cannot generate copy that names competitors',
      enforcement: 'keyword_blacklist',
      keywords: ['Mutiny', 'Jasper', 'Copy.ai', 'Clay', 'Apollo', 'Lavender', 'Smartlead'],
    },
    {
      id: 3,
      rule: 'Cannot exceed $3/day in Bedrock token spend on this loop',
      enforcement: 'daily_budget_cap',
    },
  ],
};
