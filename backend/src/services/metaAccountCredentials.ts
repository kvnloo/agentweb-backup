import { ensureFreshMetaAdAccountToken } from './metaTokenRefresh';

/**
 * Shared Meta ad-account credential resolution.
 *
 * Extracted out of `routes/metaV2.ts` (where it was private/non-exported) into its own leaf
 * module so it can be reused by `metaService.resolveMetaPixelForUser` and by the CAPI send in
 * `routes/webhooks.ts` without creating a circular import: `metaTokenRefresh.ts` already
 * imports `metaService.ts`, so this module intentionally depends only on `metaTokenRefresh.ts`
 * and NOT on `metaService.ts` — callers in `metaService.ts` reach it via a dynamic `import()`
 * at call time (same lazy-import pattern already used elsewhere in that file for
 * `utils/metaApiFetch`), which is what actually avoids the cycle in practice.
 *
 * `metaV2.ts` imports these back from here so there is exactly one implementation, not two
 * that can drift apart.
 */

export const cleanAccountId = (id: string) => (id || '').replace('act_', '');

/**
 * Return all connected Meta ad-account entries for a user.
 */
export function getConnectedMetaAccountsList(user: any) {
  const accounts = user.connected_accounts || [];
  return accounts
    .filter((acc: any) =>
      (acc.platform === 'facebook' || acc.platform === 'meta') &&
      acc.config?.account_type === 'ad_account' &&
      acc.config?.access_token
    )
    .map((acc: any) => ({
      accountId: cleanAccountId(acc.account_id || acc.config?.ad_account_id || ''),
      accountName: acc.account_name || acc.config?.name || 'Unknown Account',
      currency: acc.config?.currency || 'USD',
      status: acc.config?.account_status,
      tokenExpiresAt: acc.config?.token_expires_at || null,
    }));
}

/**
 * Get credentials for a specific (or the only) Meta ad account.
 *
 * Proactively refreshes the access token inline (fb_exchange_token) when it is
 * expired or close to expiry, so callers self-heal the same way the agent tool
 * path does instead of hard-failing between cron runs.
 * `userId` is required to persist a refreshed token. Throws a user-friendly
 * error only if the account is missing, or the token is expired AND could not
 * be refreshed.
 */
export async function getMetaAccountCredentials(
  user: any,
  userId: string,
  accountId?: string
): Promise<{ accountId: string; accessToken: string; accountName: string }> {
  const accounts = user.connected_accounts || [];
  const fbAccounts = accounts.filter((acc: any) =>
    (acc.platform === 'facebook' || acc.platform === 'meta') &&
    acc.config?.account_type === 'ad_account' &&
    acc.config?.access_token
  );

  if (fbAccounts.length === 0) {
    throw new Error(
      'No Meta ad account connected. Please connect your Facebook account in Settings.'
    );
  }

  let selected: any;

  if (accountId) {
    const target = cleanAccountId(accountId);
    selected = fbAccounts.find(
      (acc: any) => cleanAccountId(acc.account_id || acc.config?.ad_account_id || '') === target
    );
    if (!selected) {
      throw new Error(
        `Meta ad account "${accountId}" not found in your connected accounts.`
      );
    }
  } else if (fbAccounts.length === 1) {
    selected = fbAccounts[0];
  } else {
    throw new Error(
      'Multiple Meta ad accounts found. Please specify account_id.'
    );
  }

  // Self-heal: refresh in place if within the refresh window / expired-but-exchangeable.
  await ensureFreshMetaAdAccountToken(selected, userId);

  if (selected.config?.token_expires_at && selected.config.token_expires_at < Date.now()) {
    throw new Error(
      'Meta access token has expired and could not be refreshed automatically. Please reconnect your Meta account in Settings.'
    );
  }

  return {
    accountId: cleanAccountId(selected.account_id || selected.config?.ad_account_id || ''),
    accessToken: selected.config.access_token,
    accountName: selected.account_name || selected.config?.name || 'Unknown Account',
  };
}

/**
 * Validate that a pixelId/accountId pair genuinely belongs to the caller's own connected
 * Meta accounts before persisting it anywhere a customer submits one explicitly (a Calendly
 * attribution choice, a landing-page generation override, etc.) — never trust a client-
 * submitted pair. Throws a user-friendly error if the account isn't connected or the pixel
 * isn't found on it; returns the cleaned accountId on success. Shared by
 * `routes/connectedAccounts.ts`'s Calendly attribution route and
 * `routes/landingPageGeneration.ts`'s generation-time override, so the check can't drift
 * between the two call sites.
 *
 * Imports `./metaService` dynamically, not at module top level, for the same reason
 * `metaService.ts` imports this module dynamically — `metaService.ts` -> `metaTokenRefresh.ts`
 * already forms one edge of the cycle; a static import here would close the loop.
 */
export async function assertOwnedMetaPixel(
  user: any,
  userId: string,
  pixelId: string,
  accountId: string,
): Promise<{ accountId: string }> {
  const cleaned = cleanAccountId(accountId);
  const accounts = getConnectedMetaAccountsList(user);
  if (!accounts.some((acc: any) => acc.accountId === cleaned)) {
    throw new Error(`Meta ad account "${accountId}" is not one of your connected accounts.`);
  }

  const { metaService } = await import('./metaService');
  const { accountId: resolvedAccountId, accessToken } = await getMetaAccountCredentials(user, userId, cleaned);
  const pixels = await metaService.listPixels(resolvedAccountId, accessToken);
  if (!(pixels || []).some((p: any) => p.id === pixelId)) {
    throw new Error(`Pixel "${pixelId}" was not found on ad account ${resolvedAccountId}.`);
  }
  return { accountId: resolvedAccountId };
}
