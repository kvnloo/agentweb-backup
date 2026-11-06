import type { HotLeadCallConfig } from '../hotLeadCallConfig';
import { toE164 } from '../whatsappService';
import { DAY_S, HOUR_S, limitTimeZone, localDayAndMinutes, slotTaker } from './hotLeadCallLimits';
import { getLimitStore } from './limitStore';
import { keyedDigest } from './keyedDigest';

/**
 * Abuse limits of the inbound callback (ENG-2784): a caller dialling the org's number rings a team member, which is
 * metered money and a ringing phone. The org's caps are twice its outbound caps (maxCallsPerHour, maxCallsPerDay) and
 * each caller has their own, all on the same limit store (new key prefixes only).
 */

// An org's inbound volume is twice its outbound cap: a lead calls back after being rung, and a team that rings leads
// all day should not be blocked from the callbacks that follow. Counted in calls that would ring someone.
const ORG_INBOUND_FACTOR = 2;
// One person redialling is a person who got through or a harasser, never twenty legitimate callbacks: three an hour
// covers a busy line and a retry, six a day covers a lead calling back across a working day.
export const CALLER_MAX_PER_HOUR = 3;
export const CALLER_MAX_PER_DAY = 6;
// Twilio retries a webhook for a call it did not get an answer to; the marker outlives those retries.
const RETRY_MARKER_TTL_S = HOUR_S;

export type InboundDenial = 'org_hourly' | 'org_daily' | 'caller_hourly' | 'caller_daily';
export type InboundReservation = { ok: true } | { ok: false; reason: InboundDenial };

/**
 * The caller's canonical E.164 from Twilio's `From`, or null when it is missing or withheld ('anonymous',
 * 'unknown', ...), which then skips the per-caller counters (the org caps still apply). Any country: a number we
 * would not call back is still a number that can ring the team.
 */
export function inboundCallerE164(from: string | undefined): string | null {
  if (!from) return null;
  const e164 = toE164(from);
  return e164 && e164 === from ? e164 : null;
}

// Keyed hash, never the number (see phoneMarkerKey); its own label, so it is unrelated to the outbound phone marker.
const callerDigest = (orgId: string, callerE164: string): string => keyedDigest('hot_lead_call.inbound_caller', orgId, callerE164);
const utcHour = (at: Date): string => at.toISOString().slice(0, 13);

const inboundOrgHourlyKey = (orgId: string, at: Date): string => `hlc#cap#ih#${orgId}#${utcHour(at)}`;
const inboundOrgDailyKey = (orgId: string, timeZone: string, at: Date): string => `hlc#cap#id#${orgId}#${localDayAndMinutes(timeZone, at).date}`;
const inboundCallerHourlyKey = (orgId: string, callerE164: string, at: Date): string => `hlc#in#p#h#${callerDigest(orgId, callerE164)}#${utcHour(at)}`;
const inboundCallerDailyKey = (orgId: string, callerE164: string, timeZone: string, at: Date): string =>
  `hlc#in#p#d#${callerDigest(orgId, callerE164)}#${localDayAndMinutes(timeZone, at).date}`;
export const inboundCallMarkerKey = (callSid: string): string => `hlc#in#c#${callSid}`;

/**
 * Takes this inbound call's slot, or says which limit refused. Order: a read-only look at the retry marker, then
 * the caller's hourly and daily counters (skipped when `callerE164` is null), then the org's hourly and daily
 * counters, and the marker LAST. A capped caller therefore never touches the org counters, and everything taken is
 * given back when a later limit refuses or the store throws, so a refused call costs nobody a slot.
 * Taken once per call, when a member is about to be rung (not per member attempt).
 *
 * Redelivery (Twilio retries a webhook with the same CallSid): a marker already held by this CallSid means the call
 * was admitted and counted, so it is admitted again without counting. Two deliveries racing both count, then the
 * one whose marker claim loses gives its counts back and is admitted. A refused call never claims the marker, so its
 * redelivery is evaluated afresh. Store failures throw: the caller fails closed.
 */
export async function reserveInboundSlot(input: {
  orgId: string; callSid: string; callerE164: string | null; config: HotLeadCallConfig; now?: Date;
}): Promise<InboundReservation> {
  const { orgId, callSid, callerE164, config } = input;
  const now = input.now ?? new Date();
  const nowS = Math.floor(now.getTime() / 1000);
  const timeZone = limitTimeZone(config);
  const { claim, count, releaseAll } = slotTaker(nowS);
  const store = getLimitStore();

  try {
    const markerKey = inboundCallMarkerKey(callSid);
    if (await store.holder(markerKey, nowS) === callSid) return { ok: true };
    const counters: Array<[InboundDenial, () => Promise<boolean>]> = [];
    if (callerE164) {
      counters.push(
        ['caller_hourly', () => count(inboundCallerHourlyKey(orgId, callerE164, now), CALLER_MAX_PER_HOUR, 2 * HOUR_S)],
        ['caller_daily', () => count(inboundCallerDailyKey(orgId, callerE164, timeZone, now), CALLER_MAX_PER_DAY, 2 * DAY_S)],
      );
    }
    counters.push(
      ['org_hourly', () => count(inboundOrgHourlyKey(orgId, now), ORG_INBOUND_FACTOR * config.maxCallsPerHour, 2 * HOUR_S)],
      ['org_daily', () => count(inboundOrgDailyKey(orgId, timeZone, now), ORG_INBOUND_FACTOR * config.maxCallsPerDay, 2 * DAY_S)],
    );
    for (const [reason, take] of counters) {
      if (!await take()) {
        await releaseAll();
        return { ok: false, reason };
      }
    }
    if (!await claim(markerKey, RETRY_MARKER_TTL_S, callSid)) {
      // The marker is keyed by the CallSid: a live claim that holds it is a concurrent delivery of this same call
      // that won, and it counted already. Anything else (expired between the reads) is not provable: fail closed.
      const winner = await store.holder(markerKey, nowS);
      await releaseAll();
      if (winner === callSid) return { ok: true };
      throw new Error('inbound retry marker is not held by this call');
    }
  } catch (err) {
    await releaseAll();
    throw err;
  }
  return { ok: true };
}
