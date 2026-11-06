import type { HotLeadCallConfig } from '../hotLeadCallConfig';
import { toE164 } from '../whatsappService';
import { DAY_S, HOUR_S, localDayAndMinutes, slotTaker } from './hotLeadCallLimits';
import { getLimitStore } from './limitStore';
import { keyedDigest } from './keyedDigest';

/**
 * Abuse limits of the inbound callback (ENG-2784): a caller dialling the org's number rings a team member, which is
 * metered money and a ringing phone, so it is capped like the outbound path, on the same limit store (new key
 * prefixes only).
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
export type InboundReservation = { ok: true; release: () => Promise<void> } | { ok: false; reason: InboundDenial };

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

export const inboundOrgHourlyKey = (orgId: string, at: Date): string => `hlc#cap#ih#${orgId}#${utcHour(at)}`;
export const inboundOrgDailyKey = (orgId: string, timeZone: string, at: Date): string => `hlc#cap#id#${orgId}#${localDayAndMinutes(timeZone, at).date}`;
export const inboundCallerHourlyKey = (orgId: string, callerE164: string, at: Date): string => `hlc#in#p#h#${callerDigest(orgId, callerE164)}#${utcHour(at)}`;
export const inboundCallerDailyKey = (orgId: string, callerE164: string, timeZone: string, at: Date): string =>
  `hlc#in#p#d#${callerDigest(orgId, callerE164)}#${localDayAndMinutes(timeZone, at).date}`;
export const inboundCallMarkerKey = (callSid: string): string => `hlc#in#c#${callSid}`;

/**
 * Takes this inbound call's slot, or says which limit refused. In order: the CallSid retry marker, the org's hourly
 * and daily counters, then the caller's hourly and daily counters (skipped when `callerE164` is null). Everything
 * taken is given back when a later limit refuses or the store throws, so a refused call costs nobody a slot.
 * Taken once per call, when a member is about to be rung (not per member attempt).
 *
 * A Twilio retry of the same webhook (same CallSid) finds its own marker and is admitted without counting again.
 * Store failures throw: the caller fails closed.
 */
export async function reserveInboundSlot(input: {
  orgId: string; callSid: string; callerE164: string | null; config: HotLeadCallConfig; now?: Date;
}): Promise<InboundReservation> {
  const { orgId, callSid, callerE164, config } = input;
  const now = input.now ?? new Date();
  const nowS = Math.floor(now.getTime() / 1000);
  const timeZone = config.callingHours?.timezone ?? 'UTC';
  const { claim, count, releaseAll } = slotTaker(nowS);

  try {
    const markerKey = inboundCallMarkerKey(callSid);
    if (!await claim(markerKey, RETRY_MARKER_TTL_S, callSid)) {
      // The marker is keyed by the CallSid, so a live claim on it is this call's own: Twilio redelivering a webhook we
      // already counted. Anything else (it expired between the two reads) is not provable, so it fails closed.
      if (await getLimitStore().holder(markerKey, nowS) === callSid) return { ok: true, release: async () => undefined };
      throw new Error('inbound retry marker is not held by this call');
    }
    const counters: Array<[InboundDenial, () => Promise<boolean>]> = [
      ['org_hourly', () => count(inboundOrgHourlyKey(orgId, now), ORG_INBOUND_FACTOR * config.maxCallsPerHour, 2 * HOUR_S)],
      ['org_daily', () => count(inboundOrgDailyKey(orgId, timeZone, now), ORG_INBOUND_FACTOR * config.maxCallsPerDay, 2 * DAY_S)],
    ];
    if (callerE164) {
      counters.push(
        ['caller_hourly', () => count(inboundCallerHourlyKey(orgId, callerE164, now), CALLER_MAX_PER_HOUR, 2 * HOUR_S)],
        ['caller_daily', () => count(inboundCallerDailyKey(orgId, callerE164, timeZone, now), CALLER_MAX_PER_DAY, 2 * DAY_S)],
      );
    }
    for (const [reason, take] of counters) {
      if (!await take()) {
        await releaseAll();
        return { ok: false, reason };
      }
    }
  } catch (err) {
    await releaseAll();
    throw err;
  }
  return { ok: true, release: releaseAll };
}
