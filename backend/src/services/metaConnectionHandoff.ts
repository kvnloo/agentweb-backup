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
import { sendAgentModeOncallAlert } from '../utils/agentModeAlerts';
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

/** Raise the handoff. Returns true only when an alert was actually delivered. Never throws. */
export async function raiseMetaConnectionHandoff(input: MetaHandoffInput): Promise<boolean> {
  const decision = decideMetaHandoff(input);
  const who = input.customerEmail || input.userId;
  const accountLabel = `${input.account.account_name || 'Meta ad account'} (${input.account.account_id})`;
  const expiresAt = (input.account.config as any)?.token_expires_at as number | undefined;
  const headline =
    input.reason === 'reconnect_readback_failed'
      ? 'reconnect did not restore access'
      : decision.expired
        ? 'token expired'
        : 'token refresh failed';

  try {
    return await sendAgentModeOncallAlert({
      subject: `Meta connection: ${who} — ${accountLabel} ${headline}`,
      message:
        `Customer: ${who}\n` +
        `Account: ${accountLabel}\n` +
        `Token expires: ${expiresAt ? new Date(expiresAt).toISOString() : 'unknown'}\n` +
        `Error: ${input.error}\n\n` +
        `Next actor: ${decision.nextActor} — ${decision.action}`,
      userId: input.userId,
      dedupeKey: `meta-connection:${input.userId}:${input.account.account_id}:${input.reason}`,
      dedupeWindowMs: META_HANDOFF_DEDUPE_WINDOW_MS,
      now: input.now,
      context: {
        // ENG-2442: share the tracking monitor's per-account canonical (class + scope), so a
        // handoff re-fire for an account whose 'cannot be read — token invalid' issue is already
        // open lands on THAT issue as a recurrence instead of filing a parallel one each tick.
        ...metaAccountAlertContext(input.account.account_id),
        userId: input.userId,
        accountId: input.account.account_id,
        reason: input.reason,
        nextActor: decision.nextActor,
      },
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
