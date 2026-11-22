/**
 * ENG-2504 (child of ENG-2167): pure completion -> newsletter-segment routing decision.
 *
 * Maps a finished drip sequence (evaluator outcome or stop reason) to a follow-up
 * segment action. No persistence, network, Resend, or ATO calls — the caller owns
 * applying the decision. Fails closed: anything other than a delivered no-response
 * completion with a configured segment returns `none`.
 */
import type { StopReason } from './dripSequenceEvaluator';

export type CompletionOutcome = 'no_response' | StopReason;

export interface CompletionRoutingConfig {
  noResponseSegment?: string | null;
}

export type CompletionRoutingDecision =
  | { action: 'add_to_segment'; segment: string }
  | {
      action: 'none';
      reason: StopReason | 'completed_no_sends' | 'no_segment_configured' | 'unknown_outcome';
    };

const STOP_REASONS: ReadonlySet<string> = new Set<StopReason>(['replied', 'booked', 'unsubscribed', 'bounced']);

export function completionRouting(
  outcome: CompletionOutcome,
  everDelivered: boolean,
  config: CompletionRoutingConfig,
): CompletionRoutingDecision {
  // Stop reasons first: unsubscribed/bounced are compliance exits; replied/booked belong to sales.
  if (STOP_REASONS.has(outcome)) return { action: 'none', reason: outcome as StopReason };
  if (outcome !== 'no_response') return { action: 'none', reason: 'unknown_outcome' };
  // Never enroll an untouched lead in a newsletter.
  if (!everDelivered) return { action: 'none', reason: 'completed_no_sends' };
  const segment = config.noResponseSegment?.trim();
  if (!segment) return { action: 'none', reason: 'no_segment_configured' };
  return { action: 'add_to_segment', segment };
}
