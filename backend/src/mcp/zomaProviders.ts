/**
 * ENG-2823 — Zoma ad-platform providers. The Zoma layer (ENG-2282/2283/2303) was written for
 * Meta only; this is the pluggable seam it now runs on. Meta is provider #1 with exactly the
 * rules and messages it had; Google Ads is provider #2.
 *
 * A provider says which connected accounts belong to it, when a connection is usable, how an
 * account id is normalized, and how its errors read. The shared machinery — account
 * resolution (own + org-shared), the preview → confirm guard (zomaWriteGuard.ts), per-call
 * metering (platform recorded on every event) and setup status (zomaOnboarding.ts) — is
 * provider-neutral.
 *
 * Pure apart from the connected-account shape: no db, no network.
 */
import type { ConnectedAccount } from '../services/connectedAccountsDb';
import { isMetaAdAccount } from '../services/metaTokenRefresh';

export type ZomaPlatform = 'meta' | 'google_ads' | 'x_ads';

export interface ZomaProvider {
  platform: ZomaPlatform;
  /** "Meta", "Google Ads", "X Ads": used in status lines. */
  label: string;
  /** "Meta ad account": singular noun used in refusals. */
  accountNoun: string;
  /** Tool argument that names the account ("account_id" | "customer_id"). */
  accountArg: string;
  isAdAccount(account: ConnectedAccount): boolean;
  isUsable(account: ConnectedAccount, now: number): boolean;
  normalizeId(raw: unknown): string;
  /** Normalized ids this connection answers to. */
  accountIds(account: ConnectedAccount): string[];
}

/** ENG-2303: a Meta connection is unusable once its ads scope was revoked or its token expired. */
export function metaConnectionIsUsable(account: ConnectedAccount, now: number): boolean {
  const config: any = account.config;
  if (config?.ads_scope_revoked_at) return false;
  const expiresAt = config?.token_expires_at;
  return !(typeof expiresAt === 'number' && expiresAt < now);
}

const normalizeMetaId = (id: unknown) => String(id ?? '').trim().replace(/^act_/, '');

export const META_PROVIDER: ZomaProvider = {
  platform: 'meta',
  label: 'Meta',
  accountNoun: 'Meta ad account',
  accountArg: 'account_id',
  isAdAccount: isMetaAdAccount,
  isUsable: metaConnectionIsUsable,
  normalizeId: normalizeMetaId,
  // Ordered: ad_account_id is the canonical id when an account is auto-selected.
  accountIds: (a) => [normalizeMetaId((a.config as any)?.ad_account_id), normalizeMetaId(a.account_id)].filter(Boolean),
};

const normalizeGoogleId = (id: unknown) => String(id ?? '').trim().replace(/-/g, '');

/**
 * A Google Ads connection (routes/googleAdsAuth.ts /connect) carries customer_id +
 * login_customer_id. googleAdsService refreshes an expired access token with the refresh
 * token, so expiry alone does not make it unusable; no refresh token and an expired
 * access token does.
 */
export function googleAdsConnectionIsUsable(account: ConnectedAccount, now: number): boolean {
  const cfg: any = account.config;
  if (!cfg?.customer_id) return false;
  if (cfg.refresh_token) return true;
  if (!cfg.access_token) return false;
  return !(typeof cfg.token_expires_at === 'number' && cfg.token_expires_at < now);
}

export const GOOGLE_ADS_PROVIDER: ZomaProvider = {
  platform: 'google_ads',
  label: 'Google Ads',
  accountNoun: 'Google Ads account',
  accountArg: 'customer_id',
  isAdAccount: (a) => a.platform === 'google_ads',
  isUsable: googleAdsConnectionIsUsable,
  normalizeId: normalizeGoogleId,
  accountIds: (a) => [normalizeGoogleId((a.config as any)?.customer_id)].filter(Boolean),
};

const normalizeXAdsId = (id: unknown) => String(id ?? '').trim().toLowerCase();

/**
 * ENG-3142: an X Ads connection (routes/xAdsAuth.ts) holds an OAuth 1.0a access token + secret,
 * which do not expire; it is unusable once either is missing or an Ads API call saw a 401.
 */
export function xAdsConnectionIsUsable(account: ConnectedAccount, _now: number): boolean {
  const cfg: any = account.config;
  return Boolean(cfg?.ad_account_id && cfg?.access_token && cfg?.access_token_secret && !cfg?.needs_reconnect);
}

export const X_ADS_PROVIDER: ZomaProvider = {
  platform: 'x_ads',
  label: 'X Ads',
  accountNoun: 'X Ads account',
  accountArg: 'account_id',
  isAdAccount: (a) => a.platform === 'x_ads',
  isUsable: xAdsConnectionIsUsable,
  normalizeId: normalizeXAdsId,
  accountIds: (a) => [normalizeXAdsId((a.config as any)?.ad_account_id)].filter(Boolean),
};

export const ZOMA_PROVIDERS: Record<ZomaPlatform, ZomaProvider> = {
  meta: META_PROVIDER,
  google_ads: GOOGLE_ADS_PROVIDER,
  x_ads: X_ADS_PROVIDER,
};

export { googleToolkitEnabled, xAdsToolkitEnabled } from './zomaToolDefinitions';

export type AccountResolution =
  | { ok: true; accountId: string; account: ConnectedAccount }
  | { ok: false; kind: 'forbidden' | 'ambiguous'; message: string };

/**
 * Resolve the account a call runs against, from the caller's own + org-shared connections.
 * A requested account must be one the caller can see and its connection must be usable;
 * without a request, exactly one usable connection must exist.
 */
export function resolveProviderAccount(
  provider: ZomaProvider,
  accounts: ConnectedAccount[],
  requestedAccountId: unknown,
  now: number,
): AccountResolution {
  const own = accounts.filter(provider.isAdAccount);
  const requested = provider.normalizeId(requestedAccountId);
  const label = provider.label;

  if (requested) {
    const match = own.find((a) => provider.accountIds(a).includes(requested));
    if (!match) return { ok: false, kind: 'forbidden', message: `That ${provider.accountNoun} is not connected to this account.` };
    if (!provider.isUsable(match, now)) {
      return { ok: false, kind: 'forbidden', message: `The ${label} connection for this ${provider.accountNoun.replace(`${label} `, '')} was revoked or expired. Reconnect ${label}.` };
    }
    return { ok: true, accountId: requested, account: match };
  }

  const usable = own.filter((a) => provider.isUsable(a, now));
  if (usable.length === 0) {
    return { ok: false, kind: 'forbidden', message: `No usable ${provider.accountNoun} is connected. Connect or reconnect ${label}.` };
  }
  if (usable.length > 1) {
    return { ok: false, kind: 'ambiguous', message: `Multiple ${provider.accountNoun}s are connected; pass ${provider.accountArg}.` };
  }
  return { ok: true, accountId: provider.accountIds(usable[0])[0], account: usable[0] };
}
