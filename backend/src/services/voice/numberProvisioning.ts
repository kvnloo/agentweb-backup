import { orgDb, type Organization } from '../db';
import { hotLeadCallConfigOf, maskPhone, type HotLeadCallConfig } from '../hotLeadCallConfig';
import { recordVendorUsage } from '../usageRecorderService';
import { getVoiceProvider, VoiceCallError } from './voiceProvider';
import { isConditionalFailure, unchangedSince } from './setupWrites';

/**
 * Caller-number provisioning for the hot-lead auto-call (ENG-2271 WP7): one Twilio number per org.
 *
 * Buying and releasing are non-idempotent account changes, so every path that can leave a number billed
 * but unrecorded ("orphan") is either compensated (released again) or logged for ops with the number SID.
 * First month's rent is metered at purchase. RECURRING rent is not: that needs a scheduled job that meters
 * `twilio:number:<sid>:<YYYY-MM>` each month for every stored twilioNumberSid (follow-up, not built here).
 */

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
    return (await orgDb.getOrgById(orgId))?.hotLeadCall?.twilioNumberSid === sid;
  } catch {
    return 'unreadable';
  }
}

export async function provisionNumber(p: { org: Organization; config: HotLeadCallConfig; userId: string; areaCode?: string }) {
  const { org, config } = p;
  if (config.twilioNumber || config.twilioNumberSid) {
    throw new Error('This organization already has a caller number. Release it first if you need a different one.');
  }

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

  await recordVendorUsage({
    userId: p.userId,
    provider: 'twilio',
    operation: 'number_monthly_rent',
    feature: 'hot_lead_call',
    unit: 'number_month',
    quantity: 1,
    rateKey: 'number_monthly_rent',
    idempotencyKey: `twilio:number:${bought.numberSid}:${new Date().toISOString().slice(0, 7)}`,
  });
  return { callerNumber: maskPhone(next.twilioNumber ?? bought.phoneNumber), enabled: next.enabled, destinationVerified: !!next.destinationVerifiedAt };
}

/** Writes `change(current)` over the freshest stored config, retrying once if a concurrent edit wins. */
async function rewriteConfig(orgId: string, change: (current: HotLeadCallConfig) => HotLeadCallConfig | null, firstOrg?: Organization) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const org = attempt === 0 && firstOrg ? firstOrg : await orgDb.getOrgById(orgId);
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
