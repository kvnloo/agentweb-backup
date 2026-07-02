/**
 * Funnel-cascade rules for the /ai-eval landing-page loop.
 *
 * Per ACCEPTANCE_SPEC.md, these rules translate the founder's stated
 * funnel logic into the policy DSL:
 *   - Top of funnel weak → propose hero+CTA rewrites
 *   - Capture broken (lots of landed, few form submits) → propose form copy + heading mutations
 *   - Eval failing (lots of failures) → flag agent prompt + loading state messaging
 *   - Eval timing out → propose UX changes around the wait
 *   - No signup despite completion → propose ReportView CTA mutations
 *   - Signed up but no onboarding → cross-surface signal to the onboarding loop
 */

import type { Rule } from '../../core/types';

export interface AiEvalProposalPayload {
  /** Mutation surface key that the proposal targets. */
  targetKey: string;
  /** Optional structured directive the Generator consumes (e.g. "rewrite for
   * urgency", "show a progress indicator"). */
  directive: string;
  /** Whether this proposal can be auto-shipped at the 6pm cutoff if Harsha
   * doesn't respond (copy edits = safe; emma prompt changes = not safe). */
  autoShipSafe: boolean;
}

export const aiEvalRules: readonly Rule<AiEvalProposalPayload>[] = [
  {
    id: 'top-of-funnel-cold',
    // Scope to /ai-eval landings only. <LandedTracker/> fires `landed` on EVERY
    // frontend page (carrying dimensions.landerPath), so an unscoped count mixes
    // blog/home/etc. traffic into the /ai-eval funnel.
    when: 'landed_count[landerPath=/ai-eval] < 100 over 7d',
    then: {
      hypothesis:
        'Top of funnel is cold — fewer than 100 /ai-eval landings in the last 7 days. ' +
        'Propose stronger hero + CTA rewrites; flag ad creative refresh in the Slack DM.',
      kind: 'copy',
      payload: {
        targetKey: 'hero_heading',
        directive: 'rewrite hero for urgency + specificity; assume reader skimmed at most one line',
        autoShipSafe: true,
      },
    },
    priority: 50,
  },
  {
    id: 'capture-broken',
    // Two corrections vs the original `form_submitted_count / landed_count`:
    //  1. Denominator scoped to landerPath=/ai-eval — `landed` fires on every
    //     frontend page, so dividing /ai-eval submits by site-wide landings made
    //     this rule a permanent false alarm.
    //  2. Numerator uses server-confirmed `eval_started` (fired by the backend
    //     when the capture POST creates a session) instead of the client-side
    //     `form_submitted`, which silently under-fires (ad-block / navigation
    //     drops the beacon). Both events are /ai-eval-only, so no filter needed
    //     on the numerator.
    when: 'eval_started_count / landed_count[landerPath=/ai-eval] < 0.1 over 7d',
    then: {
      hypothesis:
        'Lots of /ai-eval landings but very few capture (server-confirmed eval starts) — capture is broken. ' +
        'Propose hero_heading and form-label mutations that lower perceived effort.',
      kind: 'copy',
      payload: {
        targetKey: 'hero_heading',
        directive: 'rewrite to make the eval feel zero-cost; emphasize speed + no signup required',
        autoShipSafe: true,
      },
    },
    priority: 80,
  },
  {
    id: 'eval-failing',
    when: 'eval_failed_count / eval_started_count > 0.2 over 7d',
    then: {
      hypothesis:
        'More than 20% of started evals are failing. ' +
        'Open a cloud-dev task to investigate the agent prompt + propose loading-state copy that acknowledges difficulty.',
      kind: 'code_change',
      payload: {
        targetKey: 'ai_eval_emma_prompt',
        directive:
          'investigate AI_GTM_Position_Eval agent failures using sample error text from the triggering data; ' +
          'open a PR to make the agent more robust',
        autoShipSafe: false,
      },
    },
    priority: 100,
  },
  {
    id: 'wait-too-long',
    when: 'eval_abandoned_count > 0 over 7d',
    then: {
      hypothesis:
        'Users are abandoning during the polling wait. ' +
        'Propose loading-state messaging that surfaces progress + give an "I will email you the report" option.',
      kind: 'copy',
      payload: {
        targetKey: 'loading_state_message',
        directive:
          'rewrite the polling-loop status messages to feel like progress not waiting; ' +
          'add an opt-in for asynchronous email delivery of the report',
        autoShipSafe: true,
      },
    },
    priority: 90,
  },
  {
    id: 'no-signup',
    when: 'signup_clicked_count / eval_completed_count < 0.1 over 7d',
    then: {
      hypothesis:
        'Users complete the eval but few click signup. ' +
        'Propose ReportView CTA copy + flag the signup-flow audit task.',
      kind: 'copy',
      payload: {
        targetKey: 'report_view_cta',
        directive: 'rewrite the ReportView CTA to convert eval completers into signups',
        autoShipSafe: true,
      },
    },
    priority: 70,
  },
  {
    id: 'sign-then-bail',
    when: 'signed_up but no onboarding_started within 24h',
    then: {
      hypothesis:
        'Users sign up but never start onboarding within 24h. ' +
        'Cross-surface signal — forward this to the onboarding loop for handoff investigation.',
      kind: 'cross_surface_signal',
      payload: {
        targetKey: 'forward_to_onboarding_loop',
        directive: 'forward this triggering data to the onboarding loop',
        autoShipSafe: false,
      },
    },
    priority: 40,
  },
];
