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
import { getMetaAdsNoPagesMessage, type MetaAdsScopeConfigLike } from '../utils/metaAdsScope';

export const META_BUSINESS_PAGES_SETTINGS_URL = 'https://business.facebook.com/settings/pages';

/** The fix steps, numbered. `pageId` names Page X when known; `link` is a fresh Meta connect link. */
export function metaPageAccessFixSteps(opts: { pageId?: string; link?: string } = {}): string[] {
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
  const existing = typeof config?.existing_ads_page_id === 'string' && config.existing_ads_page_id ? config.existing_ads_page_id : undefined;
  const pageId = opts.pageId || existing;
  return [
    getMetaAdsNoPagesMessage(config),
    'Nothing was sent to Meta. Reading campaigns and reports still works.',
    '',
    'To fix it:',
    ...metaPageAccessFixSteps({ pageId, link: opts.link }).map((step, i) => `${i + 1}. ${step}`),
  ].join('\n');
}
