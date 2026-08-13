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
 * WHY THIS ASKS BY TRYING, NOT BY READING SCOPES
 * ----------------------------------------------
 * Two independent grants must line up before an ads read works: the user
 * granting our app `ads_read`, and the ad account's owner granting that user
 * access to that ad account. A token's scopes only ever show the first.
 * Production account 922903076601160 has the scope and not the account grant —
 * `/me/permissions` reports `ads_read` granted with nothing declined, while the
 * same token is refused by the ad account itself. Reconciling on scopes would
 * therefore have declared the reported account healthy and cleared the very
 * refusal that was protecting it.
 *
 * THE ASYMMETRY THAT GOVERNS EVERY BRANCH
 * ---------------------------------------
 * Meta's answer is authoritative only when we actually get one. `probeAdsAccountAccess`
 * returns 'unknown' for anything that is not a clear yes or a clear ads-scope
 * refusal, and that is NOT "no access" — treating it as such would revoke every
 * healthy connection we have during a Meta outage. An undetermined answer
 * changes nothing at all, in either direction.
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
  /** First refusal seen. Recorded as a suspicion only — nothing user-visible changed. */
  | 'suspected'
  /** Meta confirms the ads scope is gone; recorded, and the owner told once. */
  | 'revoked'
  /** Meta confirms the ads scope is back; the stale refusal has been retracted. */
  | 'recovered'
  /** Something failed. Nothing partial was left behind that could mislead. */
  | 'error';

export interface MetaAdsCapabilitySyncResult {
  outcome: MetaAdsCapabilitySyncOutcome;
  /**
   * Whether this pass was permitted to notify the owner, and attempted it.
   *
   * Not the same as "an email arrived": the alert service can still decline
   * (non-production, no address on file, a duplicate within its guard window).
   * False here means specifically that the sweep's alert budget was spent, which
   * is what the caller needs in order to count and report withheld notices.
   */
  alerted?: boolean;
  error?: string;
}

export interface MetaAdsCapabilitySyncOptions {
  /**
   * May this account's owner be emailed on this pass? Defaults to true.
   *
   * The sweep passes false once it has spent its per-run alert budget, which
   * bounds the blast radius if a Meta-side change ever made many accounts look
   * denied at once. Recording the revocation is NOT gated on this — protection
   * must never depend on there being room to send mail — and the notice is left
   * unrecorded so a later sweep can still deliver it.
   */
  allowAlert?: boolean;
}

/**
 * Ask Meta what this connection can actually do, and make our record agree.
 *
 * Never throws: this runs inside a sweep over every user, and one bad account
 * must not abort the rest.
 *
 * @param account - The connected Meta ad account (config updated in place on a write).
 * @param userId  - Owner user id, required to persist and to address the alert.
 */
export const syncMetaAdsCapability = async (
  account: ConnectedAccount,
  userId: string,
  options?: MetaAdsCapabilitySyncOptions
): Promise<MetaAdsCapabilitySyncResult> => {
  const platform = account?.platform as string;
  const config = account?.config as Record<string, any> | undefined;

  const isAdAccount =
    (platform === 'meta' || platform === 'facebook') && config?.account_type === 'ad_account';
  if (!isAdAccount || !config?.access_token || !account?.account_id || !userId) {
    return { outcome: 'skipped' };
  }

  try {
    const access = await metaService.probeAdsAccountAccess(
      config.access_token,
      config.ad_account_id || account.account_id
    );

    // Absence of proof. Change nothing — in either direction.
    if (access === 'unknown') return { outcome: 'undetermined' };

    const { updateAccountConfig } = await import('./connectedAccountsDb');
    const recordedState = getMetaAdsScopeState(config);

    if (access === 'accessible') {
      // Already not refusing and nothing pending: the twice-daily no-op case.
      // A stale suspicion still has to be cleared, or two unrelated denials a
      // month apart would combine into a "confirmation" that never happened.
      const hasSuspicion = !!config.ads_scope_denied_seen_at;
      const wasRefusing = recordedState === 'missing';
      if (!wasRefusing && !hasSuspicion) return { outcome: 'unchanged' };

      // Retract the refusal AND the notice — the notice must go too, or a future
      // outage would be deduped against an episode that is already over and the
      // owner would never hear about it.
      //
      // `granted_scopes` goes with them, and that is load-bearing rather than
      // tidiness. A revocation NARROWS the stored grant instead of emptying it,
      // so a recovering account is left holding e.g. ['pages_show_list'] — and
      // getMetaAdsScopeState reads a non-empty grant carrying no ads scope as a
      // proven 'missing' (its final fallthrough). Clearing only the markers would
      // therefore leave the gate still refusing and the row still disconnected:
      // recovery that does not recover, for every account that ever needed it.
      //
      // Dropping it is also the honest record. What remains there after a
      // revocation is our own subtraction, not anything Meta reported, so it
      // cannot stand as a grant. Absent reads as 'unknown', which says exactly
      // what we know: the read works; what was granted, we would have to re-ask.
      const unset = ['ads_scope_denied_seen_at'];
      if (wasRefusing) unset.push('ads_scope_revoked_at', 'ads_scope_alerted_at', 'granted_scopes');

      await updateAccountConfig(userId, platform as any, account.account_id, {}, { unset });
      for (const key of unset) delete config[key];

      // A cleared suspicion is not a recovery: nothing user-visible was ever
      // wrong. Counting it as one would make a transient blip read in monitoring
      // as a customer outage that resolved.
      if (!wasRefusing) {
        console.log(
          `[MetaAdsCapabilitySync] Ads access confirmed for user ${userId} account ${account.account_id} — cleared an unconfirmed refusal`
        );
        return { outcome: 'unchanged' };
      }

      console.log(
        `[MetaAdsCapabilitySync] Ads access restored for user ${userId} account ${account.account_id} — cleared the recorded refusal`
      );
      return { outcome: 'recovered' };
    }

    // Denied. Nothing to do if that is already recorded AND the owner has
    // already been told about this same outage.
    const alreadyAlerted = !!config.ads_scope_alerted_at;
    if (recordedState === 'missing' && alreadyAlerted) return { outcome: 'unchanged' };

    // First refusal we have seen for a connection not already known to be
    // broken: record the suspicion and stop. Confirmation comes from the next
    // sweep, 12 hours later. One denied probe is weak evidence — Meta returns
    // this refusal transiently, e.g. while a Business Manager permission change
    // propagates — and the two costs are wildly asymmetric. Waiting adds 12
    // hours to a problem that had already run 13 days unnoticed; acting on a
    // false positive strips a working customer's grant, turns their Settings row
    // red and mails them about an outage that is already over.
    //
    // An account already recorded as 'missing' skips this: the agent path caught
    // it against a read we actually wanted, which is confirmation enough.
    const now = new Date().toISOString();
    if (recordedState !== 'missing' && !config.ads_scope_denied_seen_at) {
      await updateAccountConfig(userId, platform as any, account.account_id, {
        ads_scope_denied_seen_at: now,
      });
      config.ads_scope_denied_seen_at = now;
      console.log(
        `[MetaAdsCapabilitySync] Ads access refused for user ${userId} account ${account.account_id} — recorded as suspected, awaiting confirmation next sweep`
      );
      return { outcome: 'suspected' };
    }

    // Record the notice in the same write that records the refusal, and do it
    // BEFORE sending. This sweep repeats every 12 hours forever, so an
    // unwritable marker has to fail towards silence rather than towards a mail
    // loop aimed at a customer.
    // Narrow the recorded grant as well as stamping the refusal, exactly as the
    // post-flight path does. Without this the revocation is inert: an affirmative
    // ads scope in `granted_scopes` outranks `ads_scope_revoked_at` in
    // getMetaAdsScopeState, so the gate would keep letting reads through and the
    // Settings row would keep saying "Active" while every read fails. Caught by
    // running this against a real denied account, where the marker was written
    // and the state stayed 'granted'.
    //
    // Honest as a record, too: Meta just refused this ad account for lack of an
    // ads permission, so whatever the user granted our app, the ads grant is not
    // in effect for this connection.
    const previous: unknown = config.granted_scopes;
    const retained = (Array.isArray(previous) ? previous : [])
      .filter((s: unknown): s is string => typeof s === 'string')
      .filter((s: string) => !(META_ADS_READ_SCOPES as readonly string[]).includes(s.trim()));

    // Protection is unconditional; only the notice is budgeted. When the budget
    // is spent we still strip the grant and stamp the refusal, but leave
    // `ads_scope_alerted_at` unwritten so a later sweep can still deliver it.
    const allowAlert = options?.allowAlert !== false;

    await updateAccountConfig(userId, platform as any, account.account_id, {
      granted_scopes: retained,
      ads_scope_revoked_at: config.ads_scope_revoked_at || now,
      ...(allowAlert ? { ads_scope_alerted_at: now } : {}),
    }, { unset: ['ads_scope_denied_seen_at'] });
    config.granted_scopes = retained;
    config.ads_scope_revoked_at = config.ads_scope_revoked_at || now;
    delete config.ads_scope_denied_seen_at;
    if (allowAlert) config.ads_scope_alerted_at = now;

    if (!allowAlert) {
      console.warn(
        `[MetaAdsCapabilitySync] Ads access missing for user ${userId} account ${account.account_id} — recorded, but the alert budget for this sweep is spent; the owner will be told on a later run`
      );
      return { outcome: 'revoked', alerted: false };
    }

    const { notifyMetaAdsScopeLost } = await import('./metaAdsScopeAlertService');
    const delivered = await notifyMetaAdsScopeLost({
      ownerUserId: userId,
      accountId: account.account_id,
      accountName: account.account_name,
    });

    // The marker is claimed before sending so a mail failure cannot become a
    // twice-daily mail loop. But keeping it when nothing was delivered — no
    // address on file, a send failure, a non-production environment — would
    // permanently record the owner as told when they were never told at all,
    // and every later run trusts that marker. So retract it: the claim only
    // stands if the notice actually went out (Greptile P1).
    if (!delivered) {
      try {
        await updateAccountConfig(userId, platform as any, account.account_id, {}, {
          unset: ['ads_scope_alerted_at'],
        });
        delete config.ads_scope_alerted_at;
      } catch (retractError: any) {
        console.warn(
          `[MetaAdsCapabilitySync] Could not retract the unsent alert marker for user ${userId} account ${account.account_id}: ${retractError?.message ?? retractError}`
        );
      }
      console.warn(
        `[MetaAdsCapabilitySync] Ads access missing for user ${userId} account ${account.account_id} — recorded, but the owner was NOT notified; a later run will retry`
      );
      return { outcome: 'revoked', alerted: false };
    }

    console.log(
      `[MetaAdsCapabilitySync] Ads access missing for user ${userId} account ${account.account_id} — recorded and notified the owner`
    );
    return { outcome: 'revoked', alerted: true };
  } catch (error: any) {
    const message = error?.message || String(error);
    console.warn(
      `[MetaAdsCapabilitySync] Could not reconcile ads capability for user ${userId} account ${account.account_id}: ${message}`
    );
    return { outcome: 'error', error: message };
  }
};
