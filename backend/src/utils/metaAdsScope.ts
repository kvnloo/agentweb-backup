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
  /**
   * Set when Meta authoritatively refused an ads read for lack of permission.
   *
   * Load-bearing: for a legacy record the retained grant collapses to `[]`, which
   * is indistinguishable from "we never asked". Without this marker the state
   * would fall back to 'unknown' and every scheduled run would keep re-attempting
   * the same impossible read.
   */
  ads_scope_revoked_at?: unknown;
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
  const grantedList = Array.isArray(granted) ? granted : [];

  // An affirmative grant is the newest truth and always wins — a user who
  // reconnects recovers without anyone clearing the revocation marker by hand.
  if (grantedList.some(isAdsScope)) return 'granted';

  // Meta's own refusal, recorded. Authoritative even when the retained grant is
  // empty, which is exactly the legacy-record case.
  if (config?.ads_scope_revoked_at) return 'missing';

  // No grant recorded and no refusal seen: we genuinely do not know.
  if (grantedList.length === 0) return 'unknown';

  return 'missing';
};

/**
 * True only when we can affirmatively prove ads access. 'unknown' is false:
 * absence of proof is not proof of capability.
 */
export const hasMetaAdsReadScope = (
  config: MetaAdsScopeConfigLike | null | undefined
): boolean => getMetaAdsScopeState(config) === 'granted';

/**
 * Read a nested value by path, yielding undefined the moment the chain breaks.
 *
 * Deliberately a loop over a declared path rather than an inline `a?.b?.c?.d`
 * chain: Meta delivers errors in several shapes, and spelling each one out as
 * optional chaining multiplies code paths for what is really one lookup.
 */
const pick = (source: unknown, path: readonly string[]): unknown =>
  path.reduce<any>((value, key) => (value == null ? undefined : value[key]), source);

/** Where Meta puts the Graph error code, most specific first. */
const GRAPH_CODE_PATHS: readonly (readonly string[])[] = [
  ['structuredError', 'code'],
  ['response', 'data', 'error', 'code'],
  ['response', 'data', 'code'],
  ['error', 'code'],
  ['code'],
];

/** Where Meta puts human-readable failure text. */
const ERROR_TEXT_PATHS: readonly (readonly string[])[] = [
  ['message'],
  ['structuredError', 'message'],
  ['structuredError', 'error_user_msg'],
  ['structuredError', 'error_user_title'],
  ['response', 'data', 'error', 'message'],
  ['response', 'data', 'message'],
  ['error', 'message'],
];

/** Pull a Graph API error code out of whichever shape this error arrived in. */
const extractGraphCode = (error: unknown): number | undefined => {
  for (const path of GRAPH_CODE_PATHS) {
    const raw = pick(error, path);
    if (raw == null) continue;
    const code = Number(raw);
    return Number.isFinite(code) ? code : undefined;
  }
  return undefined;
};

/** Every place Meta might put human-readable text, flattened for inspection. */
const collectErrorText = (error: unknown): string =>
  ERROR_TEXT_PATHS.map(path => pick(error, path))
    .filter((s: unknown): s is string => typeof s === 'string')
    .join(' | ')
    .toLowerCase();

/**
 * Is this Meta *specifically* refusing us for lack of an Ads scope?
 *
 * Deliberately strict, and the strictness is the point. Meta classifies a whole
 * family of unrelated refusals as permission errors (code 10, code 200-299):
 * missing `business_management`, an inaccessible ad account, a disabled asset.
 * `metaService.handleError` stamps all of them `PERMISSION_ERROR`.
 *
 * This predicate authorizes two destructive-ish actions — replacing the error
 * with re-consent guidance, and narrowing the stored grant. Firing on a generic
 * permission error would strip `ads_read` from a connection that genuinely has
 * it and then block every later request behind advice that cannot fix anything:
 * a transient upstream error turned into a bricked customer connection.
 *
 * The costs are asymmetric, so the bar is asymmetric. A false negative just
 * falls through to the pre-existing soft error path with Meta's own message.
 * A false positive destroys working state. Therefore: Meta must NAME an Ads
 * scope. A permission code alone is never sufficient.
 *
 * Also excluded regardless of wording:
 *  - code 190 (expired/invalid token) — its own remedy, its own message.
 *  - code 100 (validation, e.g. the `filtering must be an array` defect owned by
 *    ENG-630) — a malformed-field error that happens to reference `ads_read`
 *    must not revoke a grant.
 */
export const isMetaAdsScopeRefusal = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false;

  const err = error as any;
  const code = extractGraphCode(err);

  // Hard exclusions — these are never scope refusals, whatever the text says.
  if (code === 190 || code === 100) return false;

  const text = collectErrorText(err);
  if (!text) return false;

  // Necessary: Meta must name the capability it is refusing.
  const namesAdsScope = (META_ADS_READ_SCOPES as readonly string[]).some(scope =>
    text.includes(scope)
  );
  if (!namesAdsScope) return false;

  // Sufficient: and it must read as a permission refusal rather than an
  // incidental mention of the scope name.
  const isPermissionShaped =
    code === 10 ||
    (code !== undefined && code >= 200 && code <= 299) ||
    err.structuredError?.classification === 'PERMISSION_ERROR' ||
    text.includes('(#200)') ||
    text.includes('permission') ||
    text.includes('not granted');

  return Boolean(isPermissionShaped);
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
