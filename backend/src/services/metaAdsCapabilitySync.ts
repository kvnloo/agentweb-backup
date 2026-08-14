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
  /** Meta confirms the ads scope is gone; recorded so every surface reports it. */
  | 'revoked'
  /** Meta confirms the ads scope is back; the stale refusal has been retracted. */
  | 'recovered'
  /** Something failed. Nothing partial was left behind that could mislead. */
  | 'error';

export interface MetaAdsCapabilitySyncResult {
  outcome: MetaAdsCapabilitySyncOutcome;
  error?: string;
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
    const access = await metaService.probeAdsAccountAccess(
      config.access_token,
      config.ad_account_id || account.account_id
    );

    // Absence of proof. Change nothing — in either direction.
    if (access === 'unknown') return { outcome: 'undetermined' };

    // The moment THIS probe's answer was learned (Greptile P1 follow-up — see
    // ads_capability_probed_at doc in utils/metaAdsScope.ts). Captured once,
    // right after the probe resolves, so every retry of the write below
    // guards against a concurrent writer's NEWER probe, not against itself.
    const probedAt = new Date().toISOString();

    const { updateAccountConfig } = await import('./connectedAccountsDb');
    const recordedState = getMetaAdsScopeState(config);

    if (access === 'accessible') {
      // Already not refusing and nothing pending: the twice-daily no-op case.
      // A stale suspicion still has to be cleared, or two unrelated denials a
      // month apart would combine into a "confirmation" that never happened.
      const hasSuspicion = !!config.ads_scope_denied_seen_at;
      const wasRefusing = recordedState === 'missing';
      if (!wasRefusing && !hasSuspicion) return { outcome: 'unchanged' };

      // Retract the refusal.
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
      if (wasRefusing) unset.push('ads_scope_revoked_at', 'granted_scopes', 'ads_scope_tier');

      // Function form (Greptile P1): a CAS retry must decide what to unset from
      // THIS attempt's fresh read, not the read from before the conflict — a
      // stale 'wasRefusing' reapplied on retry could erase a recovery a
      // concurrent writer landed in between.
      //
      // The probedAt guard (Greptile P1 follow-up) covers the deeper version
      // of the same race: even a retry that reads fresh DB state is still
      // running the DECISION "this is a recovery", made from a probe that
      // could be older than a conflicting write that landed in between — e.g.
      // a live chat run's read failure revoking this account moments after
      // this sweep's probe found it accessible. If the state we just read
      // already carries a newer probe's timestamp, that signal is more
      // current than ours; do nothing rather than overwrite it.
      await updateAccountConfig(userId, platform as any, account.account_id, freshConfig => {
        const storedProbedAt = freshConfig.ads_capability_probed_at;
        if (typeof storedProbedAt === 'string' && storedProbedAt > probedAt) {
          return { updates: {}, unset: [] };
        }

        const freshUnset = ['ads_scope_denied_seen_at'];
        if (getMetaAdsScopeState(freshConfig) === 'missing') {
          freshUnset.push('ads_scope_revoked_at', 'granted_scopes', 'ads_scope_tier');
        }
        return { updates: { ads_capability_probed_at: probedAt }, unset: freshUnset };
      });
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

    // Denied, and already recorded as such. The revocation itself needs no
    // rewrite — but an account already latched BEFORE tier classification
    // shipped has no ads_scope_tier, and would otherwise carry the generic
    // OAuth-tier message forever: this branch is the only place tier gets
    // computed, and an account that's already 'missing' never reaches it
    // through the normal suspect-then-confirm path again while it stays
    // denied. Backfill once, guarded so it only ever runs until a tier is
    // recorded.
    if (recordedState === 'missing') {
      if (!config.ads_scope_tier) {
        const backfillTier = await metaService.classifyAdsRefusalTier(config.access_token);
        if (backfillTier !== 'unknown') {
          await updateAccountConfig(userId, platform as any, account.account_id, freshConfig => {
            if (getMetaAdsScopeState(freshConfig) !== 'missing' || freshConfig.ads_scope_tier) {
              return { updates: {}, unset: [] };
            }
            const storedProbedAt = freshConfig.ads_capability_probed_at;
            if (typeof storedProbedAt === 'string' && storedProbedAt > probedAt) {
              return { updates: {}, unset: [] };
            }
            return { updates: { ads_scope_tier: backfillTier, ads_capability_probed_at: probedAt } };
          });
          config.ads_scope_tier = backfillTier;
          console.log(
            `[MetaAdsCapabilitySync] Backfilled ads-refusal tier for user ${userId} account ${account.account_id} — was already latched before tier classification shipped`
          );
        }
      }
      return { outcome: 'unchanged' };
    }

    // First refusal we have seen for this connection: record the suspicion and
    // stop. Confirmation comes from the next sweep, 12 hours later. One denied
    // probe is weak evidence — Meta returns this refusal transiently, e.g. while
    // a Business Manager permission change propagates — and the two costs are
    // wildly asymmetric. Waiting adds 12 hours to a problem that had already run
    // 13 days unnoticed; acting on a false positive strips a working customer's
    // grant and turns their Settings row red for an outage that is already over.
    //
    // An account already recorded as 'missing' never reaches here — it returned
    // 'unchanged' above, since the agent path already caught it against a read we
    // actually wanted and every surface already reports it.
    const now = new Date().toISOString();
    if (!config.ads_scope_denied_seen_at) {
      // The probedAt guard (Greptile P1 follow-up) applies here too, not only
      // to the confirmed transitions. Without it, a suspicion write delayed
      // past a concurrent recovery could still land afterward — carrying no
      // marker of its own staleness — and sit there until an unrelated LATER
      // denial reads it as "already suspected", skips the two-strike wait, and
      // confirms a false revocation the recovery had already disproved.
      // Stamping probedAt here too, not just on revoke/recover, means every
      // write — suspicion included — always defers to whichever Meta signal
      // was actually learned most recently.
      let wasStale = false;
      await updateAccountConfig(userId, platform as any, account.account_id, freshConfig => {
        const storedProbedAt = freshConfig.ads_capability_probed_at;
        if (typeof storedProbedAt === 'string' && storedProbedAt > now) {
          wasStale = true;
          return { updates: {}, unset: [] };
        }
        return { updates: { ads_scope_denied_seen_at: now, ads_capability_probed_at: now } };
      });
      if (wasStale) {
        console.log(
          `[MetaAdsCapabilitySync] Ads access refusal for user ${userId} account ${account.account_id} is stale — a newer Meta signal already landed, ignoring`
        );
        return { outcome: 'undetermined' };
      }
      config.ads_scope_denied_seen_at = now;
      console.log(
        `[MetaAdsCapabilitySync] Ads access refused for user ${userId} account ${account.account_id} — recorded as suspected, awaiting confirmation next sweep`
      );
      return { outcome: 'suspected' };
    }

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

    // Which of the two independent grants is actually missing (ENG-1158
    // follow-up)? An independent, fresh check — not derived from `retained`
    // above, which is our own subtraction and would always say "gone" for
    // both tiers alike. `access_token` is still the token that was just
    // refused, so this call cannot itself trigger a re-refusal.
    const tier = await metaService.classifyAdsRefusalTier(config.access_token);

    // Function form (Greptile P1): `retained` above is computed from the read
    // at the top of this call, which is exactly what a CAS retry must NOT
    // reapply blindly — if a concurrent recovery landed between our read and
    // write, retrying with this stale `retained` would re-narrow a grant that
    // had just been restored. `tier` stays fixed: it came from a live Meta
    // call made once, not from local state that can go stale.
    //
    // The probedAt guard (Greptile P1 follow-up) covers the case a plain
    // fresh-read retry cannot: a concurrent recovery whose probe is NEWER than
    // ours, landed after our read but before our write. Reading its fresh
    // granted_scopes and re-narrowing would still reverse it — the guard makes
    // the write no-op instead, so the more current signal always wins.
    await updateAccountConfig(userId, platform as any, account.account_id, freshConfig => {
      const storedProbedAt = freshConfig.ads_capability_probed_at;
      if (typeof storedProbedAt === 'string' && storedProbedAt > probedAt) {
        return { updates: {}, unset: [] };
      }

      const freshPrevious: unknown = freshConfig.granted_scopes;
      const freshRetained = (Array.isArray(freshPrevious) ? freshPrevious : [])
        .filter((s: unknown): s is string => typeof s === 'string')
        .filter((s: string) => !(META_ADS_READ_SCOPES as readonly string[]).includes(s.trim()));
      return {
        updates: {
          granted_scopes: freshRetained,
          ads_scope_revoked_at: freshConfig.ads_scope_revoked_at || now,
          ads_capability_probed_at: probedAt,
          ...(tier !== 'unknown' ? { ads_scope_tier: tier } : {}),
        },
        unset:
          tier === 'unknown'
            ? ['ads_scope_denied_seen_at', 'ads_scope_tier']
            : ['ads_scope_denied_seen_at'],
      };
    });
    config.granted_scopes = retained;
    config.ads_scope_revoked_at = config.ads_scope_revoked_at || now;
    delete config.ads_scope_denied_seen_at;
    if (tier !== 'unknown') config.ads_scope_tier = tier;
    else delete config.ads_scope_tier;

    console.log(
      `[MetaAdsCapabilitySync] Ads access missing for user ${userId} account ${account.account_id} — recorded; the Settings row and the agent tool now report it as needing reconnection`
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
