import { getAccountsWithOwnerIncludingOrgShared, updateAccountConfig } from './connectedAccountsDb';
import { listEmailAccounts, scrubSmartleadSecrets, SmartleadApiError } from './smartleadService';
import { decryptPassword } from '../utils/crypto';

/**
 * Finding and trusting a user's stored Smartlead key (ENG-673). Modelled on resolveLuma in emma/lumaTools.ts:
 * a connection owned by a teammate is usable only when they shared it, write-backs go to the OWNER's record, and a key
 * is only called dead after an independent probe agrees, because one 401 can be a Smartlead-side blip.
 */

export type ResolvedSmartlead =
  | { ok: true; apiKey: string; ownerUserId: string; accountId: string; accountName: string }
  | { ok: false; reason: 'not_connected' | 'key_unreadable' | 'key_rejected' | 'choose'; message: string };

const NOT_CONNECTED = 'No Smartlead account is connected. Add your Smartlead API key in Settings, Login Credentials.';
const REJECTED = 'Smartlead rejected the saved API key (revoked, or the plan no longer includes API access). Replace the key in Settings, Login Credentials.';

type Probe = 'ok' | 'rejected' | 'unknown';

/** One cheap call with no retries. Only a 401 or 403 from /email-accounts proves the key itself is unusable. */
async function probeKey(apiKey: string): Promise<Probe> {
  try {
    await listEmailAccounts(apiKey, { maxRetries: 0, maxPages: 1 });
    return 'ok';
  } catch (error) {
    return error instanceof SmartleadApiError && (error.status === 401 || error.status === 403) ? 'rejected' : 'unknown';
  }
}

async function setNeedsReconnect(ownerUserId: string, accountId: string, value: boolean): Promise<void> {
  try {
    await updateAccountConfig(
      ownerUserId,
      'smartlead',
      accountId,
      value ? { needs_reconnect: true } : () => ({ updates: {}, unset: ['needs_reconnect'] }),
    );
  } catch (error) {
    console.warn('[Smartlead] Could not update the key flag:', scrubSmartleadSecrets(error instanceof Error ? error.message : String(error)));
  }
}

/**
 * The key to use for this user: their own connection first, else the single one a teammate shared. `accountId`
 * picks one explicitly. A flagged key is re-probed once, so a key that recovers (a renewed plan) works again
 * without the user reconnecting.
 */
export async function resolveSmartlead(userId: string, accountId?: string): Promise<ResolvedSmartlead> {
  const all = (await getAccountsWithOwnerIncludingOrgShared(userId)).filter(a => a.platform === 'smartlead');
  if (all.length === 0) return { ok: false, reason: 'not_connected', message: NOT_CONNECTED };

  const ownerOf = (a: { userId?: string }) => a.userId ?? userId;
  const own = all.filter(a => ownerOf(a) === userId);
  let account: (typeof all)[number];
  if (accountId) {
    const match = all.find(a => a.account_id === accountId);
    if (!match) return { ok: false, reason: 'not_connected', message: NOT_CONNECTED };
    account = match;
  } else if (own.length === 1) {
    account = own[0];
  } else if (own.length === 0 && all.length === 1) {
    account = all[0];
  } else {
    // Several candidates and none clearly the caller's: do not guess whose Smartlead account to send into.
    return { ok: false, reason: 'choose', message: 'Several Smartlead connections are available. Choose which one to use.' };
  }

  const ownerUserId = ownerOf(account);
  let apiKey: string;
  try {
    apiKey = decryptPassword((account.config as { access_token: string }).access_token).password;
  } catch {
    return { ok: false, reason: 'key_unreadable', message: REJECTED };
  }

  if ((account.config as { needs_reconnect?: boolean }).needs_reconnect) {
    const probe = await probeKey(apiKey);
    if (probe === 'rejected') return { ok: false, reason: 'key_rejected', message: REJECTED };
    if (probe === 'ok') await setNeedsReconnect(ownerUserId, account.account_id, false);
    // 'unknown' (timeout, 429, 5xx): not proof either way, so let the real call report honestly.
  }

  return { ok: true, apiKey, ownerUserId, accountId: account.account_id, accountName: account.account_name };
}

export type SmartleadFailureVerdict = 'key_rejected' | 'transient_auth_error' | 'not_an_auth_error';

/**
 * Call after a Smartlead request failed. A 401 or 403 is checked with an independent probe before the key is flagged
 * dead, so the saved connection is not marked broken (and not shown as "Reconnect required") by a one-off error.
 */
export async function reportSmartleadFailure(
  resolved: Extract<ResolvedSmartlead, { ok: true }>,
  error: unknown,
): Promise<SmartleadFailureVerdict> {
  if (!(error instanceof SmartleadApiError) || (error.status !== 401 && error.status !== 403)) return 'not_an_auth_error';
  const probe = await probeKey(resolved.apiKey);
  if (probe === 'rejected') {
    await setNeedsReconnect(resolved.ownerUserId, resolved.accountId, true);
    return 'key_rejected';
  }
  return 'transient_auth_error';
}
