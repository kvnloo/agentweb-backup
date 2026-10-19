import { recordVendorUsage } from '../usageRecorderService';

export type CallLeg = 'owner' | 'lead';

export interface CallUsage {
  /** The user the call was placed for; the recorder resolves their org billing owner. */
  userId: string;
  callSid: string;
  leg: CallLeg;
  durationSeconds: number;
}

/**
 * Twilio's pricing page states a per-minute rate and does not state a rounding
 * rule (checked 2026-10-19), so round UP: over-allocating a partial minute is
 * the safe side for credit drawdown, and the rate is provisional anyway.
 */
export function billableMinutes(durationSeconds: number): number {
  return Number.isFinite(durationSeconds) && durationSeconds > 0 ? Math.ceil(durationSeconds / 60) : 0;
}

/**
 * Meter one call leg. Both legs are outbound dials from our number. The key is
 * per (callSid, leg), so Twilio's status-callback retries count once. Priced
 * via `rateKey` so a missing rate is recorded unpriced inside the recorder's
 * never-throw boundary rather than failing the call flow.
 */
export async function recordCallUsage(usage: CallUsage): Promise<void> {
  const quantity = billableMinutes(usage.durationSeconds);
  // An unanswered leg has no duration and bills nothing.
  if (quantity === 0) return;
  try {
    await recordVendorUsage({
      userId: usage.userId,
      provider: 'twilio',
      operation: 'voice_minute_outbound',
      feature: 'hot_lead_call',
      unit: 'minute',
      quantity,
      rateKey: 'voice_minute_outbound',
      idempotencyKey: `twilio:voice:${usage.callSid}:${usage.leg}`,
    });
  } catch (error) {
    console.error(
      'voiceUsage: failed to meter call leg (call unaffected):',
      error instanceof Error ? error.message : error,
    );
  }
}
