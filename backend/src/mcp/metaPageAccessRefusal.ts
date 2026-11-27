/**
 * ENG-3129 — Zoma refuses Meta ad / creative CREATE when the connection has no usable Facebook
 * Page, before anything is sent to Meta.
 *
 * The stored Page probe (ENG-2232, `has_meta_pages`) already says when a connection cannot
 * reach a Page; every ad creative needs one, so a CREATE on such an account can only fail at
 * Meta (after the caller has spent a preview + approval on it). The refusal carries the same
 * canonical problem text Emma uses (getMetaAdsNoPagesMessage), the Business Settings step that
 * actually fixes it, and a one-click reconnect link. Reads are never gated (ENG-2822).
 *
 * Pure: no I/O. The caller supplies the account config and an already-minted link.
 */
import { getAccessiblePageIds, getMetaAdsNoPagesMessage, type MetaAdsScopeConfigLike } from '../utils/metaAdsScope';

export const META_BUSINESS_PAGES_SETTINGS_URL = 'https://business.facebook.com/settings/pages';
/** Same URL as zomaOnboarding.META_CREATE_PAGE_URL (kept local to avoid an import cycle). */
export const META_CREATE_PAGE_URL = 'https://www.facebook.com/pages/create';

/** True when the probe found zero Pages and no existing-ads Page is recorded (nothing to grant access on). */
export function metaHasNoPageAtAll(config: MetaAdsScopeConfigLike | null | undefined): boolean {
  if (typeof config?.existing_ads_page_id === 'string' && config.existing_ads_page_id) return false;
  const ids = getAccessiblePageIds(config);
  return (ids !== undefined && ids.length === 0) || config?.meta_page_count === 0;
}

/** The fix steps, numbered. `pageId` names Page X when known; `link` is a fresh Meta connect link. */
export function metaPageAccessFixSteps(opts: { pageId?: string; link?: string; noPage?: boolean } = {}): string[] {
  if (opts.noPage) {
    const connect = opts.link
      ? `Reconnect Meta with this one-click link, logged in as the same Facebook user → ${opts.link}`
      : 'Reconnect Meta: run zoma_status for a one-click reconnect link and open it, logged in as the same Facebook user.';
    return [
      `Create a Facebook Page for the business (skip if you already have one) → ${META_CREATE_PAGE_URL}`,
      connect,
      'When Meta asks which Pages to share, select that Page (or all current and future Pages) and approve every requested permission.',
      'Tell me when it is done and I will re-check.',
    ];
  }
  const page = opts.pageId ? `Facebook Page ${opts.pageId}` : 'the Facebook Page you advertise from';
  const reconnect = opts.link
    ? `Then reconnect Meta with this one-click link, logged in as the same Facebook user → ${opts.link}`
    : 'Then reconnect Meta: run zoma_status for a one-click reconnect link and open it, logged in as the same Facebook user.';
  return [
    `In Meta Business Settings → Pages → ${page} → Assign people, grant this Facebook user "Create ads" (Advertiser) access on ${page} (${META_BUSINESS_PAGES_SETTINGS_URL}). For a Page outside a Business portfolio: Page settings → Page access → Add new, with Ads task access.`,
    reconnect,
    `When Meta opens, choose Edit access and select ${page} on the Pages step, then approve every requested permission.`,
    'Tell me when it is done and I will re-check.',
  ];
}

/** Full refusal text: canonical problem, "nothing sent", then the numbered fix. */
export function metaPageAccessRefusalText(
  config: MetaAdsScopeConfigLike | null | undefined,
  opts: { pageId?: string; link?: string } = {},
): string {
  const noPage = !opts.pageId && metaHasNoPageAtAll(config);
  const existing = typeof config?.existing_ads_page_id === 'string' && config.existing_ads_page_id ? config.existing_ads_page_id : undefined;
  const pageId = opts.pageId || existing;
  // A requested Page overrides the recorded existing-ads Page, so the text names only the Page asked for.
  const problem = opts.pageId && existing && opts.pageId !== existing
    ? `Meta Ads access is incomplete for this connection: Facebook Page ${opts.pageId} isn't one of the Pages this connection can currently access.`
    : getMetaAdsNoPagesMessage(config);
  return [
    problem,
    'Nothing was sent to Meta. Reading campaigns and reports still works.',
    '',
    'To fix it:',
    ...metaPageAccessFixSteps({ pageId, link: opts.link, noPage }).map((step, i) => `${i + 1}. ${step}`),
  ].join('\n');
}
