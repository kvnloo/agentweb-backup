/**
 * ENG-2544 (child of ENG-2167): pure Resend webhook -> drip SequenceEvent mapper.
 *
 * Turns a Resend webhook payload into the stop event the drip evaluator
 * (`nextSequenceAction`) consumes. No persistence or network. Fails closed:
 * anything that is not a hard bounce or complaint with a valid timestamp
 * returns null, so a soft bounce or malformed payload never stops a sequence
 * and the caller never substitutes the current time.
 */
import type { SequenceEvent } from './dripSequenceEvaluator';
import { normalizeResendEvent } from '../utils/resendWebhookEvents';

export function resendStopEvent(payload: unknown): SequenceEvent | null {
  const result = normalizeResendEvent(payload);
  if (!result.ok) return null;
  const { kind, occurredAt } = result.event;
  let type: 'bounced' | 'unsubscribed';
  if (kind === 'hard_bounce') type = 'bounced';
  else if (kind === 'complaint') type = 'unsubscribed'; // complaint is a compliance exit
  else return null;
  if (!occurredAt) return null;
  const at = Date.parse(occurredAt);
  if (!Number.isFinite(at)) return null;
  return { type, at };
}
