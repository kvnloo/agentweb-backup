/**
 * Meta Ads scope capability helpers (ENG-629).
 *
 * WHY THIS EXISTS
 * ---------------
 * A Meta connection can be present, unexpired and "active" while still being
 * incapable of reading ads data, because the user declined the ads permissions
 * at the consent screen. Production symptom (OPS-79): the scheduled report on
 * account 922903076601160 failed with
 *   "(#200) Ad account owner has NOT granted ads_management or ads_read permission"
 * while `list_connected_accounts` reported the account as connected + active,
 * and the run produced a report containing no data instead of a loud failure.
 *
 * THE TRAP THIS MODULE EXISTS TO AVOID
 * ------------------------------------
 * `BaseOAuthConfig.scopes` is NOT a capability signal for Meta. The marketing
 * OAuth finalize path historically stored `flowCfg.scopes` — the scopes we
 * *asked* for — regardless of what Meta actually granted. Gating on that field
 * would report "granted" for precisely the account that is failing. Only
 * `granted_scopes`, populated from Meta's `debug_token` response, is
 * authoritative; when it is absent we must say 'unknown' rather than guess.
 *
 * Everything here is pure and synchronous: no network, no clock, no I/O.
 */

/** The scopes Meta accepts for reading campaign + insights data. */
export const META_ADS_READ_SCOPES = ['ads_read', 'ads_management'] as const;

/**
 * Tri-state because "we have no record" is genuinely different from "we know
 * they don't have it". Only 'missing' is strong enough to refuse work before
 * calling Meta; 'unknown' must let the call through and rely on Meta's own
 * authoritative answer, so we never lock out a working legacy connection.
 */
export type MetaAdsScopeState = 'granted' | 'missing' | 'unknown';

/** Minimal structural shape — avoids importing the DB types into a pure util. */
export interface MetaAdsScopeConfigLike {
  granted_scopes?: unknown;
  scopes?: unknown;
}

/**
 * The single canonical, actionable, non-secret message for this failure.
 *
 * It names the capability, tells the owner exactly how to fix it, and states
 * outright that nothing was read — so a scheduled run can never be narrated as
 * "metrics retrieved" (ENG-629 AC2 + AC3).
 */
export const META_ADS_RECONSENT_MESSAGE =
  'Meta Ads access is not authorized for this connection. The connected Meta account has not granted the ' +
  '"ads_read" (or "ads_management") permission, so no campaign or insights data could be read. ' +
  'Reconnect Meta under Settings -> Connected accounts and approve the Ads permissions when prompted, ' +
  'then run this again. No metrics were retrieved.';

const isAdsScope = (value: unknown): boolean =>
  typeof value === 'string' &&
  (META_ADS_READ_SCOPES as readonly string[]).includes(value.trim());

/**
 * What do we actually know about this connection's ads capability?
 *
 * Deliberately reads ONLY `granted_scopes`. See the module header: `scopes`
 * holds requested-not-granted values for Meta and is untrustworthy here.
 */
export const getMetaAdsScopeState = (
  config: MetaAdsScopeConfigLike | null | undefined
): MetaAdsScopeState => {
  const granted = config?.granted_scopes;
  if (!Array.isArray(granted) || granted.length === 0) return 'unknown';
  return granted.some(isAdsScope) ? 'granted' : 'missing';
};

/**
 * True only when we can affirmatively prove ads access. 'unknown' is false:
 * absence of proof is not proof of capability.
 */
export const hasMetaAdsReadScope = (
  config: MetaAdsScopeConfigLike | null | undefined
): boolean => getMetaAdsScopeState(config) === 'granted';

/** Pull a Graph API error code out of any of the shapes Meta errors arrive in. */
const extractGraphCode = (error: any): number | undefined => {
  const raw =
    error?.structuredError?.code ??
    error?.response?.data?.error?.code ??
    error?.response?.data?.code ??
    error?.error?.code ??
    error?.code;
  const code = Number(raw);
  return Number.isFinite(code) ? code : undefined;
};

/**
 * Is this Meta telling us, authoritatively, that the token lacks ads permission?
 *
 * Scoped tightly on purpose:
 *  - code 190 (expired/invalid token) is excluded — it has its own remedy and
 *    its own message; routing it here would hand the user the wrong fix.
 *  - code 100 (validation, e.g. the `filtering must be an array` defect owned
 *    by ENG-630) is excluded — it must not be masked by re-consent messaging.
 */
export const isMetaAdsPermissionError = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false;

  const err = error as any;

  if (err.structuredError?.classification === 'PERMISSION_ERROR') return true;

  const code = extractGraphCode(err);
  if (code !== undefined) {
    if (code === 190 || code === 100) return false;
    if (code === 10 || (code >= 200 && code <= 299)) return true;
  }

  const message = typeof err.message === 'string' ? err.message.toLowerCase() : '';
  if (!message) return false;

  // Meta prefixes the permission refusal with "(#200)"; the 403 path in
  // metaService throws "Meta Permission Denied: ...".
  if (message.includes('(#200)')) return true;
  if (message.includes('meta permission denied')) return true;
  if (message.includes('not granted') && message.includes('ads_')) return true;
  if (message.includes('ads_management or ads_read')) return true;

  return false;
};

/**
 * Build the one error every ads-scope failure surfaces as.
 *
 * Flagged `isMetaAuthError` so it rides the existing rethrow channel in
 * agentModeService (`if (error.isMetaAuthError) throw error`) instead of being
 * flattened into a soft `{ success: false }` that the model narrates as an
 * empty-but-fine result.
 *
 * The upstream error is attached as `cause` for logs but is NEVER interpolated
 * into the message — Meta echoes tokens and fbtrace ids into error strings.
 */
export const buildMetaAdsScopeError = (opts?: {
  accountLabel?: string;
  cause?: unknown;
}): Error => {
  const label = opts?.accountLabel?.trim();
  const message = label
    ? `${META_ADS_RECONSENT_MESSAGE} Affected account: ${label}.`
    : META_ADS_RECONSENT_MESSAGE;

  const err = new Error(message) as any;
  err.isMetaAuthError = true;
  err.isMetaAdsScopeError = true;
  err.code = 'META_ADS_SCOPE_MISSING';
  err.missingScopes = [...META_ADS_READ_SCOPES];
  err.needsReconnect = true;
  if (opts?.cause !== undefined) err.cause = opts.cause;
  return err as Error;
};
