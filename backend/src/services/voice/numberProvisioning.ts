import { orgDb, type Organization } from '../db';
import { hotLeadCallConfigOf, maskPhone, type HotLeadCallConfig } from '../hotLeadCallConfig';
import { recordVendorUsage } from '../usageRecorderService';
import { getAllocatedRate, getRecordingUnit } from '../../utils/vendorRateCard';
import { isRecord } from '../leadNotificationAttribution';
import { getVoiceProvider, VoiceCallError } from './voiceProvider';
import { isConditionalFailure, unchangedSince } from './setupWrites';

/**
 * Caller-number provisioning for the hot-lead auto-call (ENG-2271): one Twilio number per org.
 *
 * Buying and releasing are non-idempotent account changes, so every path that can leave a number billed
 * but unrecorded ("orphan") is either compensated (released again) or logged for ops with the number SID.
 * Rent is metered for EVERY successful purchase, including one that is released again straight away (Twilio
 * has already billed it); the key is idempotent per sid and month. RECURRING rent is not metered: that needs
 * a scheduled job that meters `twilio:number:<sid>:<YYYY-MM>` each month for every stored twilioNumberSid
 * (follow-up, not built here).
 *
 * Cost control: before any purchase, a reservation is written to the org attribute `hotLeadCallProvisioning`
 * (same system-managed family as hotLeadCallVerification), conditional on that attribute AND hotLeadCall being
 * unchanged since they were read. That makes the one-number cap atomic (parallel provisions cannot both reach
 * Twilio) and caps purchases at 2 per org per rolling 24h. The history survives success and release, so a
 * release/provision loop is bounded (~2 numbers/day/org). A reservation whose purchase then fails still counts.
 * Releases are reserved the same way so a loop cannot hammer Twilio.
 *
 * Residual, accepted (no in-flight stamp is built): the reservation is conditional, so a parallel provision
 * normally fails before buying; should two still reach buyNumber, the loser's number is released (its rent
 * metered) and the cost stays within the 2/day cap.
 *
 * `confirm: true` on the tool is advisory (the model controls it); these caps are the real control. A
 * human-approval gate (approval deck) for provision/release is a recommended follow-up: the existing
 * mechanism is Meta-write specific (digest manifests halted inside agentModeService).
 */

const DAY_MS = 24 * 60 * 60_000;
const MAX_PURCHASES_PER_DAY = 2;
const MAX_RELEASES_PER_DAY = 6;

export interface HotLeadCallProvisioning {
  /** Epoch ms of each purchase reservation in the last 24h. */
  purchases: number[];
  /** Epoch ms of each release reservation in the last 24h. */
  releases: number[];
}

const isEpochList = (v: unknown): v is number[] => Array.isArray(v) && v.every(t => typeof t === 'number' && Number.isFinite(t) && t > 0);

/** Absent is an empty history; present-but-malformed is null, and callers fail closed on it (this guards money). */
function provisioningOf(raw: unknown): HotLeadCallProvisioning | null {
  if (raw === undefined) return { purchases: [], releases: [] };
  return isRecord(raw) && isEpochList(raw.purchases) && isEpochList(raw.releases) ? { purchases: raw.purchases, releases: raw.releases } : null;
}

/** Writes the reservation; the conditional write is what makes the caps race-free. */
async function reserve(org: Organization, kind: 'purchases' | 'releases', max: number): Promise<void> {
  const history = provisioningOf(org.hotLeadCallProvisioning);
  if (!history) throw new Error('Stored number purchase history is invalid. Contact support.');
  const now = Date.now();
  const recent = history[kind].filter(t => now - t < DAY_MS);
  if (recent.length >= max) {
    throw new Error(`The limit of ${max} number ${kind} per day was reached. Try again tomorrow.`);
  }
  try {
    await orgDb.updateOrg(org.orgId, { hotLeadCallProvisioning: { ...history, [kind]: [...recent, now] } }, {
      condition: unchangedSince({ hotLeadCallProvisioning: org.hotLeadCallProvisioning, hotLeadCall: org.hotLeadCall }),
    });
  } catch (err) {
    if (isConditionalFailure(err)) throw new Error('Another change to the caller number is in progress. Wait a moment and try again.');
    throw err;
  }
}

/** Live card price for messages, never a number typed into this file. */
export function monthlyRentText(): string {
  const rent = getAllocatedRate('twilio', 'number_monthly_rent');
  return rent === null ? 'a monthly fee' : `$${rent.toFixed(2)} per month`;
}

const orphanLog = (orgId: string, sid: string, why: string) =>
  console.error(`[hotLeadCall] ORPHAN number: org ${orgId} sid ${sid} (${why}); release it in the Twilio console`);

/** Releases a number this code just bought but cannot keep. False means it may still be billed (and is logged). */
async function discard(orgId: string, sid: string, why: string): Promise<boolean> {
  try {
    await getVoiceProvider().releaseNumber(sid);
    return true;
  } catch {
    orphanLog(orgId, sid, why);
    return false;
  }
}

/** Whether the stored org now holds this number sid: how an ambiguous write failure is told from a lost one. */
async function persisted(orgId: string, sid: string): Promise<boolean | 'unreadable'> {
  try {
    return (await orgDb.getOrgById(orgId, undefined, true))?.hotLeadCall?.twilioNumberSid === sid;
  } catch {
    return 'unreadable';
  }
}

/** Billed the moment the number was bought, so metered before anything that can fail or discard it. */
async function meterRent(userId: string, sid: string): Promise<void> {
  const unit = getRecordingUnit('twilio', 'number_monthly_rent');
  if (!unit) {
    console.error('[hotLeadCall] number rent not metered: twilio number_monthly_rent is missing from the rate card');
    return;
  }
  // recordVendorUsage should never throw, but nothing here may skip the save/discard/orphan handling after a purchase.
  try {
    await recordVendorUsage({
      userId, provider: 'twilio', operation: 'number_monthly_rent', feature: 'hot_lead_call', unit, quantity: 1,
      rateKey: 'number_monthly_rent', idempotencyKey: `twilio:number:${sid}:${new Date().toISOString().slice(0, 7)}`,
    });
  } catch {
    console.error(`[hotLeadCall] number rent metering failed for sid ${sid}; meter it manually`);
  }
}

export async function provisionNumber(p: { org: Organization; config: HotLeadCallConfig; userId: string; areaCode?: string }) {
  const { org, config } = p;
  if (config.twilioNumber || config.twilioNumberSid) {
    throw new Error('This organization already has a caller number. Release it first if you need a different one.');
  }

  await reserve(org, 'purchases', MAX_PURCHASES_PER_DAY);

  let bought: { numberSid: string; phoneNumber: string };
  try {
    bought = await getVoiceProvider().buyNumber({ countryCode: 'US', ...(p.areaCode ? { areaCode: p.areaCode } : {}) });
  } catch (err) {
    if (err instanceof VoiceCallError && err.placed === 'no') {
      throw new Error('The phone provider did not sell a number, so nothing was bought or charged. Try a different area code, or try again later.');
    }
    console.error(`[hotLeadCall] ORPHAN RISK: buyNumber outcome unknown for org ${org.orgId}; check the Twilio console for a number not recorded here`);
    throw new Error('The phone provider did not confirm whether a number was bought, so one may have been bought and billed. Do not retry; contact support.');
  }

  await meterRent(p.userId, bought.numberSid);

  const next = hotLeadCallConfigOf({ ...config, twilioNumber: bought.phoneNumber, twilioNumberSid: bought.numberSid });
  if (!next) {
    const released = await discard(org.orgId, bought.numberSid, 'purchased number failed validation');
    throw new Error(released
      ? 'The phone provider returned a number that cannot be used for calls; it was released. Try again.'
      : 'The phone provider returned a number that cannot be used for calls and it could not be released. Contact support.');
  }

  try {
    await orgDb.updateOrg(org.orgId, { hotLeadCall: next }, { condition: unchangedSince({ hotLeadCall: org.hotLeadCall }) });
  } catch (err) {
    // A conditional failure means the write definitely did not happen; anything else may have landed anyway.
    const saved = isConditionalFailure(err) ? false : await persisted(org.orgId, bought.numberSid);
    if (saved === 'unreadable') {
      orphanLog(org.orgId, bought.numberSid, 'could not tell whether the number was saved');
      throw new Error('A number was bought but saving it could not be confirmed. Contact support.');
    }
    if (!saved) {
      const released = await discard(org.orgId, bought.numberSid, 'could not be saved');
      throw new Error(released
        ? 'The number could not be saved (the settings changed at the same moment), so it was released and nothing is left to pay for. Try again.'
        : 'The number could not be saved and could not be released. Contact support.');
    }
  }

  return { callerNumber: maskPhone(bought.phoneNumber), enabled: next.enabled, teamVerified: next.team.some(m => m.verifiedAt) };
}

/** Writes `change(current)` over the freshest stored config, retrying once if a concurrent edit wins. */
async function rewriteConfig(orgId: string, change: (current: HotLeadCallConfig) => HotLeadCallConfig | null, firstOrg?: Organization) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const org = attempt === 0 && firstOrg ? firstOrg : await orgDb.getOrgById(orgId, undefined, true);
    const current = org ? hotLeadCallConfigOf(org.hotLeadCall) : null;
    if (!org || !current) throw new Error('Stored hot lead call settings are invalid');
    const next = change(current);
    if (!next) return;
    try {
      await orgDb.updateOrg(orgId, { hotLeadCall: next }, { condition: unchangedSince({ hotLeadCall: org.hotLeadCall }) });
      return;
    } catch (err) {
      if (!isConditionalFailure(err)) throw err;
    }
  }
  throw new Error('The settings changed while this was being saved. Try again.');
}

export async function releaseNumber(p: { org: Organization; config: HotLeadCallConfig }) {
  const { org, config } = p;
  const sid = config.twilioNumberSid;
  if (!config.twilioNumber && !sid) throw new Error('This organization has no caller number to release.');
  await reserve(org, 'releases', MAX_RELEASES_PER_DAY);

  // Calling goes off before the number is touched, so no call can start from a number being released.
  if (config.enabled) await rewriteConfig(org.orgId, c => ({ ...c, enabled: false }), org);
  if (sid) {
    try {
      await getVoiceProvider().releaseNumber(sid);
    } catch (err) {
      // Only 404 means "already gone". Any other refusal (401, 429...) leaves the number billed, so keep it.
      if (!(err instanceof VoiceCallError && err.placed === 'no' && err.httpStatus === 404)) {
        const detail = err instanceof VoiceCallError && err.placed === 'no'
          ? 'The phone provider refused to release the number; it is still assigned. Try again later.'
          : 'The phone provider did not confirm whether the number was released; it is kept assigned. Check the Twilio console before trying again.';
        throw new Error(`Calling is now off. ${detail}`);
      }
    }
  }

  await rewriteConfig(org.orgId, c => {
    if (!c.twilioNumber && !c.twilioNumberSid) return null;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { twilioNumber: _number, twilioNumberSid: _sid, ...rest } = c;
    return { ...rest, enabled: false };
  });
  return { callerNumberReleased: true, callingEnabled: false };
}
