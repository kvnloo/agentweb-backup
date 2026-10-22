import { orgDb } from '../db';
import { isTwilioNumberSid } from '../hotLeadCallConfig';
import { recordVendorUsage } from '../usageRecorderService';
import { getRecordingUnit } from '../../utils/vendorRateCard';

/**
 * Monthly rent of a hot-lead caller number (ENG-2614).
 *
 * Rent is billed per calendar UTC month. The purchase meters the first month and a daily sweep meters the
 * current month for every org that holds a number. Both use ONE idempotency key per (sid, month), built here,
 * so in the purchase month the sweep's write is a duplicate no-op and a later month produces a new event.
 */

/** Kill switch, default ON: set HOT_LEAD_CALL_RENT_METERING to 0, false or off to stop the sweep. */
export function isRentMeteringEnabled(): boolean {
  const raw = process.env.HOT_LEAD_CALL_RENT_METERING?.trim().toLowerCase();
  return !(raw === '0' || raw === 'false' || raw === 'off');
}

/** The spend-event key for one number and the UTC month containing `now`. */
export function numberRentKey(sid: string, now: Date = new Date()): string {
  return `twilio:number:${sid}:${now.toISOString().slice(0, 7)}`;
}

export type RentMeterResult = 'recorded' | 'no_rate_unit' | 'error';

/**
 * Meters one number's rent for the month of `now`. The recorder cannot be told a date (a vendor context has no
 * occurredAt), so the event is dated when it is written and only the key carries the month from `now`.
 * recordVendorUsage returns nothing, so 'recorded' means "handed over without an exception": a lost write is
 * retried by the next sweep and is reported by the recorder's own dropped-write alert.
 */
export async function meterNumberRent(userId: string, sid: string, now: Date = new Date()): Promise<RentMeterResult> {
  const unit = getRecordingUnit('twilio', 'number_monthly_rent');
  if (!unit) {
    console.error('[hotLeadCall] number rent not metered: twilio number_monthly_rent is missing from the rate card');
    return 'no_rate_unit';
  }
  // recordVendorUsage should never throw, but a caller after a purchase must not lose its own handling to it.
  try {
    await recordVendorUsage({
      userId, provider: 'twilio', operation: 'number_monthly_rent', feature: 'hot_lead_call', unit, quantity: 1,
      rateKey: 'number_monthly_rent', idempotencyKey: numberRentKey(sid, now),
    });
    return 'recorded';
  } catch {
    console.error(`[hotLeadCall] number rent metering failed for sid ${sid}; meter it manually`);
    return 'error';
  }
}

export interface NumberRentSweepSummary {
  enabled: boolean;
  scanned: number;
  withNumber: number;
  metered: number;
  skippedNoOwner: number;
  skippedInvalidSid: number;
  skippedNoRateUnit: number;
  failed: number;
}

/** A skipped org is a missed charge, so each one is logged loudly with its reason (no phone number). */
const logSkip = (orgId: string, reason: string) =>
  console.error(`[hotLeadCall] number rent NOT metered for org ${orgId}: ${reason}`);

/** Meters the current month's rent for every org that holds a number. One org's failure never stops the rest. */
export async function runNumberRentSweep(now: Date = new Date()): Promise<NumberRentSweepSummary> {
  const summary: NumberRentSweepSummary = {
    enabled: isRentMeteringEnabled(), scanned: 0, withNumber: 0, metered: 0,
    skippedNoOwner: 0, skippedInvalidSid: 0, skippedNoRateUnit: 0, failed: 0,
  };
  if (!summary.enabled) return summary;

  for (const org of await orgDb.listAll()) {
    summary.scanned++;
    try {
      const sid = org.hotLeadCall?.twilioNumberSid;
      if (!sid) continue;
      summary.withNumber++;
      if (!isTwilioNumberSid(sid)) { summary.skippedInvalidSid++; logSkip(org.orgId, 'stored number sid is invalid'); continue; }
      if (!org.ownerUserId) { summary.skippedNoOwner++; logSkip(org.orgId, 'org has no owner'); continue; }
      const result = await meterNumberRent(org.ownerUserId, sid, now);
      if (result === 'recorded') summary.metered++;
      else if (result === 'no_rate_unit') summary.skippedNoRateUnit++; // already logged once by meterNumberRent
      else summary.failed++;
    } catch (err) {
      summary.failed++;
      console.error(`[hotLeadCall] number rent sweep failed for org ${org.orgId}:`, err instanceof Error ? err.message : err);
    }
  }
  return summary;
}
