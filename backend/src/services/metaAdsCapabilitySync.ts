/**
 * Reconcile a Meta ad account's recorded Ads capability with Meta's own answer.
 *
 * WHY THIS EXISTS (ENG-1158)
 * --------------------------
 * ENG-629 taught us to record what we learn when Meta refuses an ads read. That
 * record is durable and load-bearing — the pre-flight gate reads it and refuses
 * locally, without calling Meta — but until now nothing ever revisited it. Two
 * consequences, both visible in the live record for account 922903076601160:
 *
 *  1. NO WAY BACK. `ads_scope_revoked_at` was cleared only by our own OAuth
 *     reconnect, which replaces the config wholesale. An owner who re-granted
 *     the Ads permission on Meta's Business Integrations page — which is where
 *     Meta itself sends people — would stay refused forever, because the gate
 *     short-circuits before anything can notice the grant came back.
 *
 *  2. DETECTION ONLY ON USE. Scope loss surfaced only when a run happened to
 *     attempt a read. With no schedule, or a paused one, the connection sat
 *     quietly broken.
 *
 * The refresh cron already sweeps every Meta ad account twice a day holding a
 * valid token, which is exactly what `debug_token` needs. This module is the
 * per-account reconciliation it performs.
 *
 * THE ASYMMETRY THAT GOVERNS EVERY BRANCH
 * ---------------------------------------
 * Meta's answer is authoritative only when we actually get one.
 * `getGrantedScopes` returns `undefined` for a failed or error-shaped
 * `debug_token`, and that is NOT "nothing is granted" — treating it as such
 * would revoke every healthy connection we have during a Meta outage. So an
 * undetermined answer changes nothing at all, in either direction.
 */

import { ConnectedAccount } from './connectedAccountsDb';
import { metaService } from './metaService';
import { getMetaAdsScopeState, META_ADS_READ_SCOPES } from '../utils/metaAdsScope';

export type MetaAdsCapabilitySyncOutcome =
  /** Not a Meta ad account, or no token to ask with. */
  | 'skipped'
  /** Meta could not tell us. Nothing was changed. */
  | 'undetermined'
  /** Meta's answer matches what we already had recorded. */
  | 'unchanged'
  /** Meta confirms the ads scope is gone; recorded, and the owner told once. */
  | 'revoked'
  /** Meta confirms the ads scope is back; the stale refusal has been retracted. */
  | 'recovered'
  /** Something failed. Nothing partial was left behind that could mislead. */
  | 'error';

export interface MetaAdsCapabilitySyncResult {
  outcome: MetaAdsCapabilitySyncOutcome;
  error?: string;
}

const hasAdsScope = (scopes: string[]): boolean =>
  scopes.some(s => (META_ADS_READ_SCOPES as readonly string[]).includes(s.trim()));

/**
 * Ask Meta what this connection is actually granted, and make our record agree.
 *
 * Never throws: this runs inside a sweep over every user, and one bad account
 * must not abort the rest.
 *
 * @param account - The connected Meta ad account (config updated in place on a write).
 * @param userId  - Owner user id, required to persist and to address the alert.
 */
export const syncMetaAdsCapability = async (
  account: ConnectedAccount,
  userId: string
): Promise<MetaAdsCapabilitySyncResult> => {
  const platform = account?.platform as string;
  const config = account?.config as Record<string, any> | undefined;

  const isAdAccount =
    (platform === 'meta' || platform === 'facebook') && config?.account_type === 'ad_account';
  if (!isAdAccount || !config?.access_token || !account?.account_id || !userId) {
    return { outcome: 'skipped' };
  }

  try {
    const granted = await metaService.getGrantedScopes(config.access_token);

    // Absence of proof. Change nothing — in either direction.
    if (!granted) return { outcome: 'undetermined' };

    const { updateAccountConfig } = await import('./connectedAccountsDb');
    const capable = hasAdsScope(granted);
    const recordedState = getMetaAdsScopeState(config);

    if (capable) {
      // Already known good: the twice-daily no-op case. Skip the write.
      if (recordedState === 'granted') return { outcome: 'unchanged' };

      // The grant is back. Retract the refusal AND the notice — the notice must
      // go too, or a future outage would be deduped against an episode that is
      // already over and the owner would never hear about it.
      await updateAccountConfig(userId, platform as any, account.account_id, { granted_scopes: granted }, {
        unset: ['ads_scope_revoked_at', 'ads_scope_alerted_at'],
      });
      config.granted_scopes = granted;
      delete config.ads_scope_revoked_at;
      delete config.ads_scope_alerted_at;

      console.log(
        `[MetaAdsCapabilitySync] Ads access restored for user ${userId} account ${account.account_id} — cleared the recorded refusal`
      );
      return { outcome: 'recovered' };
    }

    // Not capable. Nothing to do if that is already recorded AND the owner has
    // already been told about this same outage.
    const alreadyAlerted = !!config.ads_scope_alerted_at;
    if (recordedState === 'missing' && alreadyAlerted) return { outcome: 'unchanged' };

    // Record the notice in the same write that records the refusal, and do it
    // BEFORE sending. This sweep repeats every 12 hours forever, so an
    // unwritable marker has to fail towards silence rather than towards a mail
    // loop aimed at a customer.
    const now = new Date().toISOString();
    await updateAccountConfig(userId, platform as any, account.account_id, {
      granted_scopes: granted,
      ads_scope_revoked_at: config.ads_scope_revoked_at || now,
      ads_scope_alerted_at: now,
    });
    config.granted_scopes = granted;
    config.ads_scope_revoked_at = config.ads_scope_revoked_at || now;
    config.ads_scope_alerted_at = now;

    const { notifyMetaAdsScopeLost } = await import('./metaAdsScopeAlertService');
    await notifyMetaAdsScopeLost({
      ownerUserId: userId,
      accountId: account.account_id,
      accountName: account.account_name,
    });

    console.log(
      `[MetaAdsCapabilitySync] Ads access missing for user ${userId} account ${account.account_id} — recorded and notified the owner`
    );
    return { outcome: 'revoked' };
  } catch (error: any) {
    const message = error?.message || String(error);
    console.warn(
      `[MetaAdsCapabilitySync] Could not reconcile ads capability for user ${userId} account ${account.account_id}: ${message}`
    );
    return { outcome: 'error', error: message };
  }
};
