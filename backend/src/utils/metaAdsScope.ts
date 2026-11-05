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
   * Which kind of Meta connection this is. Only 'ad_account' records can have an
   * Ads capability at all — a page or Instagram business connection lacking
   * ads_read is not degraded, it simply never needed the scope.
   */
  account_type?: unknown;
  /**
   * Set when Meta authoritatively refused an ads read for lack of permission.
   *
   * Load-bearing: for a legacy record the retained grant collapses to `[]`, which
   * is indistinguishable from "we never asked". Without this marker the state
   * would fall back to 'unknown' and every scheduled run would keep re-attempting
   * the same impossible read.
   */
  ads_scope_revoked_at?: unknown;
  /**
   * When the reconciler first saw Meta refuse this ad account, pending
   * confirmation by a second sweep (ENG-1158).
   *
   * Deliberately NOT read by `getMetaAdsScopeState`: a suspicion must change
   * nothing a user can feel. One denied probe is weak evidence — Meta returns
   * the ads refusal transiently too, e.g. while a Business Manager permission
   * change propagates — and acting on it would strip a working customer's grant
   * and mail them about an outage that had already ended. Cleared by any
   * successful probe, so two unrelated denials a month apart can never add up to
   * a confirmation.
   */
  ads_scope_denied_seen_at?: unknown;
  /**
   * Which of the two independent grants is actually missing, set alongside
   * `ads_scope_revoked_at` (ENG-1158 follow-up).
   *
   * Meta requires TWO separate grants before an ads read works: the user
   * authorizing our app for `ads_read`/`ads_management` (OAuth), and the ad
   * account's owner separately granting that user access to that specific ad
   * account (Business Manager asset roles) — a screen our OAuth flow never
   * touches. `ads_scope_revoked_at` alone cannot say which is missing, and
   * guessing wrong sends a customer to reconnect and re-approve a grant they
   * already have, for a permission reconnecting can never restore.
   *
   * 'oauth'   — our own record shows no ads scope granted to the app. Reconnect
   *             is the correct, sufficient fix.
   * 'asset'   — the app grant is confirmed present; Meta refused the ad account
   *             read anyway. Only the ad account's own admin, in Meta Business
   *             Settings, can fix this — reconnecting changes nothing.
   * Absent    — tier could not be determined (e.g. the classifying call itself
   *             failed); falls back to the OAuth-tier message, matching this
   *             module's behaviour before this distinction existed.
   */
  ads_scope_tier?: unknown;
  /**
   * When the Meta signal behind the last revoke-or-recover write was learned
   * (ISO 8601), set alongside every such write (ENG-1158 follow-up — Greptile).
   *
   * Two independent processes can reach a capability conclusion for the same
   * account close together — the 12-hourly sweep's probe and a live chat run's
   * read failure — and a CAS retry alone only guarantees the WRITE reflects
   * fresh DB state, not that the DECISION being written is the newer of the
   * two. Without this, the loser of that race can still overwrite the
   * winner's transition with individually-fresh-looking values, just derived
   * from a stale decision.
   *
   * Every revoke/recover write compares its own probe's timestamp against
   * this field on the config it just read and no-ops if the stored one is
   * newer — the most recent real signal from Meta always wins, regardless of
   * which write reaches the database first.
   */
  ads_capability_probed_at?: unknown;
  /**
   * Whether this connection has at least one accessible Facebook Page, probed
   * once via PAGE LIST at connect/reconnect time (ENG-2232).
   *
   * Independent of `granted_scopes`: the OAuth `ads_read`/`ads_management`
   * scope and Page access are two separate Meta grants, and a token can hold
   * the former with zero of the latter. Production case (ENG-2232): ad account
   * 1209971551106961 reported `ads_capable: true` (ads_read granted) while
   * PAGE LIST returned 0 Pages both before and after the customer reconnected
   * — every AD_CREATIVE CREATE needs a page_id, so the build failed only after
   * 4 campaigns and 4 ad sets had already been approved through the deck.
   *
   * Tri-state for the same reason as the scope fields above: `undefined` means
   * "never probed" (legacy record, or the probe itself failed) and must not be
   * read as either answer.
   */
  has_meta_pages?: unknown;
  /**
   * Set only when `has_meta_pages` is `false` *because* this account's own
   * existing ad creatives were found to run under a specific Facebook Page
   * that isn't among the ones this connection can access (ENG-2232) — as
   * opposed to the connection having zero accessible Pages at all. Lets
   * `describeMetaAdsCapability` name the actual Page in the warning instead
   * of a generic "no Pages are accessible" that would be factually wrong
   * when some OTHER Page is reachable.
   */
  existing_ads_page_id?: unknown;
  /**
   * The actual accessible Facebook Page ids, probed alongside `has_meta_pages`
   * (ENG-2232) — lets a gate check a SPECIFIC page_id (e.g. the one an
   * AD_CREATIVE CREATE call is about to use) against the real set, rather
   * than only the aggregate "has at least one" boolean. `undefined` means
   * "never probed", same tri-state discipline as every other field here.
   */
  accessible_page_ids?: unknown;
  /**
   * The moment the twice-daily reconciliation sweep's Page probe (`has_meta_pages`
   * / `existing_ads_page_id` / `accessible_page_ids`) was learned (ENG-2232) —
   * the Page-access sibling of `ads_capability_probed_at` above, same CAS-retry
   * race it guards against: a sweep's write, retried after a conflict, must
   * defer to a concurrent writer's (another sweep's, or a reconnect's) NEWER
   * Page probe rather than overwrite it with this one's now-stale answer.
   * Internal to `metaAdsCapabilitySync.ts`'s own write — no gate reads it.
   */
  page_access_probed_at?: unknown;
  /** Required OAuth permissions that /me/permissions says the user explicitly declined. */
  declined_required_permissions?: unknown;
  /** Failure from the /me/permissions health read. Unknown is a warning, not healthy. */
  meta_oauth_health_error?: unknown;
  /** Complete /me/accounts count when the OAuth health read succeeded. */
  meta_page_count?: unknown;
  /** Failure from the /me/accounts health read. Distinct from confirmed zero Pages. */
  meta_page_health_error?: unknown;
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

/**
 * The asset-tier counterpart to `META_ADS_RECONSENT_MESSAGE` (ENG-1158 follow-up).
 *
 * Used only when `ads_scope_tier === 'asset'` — the app-level grant is confirmed
 * present, so telling the owner to reconnect and re-approve permissions they
 * already granted would send them through a flow that cannot fix this and leave
 * them locked out with no correct next step.
 */
export const META_ADS_ASSET_ACCESS_MESSAGE =
  'Meta Ads access is not authorized for this ad account. This Meta account has already granted AgentWeb the ' +
  '"ads_read" (or "ads_management") permission, but the ad account itself has not granted this person access, ' +
  'so no campaign or insights data could be read. Reconnecting will not fix this. Ask whoever manages this ad ' +
  'account in Meta Business Settings to add this person with Ads permissions, then run this again. ' +
  'No metrics were retrieved.';

/**
 * ENG-2232: no Facebook Page is accessible with this connection, so ad
 * creation cannot succeed however healthy the ad-account grant looks.
 *
 * Distinct from the two messages above: this fires even when ads_read/
 * ads_management IS granted, because Page access is a second, independent
 * Meta grant that OAuth scopes say nothing about.
 */
export const META_ADS_NO_PAGES_MESSAGE =
  'Meta Ads access is incomplete for this connection: no Facebook Pages are accessible, and every ad creative ' +
  'must reference a Page, so ad creation will fail. Reconnect Meta under Settings -> Connected accounts, choose ' +
  'Edit access, select all current and future Pages (or at least the Page you will advertise from), approve all ' +
  'requested permissions, and/or ask whoever manages that Page in Meta Business Settings to add this person with ' +
  '"Create ads" (Advertiser) access, then run this again. No ads were created.';

export const buildMetaOAuthDeclinedPermissionsMessage = (permissions: string[]): string =>
  `Meta Ads access is incomplete for this connection: Meta says the required permission(s) ` +
  `${permissions.join(', ')} were declined. Reconnect Meta under Settings -> Connected accounts; when Meta opens, ` +
  `choose Edit access, select all current and future Pages, and approve all requested permissions. No ads were created.`;

export const buildMetaOAuthHealthUnknownMessage = (reason: string): string =>
  `Meta Ads access could not be fully verified for this connection (${reason}). Reconnect Meta under Settings -> ` +
  `Connected accounts if this keeps happening, and make sure Edit access includes all current and future Pages and all requested permissions.`;

/**
 * ENG-2232: the subtler sibling of `META_ADS_NO_PAGES_MESSAGE` — this
 * connection DOES have access to some Page, just not the one this account's
 * own existing ads already run under. Naming the specific Page (inferred
 * from existing ad creatives, per the issue's own suggestion) is the whole
 * point: "no Pages are accessible" would be false here and send the owner
 * chasing the wrong fix.
 */
export const buildMetaAdsWrongPageMessage = (existingAdsPageId: string): string =>
  `Meta Ads access is incomplete for this connection: this account's existing ads run under Facebook Page ` +
  `${existingAdsPageId}, which isn't one of the Pages this connection can currently access, so ad creation will ` +
  `fail. Reconnect Meta under Settings -> Connected accounts and select that Page on the "Choose Pages" step, ` +
  `and/or ask whoever manages it in Meta Business Settings to add this person with "Create ads" (Advertiser) ` +
  `access, then run this again. No ads were created.`;

/**
 * ENG-2232: the precise sibling of both messages above, for AD_CREATIVE
 * CREATE specifically — that call always carries a concrete `page_id`
 * (Meta requires it), so this names exactly the Page it tried to use instead
 * of a historical inference.
 */
export const buildMetaAdsPageNotAccessibleMessage = (requestedPageId: string): string =>
  `Meta Ads access does not include Facebook Page ${requestedPageId} — this ad creative can't be created under ` +
  `that Page. Reconnect Meta under Settings -> Connected accounts and select that Page on the "Choose Pages" ` +
  `step, and/or ask whoever manages it in Meta Business Settings to add this person with "Create ads" ` +
  `(Advertiser) access, then run this again. No ads were created.`;

/**
 * The accessible Facebook Page ids themselves, when probed. `undefined`
 * (not `[]`) when never probed, so a gate can tell "we don't know" apart
 * from "we checked and it's empty" (ENG-2232).
 */
export const getAccessiblePageIds = (
  config: MetaAdsScopeConfigLike | null | undefined
): string[] | undefined => {
  const ids = config?.accessible_page_ids;
  if (!Array.isArray(ids)) return undefined;
  return ids.filter((id): id is string => typeof id === 'string');
};

/** The right message for a confirmed-missing Page state — generic or Page-specific. */
export const getMetaAdsNoPagesMessage = (config: MetaAdsScopeConfigLike | null | undefined): string => {
  const existingAdsPageId = config?.existing_ads_page_id;
  if (typeof existingAdsPageId === 'string' && existingAdsPageId) {
    return buildMetaAdsWrongPageMessage(existingAdsPageId);
  }
  return META_ADS_NO_PAGES_MESSAGE;
};

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
 * What do we know about this connection having at least one accessible
 * Facebook Page? (ENG-2232) Mirrors `getMetaAdsScopeState`'s tri-state shape:
 * a probe that never ran (legacy record) must read as 'unknown', never as a
 * confident answer either way.
 */
export const getMetaPagesAccessState = (
  config: MetaAdsScopeConfigLike | null | undefined
): MetaAdsScopeState => {
  const hasPages = config?.has_meta_pages;
  if (hasPages === true) return 'granted';
  if (hasPages === false) return 'missing';
  return 'unknown';
};

/** Minimal structural shape of a connected-account record. */
export interface MetaAdsAccountLike {
  platform?: unknown;
  config?: MetaAdsScopeConfigLike | null;
}

/**
 * The capability annotation carried by an ad-account connection.
 *
 * Deliberately sparse: fields are present only when we actually know the answer,
 * so an unprovable legacy record stays silent instead of accusing a working
 * connection of being broken.
 */
export interface MetaAdsCapabilityAnnotation {
  ads_capable?: boolean;
  /**
   * ENG-2822: false only when Page access is confirmed missing. Page access
   * gates CREATE (ads need a Page identity), never reads/reporting, so it must
   * not flip `ads_capable` — that is what dropped a spending account from reports.
   */
  can_create_ads?: boolean;
  capability_warning?: string;
}

/** Only Meta *ad account* records can have an ads capability at all. */
export const isMetaAdAccountRecord = (account: MetaAdsAccountLike | null | undefined): boolean =>
  (account?.platform === 'meta' || account?.platform === 'facebook') &&
  account?.config?.account_type === 'ad_account';

/**
 * The single capability annotation for a Meta ad-account connection.
 *
 * Shared on purpose (ENG-1158). The agent tool (`list_connected_accounts`) and
 * the Settings → Connected accounts API both render from this, so a connection
 * can never read as "degraded" to the model while its owner is still shown a
 * green "Connected" badge — the split that let account 922903076601160 produce
 * zero-data reports for days without anyone being told.
 */
export const describeMetaAdsCapability = (
  account: MetaAdsAccountLike | null | undefined
): MetaAdsCapabilityAnnotation => {
  if (!isMetaAdAccountRecord(account)) return {};

  const declined = account?.config?.declined_required_permissions;
  const declinedList = Array.isArray(declined)
    ? declined.filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
    : [];
  if (declinedList.length > 0) {
    return {
      ads_capable: false,
      capability_warning: buildMetaOAuthDeclinedPermissionsMessage(declinedList),
    };
  }

  const healthError =
    (typeof account?.config?.meta_oauth_health_error === 'string' && account.config.meta_oauth_health_error) ||
    (typeof account?.config?.meta_page_health_error === 'string' && account.config.meta_page_health_error);
  if (healthError) {
    return { ads_capable: false, capability_warning: buildMetaOAuthHealthUnknownMessage(healthError) };
  }

  const state = getMetaAdsScopeState(account?.config);
  if (state === 'missing') {
    const message =
      account?.config?.ads_scope_tier === 'asset'
        ? META_ADS_ASSET_ACCESS_MESSAGE
        : META_ADS_RECONSENT_MESSAGE;
    return { ads_capable: false, capability_warning: message };
  }

  // A confirmed absence of any accessible Page is its own, independently fatal
  // blocker — checked even when the OAuth ads scope is granted (or unproven),
  // because Page access is a second Meta grant that scopes say nothing about.
  // This is the exact gap ENG-2232 reported: ads_capable:true with 0 Pages.
  //
  // ENG-2822: Page access gates CREATE only. Reads (campaign lists, insights)
  // work without it, so ads_capable keeps reflecting the ads scope and the
  // missing Page is reported as can_create_ads:false plus the warning.
  if (getMetaPagesAccessState(account?.config) === 'missing') {
    return {
      // Unknown ads scope stays fail-closed (pre-ENG-2822 reading): without a
      // confirmed grant there is no evidence that reads work either.
      ads_capable: state === 'granted',
      can_create_ads: false,
      capability_warning: getMetaAdsNoPagesMessage(account?.config),
    };
  }

  if (state === 'granted') return { ads_capable: true };
  return {};
};

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
