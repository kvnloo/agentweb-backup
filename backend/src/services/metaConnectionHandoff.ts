/**
 * Meta connected-account expiry / reconnect handoff (ENG-1986, ENG-885 rail 3).
 *
 * `ensureFreshMetaAdAccountToken` never throws: on a failed re-exchange it logs a
 * warning and leaves the old token in place. Before this module that warning was
 * the only trace — real expiries (Haven, Every.io, PMPS, RankAI) were logged one
 * at a time and handled by nobody. This turns the failure into ONE actionable
 * oncall handoff per account that names the customer, the account, and the single
 * next actor, and adds a post-reconnect read-back so a reconnect is proven by a
 * real Graph read rather than trusted because the OAuth callback returned 200.
 *
 * Scope-missing (ENG-621 / ENG-1158) is deliberately NOT handled here: a token can
 * be valid while `ads_read` is withdrawn. This is token expiry / exchange failure only.
 */

import type { ConnectedAccount } from './connectedAccountsDb';
import { metaService } from './metaService';
import { TOKEN_ALERT_CLASS } from './metaTrackingMonitor';

/** At most one handoff per account per day; the cron runs every 12h. */
export const META_HANDOFF_DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;

export type HandoffActor = 'Customer' | 'CS' | 'Engineering';

export type MetaHandoffReason = 'refresh_failed' | 'reconnect_readback_failed';

export interface MetaHandoffInput {
  reason: MetaHandoffReason;
  userId: string;
  customerEmail?: string;
  account: Pick<ConnectedAccount, 'account_id' | 'account_name' | 'config'>;
  error: string;
  now?: number;
}

export interface MetaHandoffDecision {
  nextActor: HandoffActor;
  action: string;
  expired: boolean;
}

/**
 * Meta signals a dead user token with OAuthException code 190 (any subcode) or a
 * plain "expired"/"session has been invalidated" message. Those can only be fixed
 * by the customer reconnecting; anything else while the token is still in date is
 * ours to look at.
 */
export function isMetaTokenDeadError(error: string): boolean {
  return /\b190\b|OAuthException|expired|invalidated|invalid oauth/i.test(error);
}

/** Decide the one next actor for a handoff. Pure. */
export function decideMetaHandoff(input: MetaHandoffInput): MetaHandoffDecision {
  const now = input.now ?? Date.now();
  const expiresAt = (input.account.config as any)?.token_expires_at as number | undefined;
  const expired = typeof expiresAt === 'number' && expiresAt <= now;

  if (input.reason === 'reconnect_readback_failed') {
    // The customer just completed OAuth; asking them to do it again is not an action.
    return {
      nextActor: 'Engineering',
      expired,
      action: 'Customer reconnected but the new token cannot read the ad account — inspect the Graph error and the selected account/permissions',
    };
  }
  if (expired || isMetaTokenDeadError(input.error)) {
    return {
      nextActor: 'Customer',
      expired,
      action: 'Customer must reconnect the Meta ad account in Settings > Connected Accounts (CS: send the reconnect prompt)',
    };
  }
  return {
    nextActor: 'Engineering',
    expired,
    action: 'Token still in date but re-exchange failed — investigate the Meta API error before the token lapses',
  };
}

/**
 * ENG-2442: per-ad-account dedupe identity shared with metaTrackingMonitor's token alert.
 * Keyed on the ad account only (not the user), so every Meta token/connection alert for one
 * account folds onto ONE open canonical; a different account still gets its own.
 */
export function metaAccountAlertContext(accountId: string): Record<string, string> {
  return { 'Alert Class': TOKEN_ALERT_CLASS, 'Alert Scope': `meta-ad-account:${accountId}` };
}

/**
 * Raise the handoff. Returns true only when an alert was actually delivered. Never throws.
 *
 * Harsha 2026-11-07: alert ONLY when a connection that existed is now gone (token expired or
 * rejected as dead). An in-date re-exchange failure or a reconnect read-back failure is not a
 * lost connection — log it, do not alert. The alert carries facts only (no guessed next actor)
 * and goes to the Meta connection list, not oncall/founders.
 */
export async function raiseMetaConnectionHandoff(input: MetaHandoffInput): Promise<boolean> {
  const decision = decideMetaHandoff(input);
  const who = input.customerEmail || input.userId;
  const accountLabel = `${input.account.account_name || 'Meta ad account'} (${input.account.account_id})`;
  const expiresAt = (input.account.config as any)?.token_expires_at as number | undefined;
  const connectionLost =
    input.reason === 'refresh_failed' && (decision.expired || isMetaTokenDeadError(input.error));
  if (!connectionLost) {
    console.warn(`[MetaConnectionHandoff] ${input.reason} for ${who} ${accountLabel} (not alerted): ${input.error}`);
    return false;
  }
  try {
    const { sendMetaConnectionExpiredAlert } = await import('./metaConnectionExpiredAlert');
    return await sendMetaConnectionExpiredAlert({
      accountId: String(input.account.account_id),
      accountName: input.account.account_name,
      customerEmail: input.customerEmail,
      userId: input.userId,
      expiredAt: expiresAt,
      error: input.error,
      now: input.now,
    });
  } catch (error) {
    console.error(`[MetaConnectionHandoff] Failed to raise handoff for ${who} ${accountLabel}:`, error);
    return false;
  }
}

export interface MetaReadBackResult {
  ok: boolean;
  error?: string;
}

/**
 * Post-reconnect read-back: prove the stored token can actually read the ad
 * account (a real Graph GET), instead of trusting the OAuth callback. Never throws.
 */
export async function verifyMetaAdAccountReadBack(
  adAccountId: string,
  accessToken: string
): Promise<MetaReadBackResult> {
  try {
    await metaService.getAdAccountCurrency(adAccountId, accessToken);
    return { ok: true };
  } catch (error: any) {
    return { ok: false, error: error?.message || String(error) };
  }
}
