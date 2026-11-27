/**
 * ENG-2303 P2 — Zoma onboarding for external MCP agents (Claude Code, Codex, Hermes).
 *
 * `zoma_status` tells the agent what the user still has to do, one step at a time, with a
 * direct link: login is handled by MCP OAuth before any tool runs; then a payment method on
 * file (Stripe-hosted Checkout, mode=setup — saves a card, charges nothing); then a usable
 * Meta ad-account connection (the existing Meta OAuth connect URL).
 *
 * Readiness is DERIVED: the user row, connected accounts, and the Stripe
 * customer's payment methods. ENG-2880 optionally records first-observed activation
 * milestones separately on AW-Users (dark; requires data-plane approval). A
 * Stripe customer created for a user without `stripe_customer_id` carries
 * `metadata.userId` and is found again by search instead of being written to the user row.
 *
 * Reads never depend on this module. Writes (ENG-2303 P3) call `assertZomaWriteReady`.
 *
 * ENG-3134 (Zoma redesign): nothing here sends the user to the AgentWeb (Emma) app. The Meta
 * link finishes on Zoma's own pages (state `zoma: ZOMA_MCP_SETUP`), the card link returns to
 * Zoma's own page, and the first answer is "Hey, welcome to Zoma." plus one question.
 */
import { ActivationStage, emitActivation } from '../services/zomaActivationEvents';
import { userDb } from '../services/db';
import { stripeService, type UserPaymentMethod } from '../services/stripeService';
import { buildMetaConnectUrl } from '../services/metaConnectUrl';
import { getBackendUrl } from './oauth/authChallenge';
import { ZOMA_MCP_SETUP } from './zomaSetupLinks';
import { getAccountsByUserIdIncludingOrgShared, type ConnectedAccount } from '../services/connectedAccountsDb';
import { getMcpUserUsage, type McpUserUsage } from '../services/mcpUsageEventsService';
import { getAccessiblePageIds, getMetaAdsNoPagesMessage, getMetaPagesAccessState } from '../utils/metaAdsScope';
import { META_BUSINESS_PAGES_SETTINGS_URL } from './metaPageAccessRefusal';
import {
  GOOGLE_ADS_PROVIDER, googleToolkitEnabled, LINKEDIN_ADS_PROVIDER, LINKEDIN_READ_SCOPES_NEEDED, linkedInAdsToolkitEnabled, linkedInAdsWritesEnabled,
  linkedInConnectionHolds, LINKEDIN_WRITE_SCOPE_NEEDED, META_PROVIDER, metaConnectionIsUsable, X_ADS_PROVIDER, xAdsToolkitEnabled, ZOMA_PROVIDERS, type ZomaPlatform, type ZomaProvider,
} from './zomaProviders';

import { type ZomaToolName } from './zomaToolDefinitions';
import {
  adsExperienceQuestionText, defaultAdsExperienceStore, newToAdsGuideText, parseZomaAdsExperience,
  ZOMA_ADS_EXPERIENCE_VALUES, ZOMA_META_LOGIN_NOTE, ZOMA_NOT_INTERESTED_MESSAGE, type ZomaAdsExperience,
} from './zomaAdsExperience';
import {
  formatZomaBillingUsage, formatZomaPlanLine, getZomaBillingConfig, getZomaBillingUsage, getZomaPlanSummary,
  type ZomaBillingUsage, type ZomaPlanSummary,
} from './zomaBilling';

import { ZomaNotReadyError } from './zomaErrors';

export { ZomaNotReadyError };

export interface ZomaMetaAccountSummary {
  account_id: string;
  name?: string;
  currency?: string;
  /** D4: only `granted_scopes` (from Meta's debug_token) is authoritative. */
  ads_management: 'granted' | 'missing' | 'unknown';
  /**
   * ENG-3078: present only when the stored Page probe (`has_meta_pages`) says no Facebook
   * Page is accessible. Absent for granted and for never-probed, which must change nothing.
   */
  page_access?: 'missing';
}

/**
 * ENG-3125: why a connected Meta ad account still cannot create ads — no Facebook Page the
 * connection can use. Derived from the stored Page probe (ENG-2232), never from a live call.
 */
export type ZomaMetaPageBlockerReason = 'no_page_exists' | 'page_not_granted' | 'no_advertiser_role';

export const META_CREATE_PAGE_URL = 'https://www.facebook.com/pages/create';
export { META_BUSINESS_PAGES_SETTINGS_URL };

export interface ZomaMetaPageBlocker {
  type: 'meta_page_access';
  reason: ZomaMetaPageBlockerReason;
  /** Ad accounts (without act_) whose Page access is confirmed missing. */
  account_ids: string[];
  /** The Page this account's existing ads run under, when known. */
  page_id?: string;
  /** The canonical refusal text the ad write gate returns (ENG-3078). */
  message: string;
  /** Step-by-step instructions an agent can relay verbatim. */
  steps: string[];
  /** Fresh Meta connect link (auth_type=rerequest, so Meta re-offers Page selection). */
  link?: string;
  create_page_url?: string;
}

export interface ZomaGoogleAdsAccountSummary {
  customer_id: string;
  name?: string;
  currency?: string;
  login_customer_id?: string;
}

export interface ZomaReadiness {
  email?: string;
  /**
   * ENG-3195: `required: false` is present only while no card is asked for at setup
   * (ZOMA_REQUIRE_PAYMENT_METHOD unset). `ready` is then true without any card on file, so the
   * checklist leaves the "Payment method on file" line out instead of ticking it.
   */
  payment: { ready: boolean; required?: false; link?: string; error?: string };
  meta: { ready: boolean; accounts: ZomaMetaAccountSummary[]; link?: string };
  /**
   * ENG-2823/ENG-2973: always present. While the Google Ads provider is disabled
   * (ZOMA_GOOGLE_ENABLED off) it is `{ available: false, ready: false, accounts: [],
   * writes_enabled: false, reason: 'google_ads_provider_disabled' }` so callers can tell
   * "not offered on this deployment" apart from a missing field.
   */
  google_ads: {
    available: boolean;
    ready: boolean;
    accounts: ZomaGoogleAdsAccountSummary[];
    link?: string;
    writes_enabled: boolean;
    reason?: 'google_ads_provider_disabled';
  };
  /**
   * ENG-3142: present only while ZOMA_X_ADS_ENABLED is on (absent otherwise, so X is never
   * advertised before the flip).
   */
  x_ads?: {
    available: true;
    ready: boolean;
    accounts: Array<{ account_id: string; name?: string; currency?: string }>;
    link?: string;
    writes_enabled: boolean;
  };
  /**
   * Present only while ZOMA_LINKEDIN_ADS_ENABLED is "read" or "true" (absent otherwise, so LinkedIn is
   * never advertised before the flip). Read mode: reading and reporting work, `writes_enabled` is false
   * with reason `linkedin_standard_tier_pending` (creating or editing needs LinkedIn Standard-tier
   * approval, and then only works on ad accounts LinkedIn has enabled for the app). Full mode:
   * `writes_enabled` follows the other providers (payment on file and a connected account), plus the
   * write consent (rw_ads); a connection made in read mode needs a reconnect (`linkedin_reconnect_for_changes`).
   */
  linkedin_ads?: {
    available: true;
    ready: boolean;
    accounts: Array<{ account_id: string; name?: string; currency?: string }>;
    link?: string;
    writes_enabled: boolean;
    reason?: 'linkedin_standard_tier_pending' | 'linkedin_reconnect_for_changes';
  };
  /** Meta writes (unchanged meaning). Google writes are google_ads.writes_enabled. */
  writes_enabled: boolean;
  /**
   * ENG-3128: answer to "How familiar are you with ads?" (null until answered). It is asked
   * before any other step; `not_interested` ends setup with a thank-you and no further steps.
   */
  ads_experience: ZomaAdsExperience | null;
  /**
   * ENG-3125: Meta is connected but ads will fail for lack of a usable Facebook Page. While
   * set, setup is not complete: zoma_status never says "All set" and the device flow never
   * issues its token or shows "You're set".
   */
  blocker: ZomaMetaPageBlocker | null;
  /**
   * ENG-3131: present only while ZOMA_BILLING_ENABLED=true. Reads and drafts never need it;
   * a write that makes ads live needs `publish_enabled`. `link` is the $1 trial Checkout.
   */
  plan?: ZomaPlanSummary;
  next_step: string | null;
  /** ENG-3134: Zoma's guide. */
  docs_url?: string;
}

export interface ZomaOnboardingDeps {
  getUser: (userId: string) => Promise<any>;
  listAccounts: (userId: string) => Promise<ConnectedAccount[]>;
  findLiveCustomerId: (user: any, userId: string) => Promise<string | null>;
  createCustomerForUser: (userId: string, email: string | undefined) => Promise<string>;
  resolvePaymentMethod: (user: any, userId: string) => Promise<UserPaymentMethod>;
  createPaymentMethodSetupSession: (p: { stripeCustomerId: string; userId: string; successUrl: string; cancelUrl: string }) => Promise<{ url?: string | null }>;
  buildMetaConnectUrl: (userId: string) => Promise<string>;
  /** ENG-2823: Google Ads connect link; defaults to the same URL GET /api/oauth/google-ads/init returns. */
  buildGoogleAdsConnectUrl?: (userId: string) => Promise<string>;
  /** ENG-2823: defaults to googleToolkitEnabled(). */
  googleEnabled?: () => boolean;
  /** ENG-3142: defaults to xAdsToolkitEnabled(). */
  xAdsEnabled?: () => boolean;
  /** ENG-3142: signed X Ads connect link (routes/xAdsAuth.ts /start). */
  buildXAdsConnectUrl?: (userId: string) => Promise<string>;
  /** LinkedIn Ads is on for Zoma (read or full); defaults to linkedInAdsToolkitEnabled(). */
  linkedInAdsEnabled?: () => boolean;
  /** LinkedIn Ads writes are on (full mode only); defaults to linkedInAdsWritesEnabled(). */
  linkedInWritesEnabled?: () => boolean;
  /** LinkedIn Ads connect link; defaults to the signed-state consent URL (services/linkedInAdsConnectUrl.ts). */
  buildLinkedInAdsConnectUrl?: (userId: string) => Promise<string>;
  /** ENG-3134: origin of Zoma's own pages (card return, docs) — the API, never the Emma app. */
  pagesUrl: () => string;
  now: () => number;
  getUsage: (userId: string, range: { start: string; end: string }) => Promise<McpUserUsage>;
  /** ENG-3128: persist the ads-experience answer on the user row. */
  saveAdsExperience?: (userId: string, answer: ZomaAdsExperience) => Promise<void>;
  /** ENG-3131 plan section of zoma_status; undefined while billing is off. */
  getPlan?: (userId: string) => Promise<ZomaPlanSummary | undefined>;
  /** ENG-3130 included/used/overage block of zoma_usage; undefined while billing is off. */
  getBillingUsage?: (userId: string) => Promise<ZomaBillingUsage | undefined>;
}

const defaultDeps: ZomaOnboardingDeps = {
  getUser: (userId) => userDb.getUserById(userId),
  listAccounts: getAccountsByUserIdIncludingOrgShared,
  findLiveCustomerId: (user, userId) => stripeService.findLiveCustomerIdForUser(user, userId),
  createCustomerForUser: (userId, email) => stripeService.createCustomerForUser(userId, email),
  resolvePaymentMethod: (user, userId) => stripeService.resolveUserPaymentMethod(user, userId),
  createPaymentMethodSetupSession: (p) => stripeService.createPaymentMethodSetupSession(p),
  // ENG-3134: the callback finishes on Zoma's pages for this user, not in the AgentWeb portal.
  buildMetaConnectUrl: (userId) => buildMetaConnectUrl(userId, 'marketing', { zoma: ZOMA_MCP_SETUP }),
  pagesUrl: getBackendUrl,
  now: () => Date.now(),
  getUsage: (userId, range) => getMcpUserUsage(userId, range),
  saveAdsExperience: (userId, answer) => defaultAdsExperienceStore.save(userId, answer, new Date().toISOString()),
  getPlan: (userId) => getZomaPlanSummary(userId),
  getBillingUsage: (userId) => getZomaBillingUsage(userId),
};

/** Same usability rule the toolkit gateway applies to account resolution (now in zomaProviders). */
export { metaConnectionIsUsable };

export function adsManagementScopeState(account: ConnectedAccount): ZomaMetaAccountSummary['ads_management'] {
  const granted = (account.config as any)?.granted_scopes;
  if (!Array.isArray(granted)) return 'unknown';
  return granted.includes('ads_management') ? 'granted' : 'missing';
}

function summarize(account: ConnectedAccount): ZomaMetaAccountSummary {
  const cfg: any = account.config;
  return {
    account_id: String(cfg?.ad_account_id || account.account_id || '').replace(/^act_/, ''),
    name: (account as any).account_name,
    currency: cfg?.currency,
    ads_management: adsManagementScopeState(account),
    ...(getMetaPagesAccessState(cfg) === 'missing' ? { page_access: 'missing' as const } : {}),
  };
}

const declinedPagePermission = (cfg: any): boolean =>
  Array.isArray(cfg?.declined_required_permissions) &&
  cfg.declined_required_permissions.some((p: unknown) => typeof p === 'string' && p.startsWith('pages_'));

/**
 * ENG-3125: classify a confirmed-missing Page state from what the connect/sweep probe stored.
 *  - existing ads run under a Page this connection cannot reach:
 *      the connection shares no Pages at all  -> page_not_granted (Page skipped on "Choose Pages")
 *      it shares other Pages but not that one -> no_advertiser_role (no "Create ads" access to it)
 *  - a pages_* permission was declined         -> page_not_granted
 *  - zero Pages and no Page of record          -> no_page_exists
 */
export function classifyMetaPageBlocker(cfg: any): ZomaMetaPageBlockerReason {
  const accessible = getAccessiblePageIds(cfg);
  const pageCount = typeof cfg?.meta_page_count === 'number' ? cfg.meta_page_count : accessible?.length;
  const existingPage = typeof cfg?.existing_ads_page_id === 'string' && cfg.existing_ads_page_id ? cfg.existing_ads_page_id : undefined;
  if (existingPage) return (pageCount ?? 0) > 0 ? 'no_advertiser_role' : 'page_not_granted';
  if (declinedPagePermission(cfg)) return 'page_not_granted';
  if (pageCount === 0) return 'no_page_exists';
  return 'page_not_granted';
}

/** ENG-3125: agent-relayable fix steps per reason. `link` is a fresh Meta connect link. */
export function metaPageFixSteps(
  reason: ZomaMetaPageBlockerReason,
  opts: { link?: string; pageId?: string; connectText?: string } = {},
): string[] {
  const connectTail = opts.connectText ?? (opts.link
    ? `open this Meta connect link and log in with the same Facebook account → ${opts.link}`
    : 'ask me for a fresh Meta connect link, open it and log in with the same Facebook account.');
  const connect = connectTail.charAt(0).toUpperCase() + connectTail.slice(1);
  const page = opts.pageId ? `Facebook Page ${opts.pageId}` : 'the Facebook Page you advertise from';
  const done = 'Tell me when it is done and I will re-check.';
  if (reason === 'no_page_exists') {
    return [
      `Create a Facebook Page for the business (skip if you already have one) → ${META_CREATE_PAGE_URL}`,
      connect,
      'When Meta asks which Pages to share, select that Page (or all current and future Pages) and approve every requested permission.',
      done,
    ];
  }
  if (reason === 'page_not_granted') {
    return [
      connect,
      'When Meta opens, choose Edit access (Edit settings) instead of continuing with the previous choices.',
      `On the Pages step select ${page} — or all current and future Pages — then approve every requested permission.`,
      done,
    ];
  }
  return [
    `This Facebook account does not have "Create ads" (Advertiser) access to ${page}.`,
    `Ask whoever manages that Page to open Meta Business Settings → Pages → select the Page → Assign people, and give you the "Create ads" / Ads task (${META_BUSINESS_PAGES_SETTINGS_URL}). For a Page outside a Business portfolio: Page settings → Page access → Add new, with Ads task access.`,
    `Once access is granted, ${connectTail}`,
    `On the Pages step select ${page} and approve every requested permission.`,
    done,
  ];
}

/**
 * ENG-3125 (was ENG-3078's plain message): a structured blocker for usable Meta accounts whose
 * Page access is confirmed missing. Never-probed (unknown) and granted change nothing.
 */
export function metaPageBlocker(accounts: ConnectedAccount[], link?: string): ZomaMetaPageBlocker | null {
  const missing = accounts.filter((a) => getMetaPagesAccessState(a.config as any) === 'missing');
  if (missing.length === 0) return null;
  const cfg: any = missing[0].config;
  const reason = classifyMetaPageBlocker(cfg);
  const pageId = typeof cfg?.existing_ads_page_id === 'string' && cfg.existing_ads_page_id ? cfg.existing_ads_page_id : undefined;
  return {
    type: 'meta_page_access',
    reason,
    account_ids: missing.map((a) => summarize(a).account_id),
    ...(pageId ? { page_id: pageId } : {}),
    message: [...new Set(missing.map((a) => getMetaAdsNoPagesMessage(a.config as any)))].join('\n'),
    steps: metaPageFixSteps(reason, { link, pageId }),
    ...(link ? { link } : {}),
    ...(reason === 'no_page_exists' ? { create_page_url: META_CREATE_PAGE_URL } : {}),
  };
}

/** ENG-3127: the Page step leads with the fact that reads still work; only ad creation is blocked. */
export const META_PAGE_READS_OK = 'Reading your Meta campaigns and reports works. Creating new ads is blocked until this is fixed:';

/** The blocker as zoma_status next_step text: reads-still-work lead, the canonical problem, then numbered steps. */
export function formatMetaPageBlocker(b: ZomaMetaPageBlocker): string {
  return [META_PAGE_READS_OK, b.message, '', 'To fix it:', ...b.steps.map((step, i) => `${i + 1}. ${step}`)].join('\n');
}

function usableAccounts(accounts: ConnectedAccount[], provider: ZomaProvider, now: number): ConnectedAccount[] {
  return accounts.filter((a) => provider.isAdAccount(a) && provider.isUsable(a, now));
}

function summarizeGoogle(account: ConnectedAccount): ZomaGoogleAdsAccountSummary {
  const cfg: any = account.config;
  return {
    customer_id: String(cfg?.customer_id ?? ''),
    name: (account as any).account_name,
    currency: cfg?.currency,
    login_customer_id: cfg?.login_customer_id,
  };
}

async function defaultXAdsConnectUrl(userId: string): Promise<string> {
  return (await import('./zomaXAdsConnect')).buildXAdsConnectLink(userId, getBackendUrl());
}

async function defaultLinkedInAdsConnectUrl(userId: string): Promise<string> {
  // Same pattern as Google: the state carries `zoma`, so the callback finishes on Zoma's pages for this user.
  // Consent asks only for the scopes of the current mode (read: no write scope).
  // The user's existing LinkedIn connections' scopes are asked for too, so a reconnect never narrows one.
  const { buildZomaLinkedInConnectUrl } = await import('../services/linkedInAdsConnectUrl');
  return buildZomaLinkedInConnectUrl(userId, linkedInAdsWritesEnabled(), { zoma: ZOMA_MCP_SETUP });
}

async function defaultGoogleAdsConnectUrl(userId: string): Promise<string> {
  // ENG-3135: state carries `zoma` so the callback finishes on Zoma's pages for this user, not the Emma portal.
  return (await import('../services/googleAdsConnectUrl')).buildGoogleAdsConnectUrl(userId, { zoma: ZOMA_MCP_SETUP });
}

function zomaPaymentMethodRequired(): boolean {
  // Card requirement paused (2026-11-10, eng lead). Set ZOMA_REQUIRE_PAYMENT_METHOD=true to re-enable.
  // ENG-3131: a card is now asked for at the first publish (zomaBilling.ts), so leave this unset: setting
  // it brings back the card wall at signup, which the paid-launch plan rules out.
  return process.env.ZOMA_REQUIRE_PAYMENT_METHOD === 'true';
}

/**
 * True when any Stripe customer for this user has a saved payment method, asked live every
 * time (ENG-2571): the user-row `has_payment_method` flag is never cleared when a card or
 * customer is removed, so it cannot make a user ready on its own. Always true while no card
 * is required (see zomaPaymentMethodRequired).
 */
async function hasPaymentMethod(user: any, userId: string, deps: ZomaOnboardingDeps): Promise<boolean> {
  if (!zomaPaymentMethodRequired()) return true;
  return (await deps.resolvePaymentMethod(user, userId)).hasPaymentMethod;
}

async function paymentSetupLink(
  user: any,
  userId: string,
  deps: ZomaOnboardingDeps,
  returnUrls?: { successUrl: string; cancelUrl: string },
): Promise<string> {
  // Deleted or unknown candidates are skipped (ENG-2571): a just-deleted customer can still
  // come back from the eventually consistent search, and the row id can be stale.
  const customerId = (await deps.findLiveCustomerId(user, userId)) ?? (await deps.createCustomerForUser(userId, user?.email));
  const done = `${deps.pagesUrl().replace(/\/+$/, '')}/api/zoma/done?mcp=1`;
  const session = await deps.createPaymentMethodSetupSession({
    stripeCustomerId: customerId,
    userId,
    successUrl: returnUrls?.successUrl ?? done,
    cancelUrl: returnUrls?.cancelUrl ?? `${done}&canceled=1`,
  });
  if (!session?.url) throw new Error('Stripe did not return a Checkout URL.');
  return session.url;
}

/**
 * ENG-2496: mint the setup-mode Checkout link for a device-flow setup, returning the browser to
 * Zoma's own pages instead of the portal settings page.
 */
export async function createZomaPaymentSetupLink(
  userId: string,
  returnUrls: { successUrl: string; cancelUrl: string },
  deps: ZomaOnboardingDeps = defaultDeps,
): Promise<string> {
  const user = await deps.getUser(userId);
  if (!user) throw new ZomaNotReadyError('No AgentWeb account was found for this login.');
  return paymentSetupLink(user, userId, deps, returnUrls);
}

/**
 * Full readiness with links. Links are only minted for the missing step(s), so a fully
 * set-up user never causes a Stripe customer or session to be created. `mintLinks: false`
 * (ENG-2496 device-flow polling) reads state only, so a 5-second poll never creates a
 * Stripe Checkout session per request.
 */
export async function getZomaReadiness(
  userId: string,
  deps: ZomaOnboardingDeps = defaultDeps,
  opts: { mintLinks?: boolean } = {},
): Promise<ZomaReadiness> {
  const user = await deps.getUser(userId);
  if (!user) throw new ZomaNotReadyError('No AgentWeb account was found for this login.');
  const adsExperience = parseZomaAdsExperience(user.zomaAdsExperience);
  // ENG-3128: no setup links until the question is answered, and none for "just a friend".
  const mintLinks = opts.mintLinks !== false && adsExperience !== null && adsExperience !== 'not_interested';

  const payment: ZomaReadiness['payment'] = zomaPaymentMethodRequired() ? { ready: false } : { ready: false, required: false };
  try {
    payment.ready = await hasPaymentMethod(user, userId, deps);
    if (!payment.ready && mintLinks) payment.link = await paymentSetupLink(user, userId, deps);
  } catch (error) {
    // Fail closed: an unreadable payment state never enables writes.
    payment.ready = false;
    payment.error = 'Could not check the payment method right now. Try zoma_status again shortly.';
    console.error('[zoma] payment check failed:', error instanceof Error ? error.message : error);
  }

  const allAccounts = await deps.listAccounts(userId);
  const accounts = usableAccounts(allAccounts, META_PROVIDER, deps.now());
  const meta: ZomaReadiness['meta'] = { ready: accounts.length > 0, accounts: accounts.map(summarize) };
  if (!meta.ready && mintLinks) {
    try {
      meta.link = await deps.buildMetaConnectUrl(userId);
    } catch (error) {
      console.error('[zoma] meta connect link failed:', error instanceof Error ? error.message : error);
    }
  }

  const writes_enabled = payment.ready && meta.ready;
  let blocker = metaPageBlocker(accounts);
  if (blocker && mintLinks) {
    try {
      blocker = metaPageBlocker(accounts, await deps.buildMetaConnectUrl(userId));
    } catch (error) {
      console.error('[zoma] meta reconnect link failed:', error instanceof Error ? error.message : error);
    }
  }
  const readiness: ZomaReadiness = {
    email: user.email, payment, meta, writes_enabled, ads_experience: adsExperience, blocker, next_step: null,
    google_ads: { available: false, ready: false, accounts: [], writes_enabled: false, reason: 'google_ads_provider_disabled' },
  };

  // ENG-2823: Google Ads is provider #2. Connecting either platform is enough to use Zoma;
  // a missing one is offered with its own connect link but is not a required next step.
  if ((deps.googleEnabled ?? googleToolkitEnabled)()) {
    const google = usableAccounts(allAccounts, GOOGLE_ADS_PROVIDER, deps.now());
    const g: ZomaReadiness['google_ads'] = {
      available: true,
      ready: google.length > 0,
      accounts: google.map(summarizeGoogle),
      writes_enabled: payment.ready && google.length > 0,
    };
    if (!g.ready && mintLinks) {
      try {
        g.link = await (deps.buildGoogleAdsConnectUrl ?? defaultGoogleAdsConnectUrl)(userId);
      } catch (error) {
        console.error('[zoma] google ads connect link failed:', error instanceof Error ? error.message : error);
      }
    }
    readiness.google_ads = g;
  }
  // ENG-3142: X Ads is provider #3, offered only while ZOMA_X_ADS_ENABLED is on.
  if ((deps.xAdsEnabled ?? xAdsToolkitEnabled)()) {
    const xAccounts = usableAccounts(allAccounts, X_ADS_PROVIDER, deps.now());
    const x: NonNullable<ZomaReadiness['x_ads']> = {
      available: true,
      ready: xAccounts.length > 0,
      accounts: xAccounts.map((a) => ({ account_id: String((a.config as any)?.ad_account_id ?? a.account_id), name: a.account_name, currency: (a.config as any)?.currency })),
      writes_enabled: payment.ready && xAccounts.length > 0,
    };
    if (!x.ready && mintLinks) {
      try {
        x.link = await (deps.buildXAdsConnectUrl ?? defaultXAdsConnectUrl)(userId);
      } catch (error) {
        console.error('[zoma] x ads connect link failed:', error instanceof Error ? error.message : error);
      }
    }
    readiness.x_ads = x;
  }
  // LinkedIn Ads is provider #4, offered only while ZOMA_LINKEDIN_ADS_ENABLED is "read" or "true".
  if ((deps.linkedInAdsEnabled ?? linkedInAdsToolkitEnabled)()) {
    const liAccounts = usableAccounts(allAccounts, LINKEDIN_ADS_PROVIDER, deps.now());
    const writesOn = (deps.linkedInWritesEnabled ?? linkedInAdsWritesEnabled)();
    // An existing usable connection that already holds what the mode needs IS the connection: it is reported as
    // ready and no connect link is minted for it. A link is offered only when nothing usable holds the read scopes,
    // or (full mode) when the connection lacks the write consent.
    const readReady = liAccounts.filter((a) => linkedInConnectionHolds(a, LINKEDIN_READ_SCOPES_NEEDED));
    const canChange = liAccounts.some((a) => linkedInConnectionHolds(a, [...LINKEDIN_READ_SCOPES_NEEDED, LINKEDIN_WRITE_SCOPE_NEEDED]));
    const li: NonNullable<ZomaReadiness['linkedin_ads']> = {
      available: true,
      ready: readReady.length > 0,
      accounts: liAccounts.map((a) => ({ account_id: a.account_id, name: a.account_name, currency: (a.config as any)?.currency })),
      writes_enabled: writesOn && payment.ready && canChange,
      ...(!writesOn ? { reason: 'linkedin_standard_tier_pending' as const } : readReady.length > 0 && !canChange ? { reason: 'linkedin_reconnect_for_changes' as const } : {}),
    };
    if (mintLinks && (!li.ready || li.reason === 'linkedin_reconnect_for_changes')) {
      try {
        li.link = await (deps.buildLinkedInAdsConnectUrl ?? defaultLinkedInAdsConnectUrl)(userId);
      } catch (error) {
        console.error('[zoma] linkedin ads connect link failed:', error instanceof Error ? error.message : error);
      }
    }
    readiness.linkedin_ads = li;
  }
  if (mintLinks && deps.getPlan) {
    const plan = await deps.getPlan(userId);
    if (plan) readiness.plan = plan;
  }
  readiness.next_step = nextStep(adsExperience, payment, meta, readiness.google_ads, readiness.x_ads, readiness.linkedin_ads) ?? (blocker ? formatMetaPageBlocker(blocker) : null);
  readiness.docs_url = zomaDocsUrl(deps);
  await emitActivation(userId, ActivationStage.OnboardingStarted);
  if (meta.ready || readiness.google_ads?.ready || readiness.x_ads?.ready) await emitActivation(userId, ActivationStage.AdAccountConnected);
  // Completion is first-write-wins, so require the full setup: the ads question answered and a
  // write-ready provider (Meta only counts once its Page blocker is clear).
  const answered = adsExperience !== null && adsExperience !== 'not_interested';
  if (answered && ((writes_enabled && !blocker) || readiness.google_ads?.writes_enabled || readiness.x_ads?.writes_enabled)) {
    await emitActivation(userId, ActivationStage.OnboardingCompleted);
  }
  return readiness;
}

/** ENG-3134: Zoma's own guide (served by the API, no AgentWeb/Emma app). */
export const zomaDocsUrl = (deps: Pick<ZomaOnboardingDeps, 'pagesUrl'> = defaultDeps) =>
  `${deps.pagesUrl().replace(/\/+$/, '')}/api/meta-toolkit/skill.md`;

/** ENG-3134: the concrete first thing to ask once an ad account is connected. */
export const ZOMA_FIRST_PROMPT =
  'Show my Meta ad spend, impressions, clicks, CTR, CPC, conversions and ROAS by campaign for the last 7 days.';

/** ENG-3134: the "connected" answer — docs plus a concrete next prompt (zoma_ads_report is Meta-only). */
export function zomaAllSetText(docsUrl: string, metaConnected = true, otherLabel = 'Google Ads'): string {
  return [
    'All set. Your ad account is connected to Zoma.',
    `Docs: ${docsUrl}`,
    metaConnected
      ? `Try asking: "${ZOMA_FIRST_PROMPT}" (runs zoma_ads_report).`
      : `Try asking: "How did my ${otherLabel} campaigns do over the last 7 days?"`,
  ].join('\n');
}

/** ENG-3128 order: the ads question, then ad accounts (with setup guidance for new advertisers), then the card. */
function nextStep(
  adsExperience: ZomaAdsExperience | null,
  payment: ZomaReadiness['payment'],
  meta: ZomaReadiness['meta'],
  googleAds: ZomaReadiness['google_ads'],
  xAds?: ZomaReadiness['x_ads'],
  linkedInAds?: ZomaReadiness['linkedin_ads'],
): string | null {
  if (adsExperience === null) return adsExperienceQuestionText('zoma_status { "ads_experience": "<value>" }');
  if (adsExperience === 'not_interested') return ZOMA_NOT_INTERESTED_MESSAGE;
  const google = googleAds.available ? googleAds : undefined;
  if (!meta.ready && !google?.ready && !xAds?.ready && !linkedInAds?.ready) {
    // ENG-3134: the answer leads straight to Meta connect; a new advertiser gets the setup guide
    // after the link (same link once they have an ad account), never instead of it.
    return [
      meta.link
        ? `Connect Meta (Facebook login) and pick your ad account → ${meta.link}`
        : 'Call zoma_status again for a fresh Meta connect link (the link could not be created just now).',
      // ENG-3135: never fall back to the bare ads.google.com — that is Google's campaign signup.
      ...(google
        ? [google.link
          ? `Or connect an existing Google Ads account → ${google.link} (connecting only reads your accounts: it creates no campaign and spends nothing)`
          : 'Or call zoma_status again for a fresh Google Ads connect link (the link could not be created just now).']
        : []),
      ...(xAds
        ? [xAds.link
          ? `Or connect an existing X (Twitter) Ads account → ${xAds.link} (connecting only reads your accounts: it creates no campaign and spends nothing)`
          : 'Or call zoma_status again for a fresh X Ads connect link (the link could not be created just now).']
        : []),
      ...(linkedInAds
        ? [linkedInAds.link
          ? `Or connect an existing LinkedIn Ads account → ${linkedInAds.link} (connecting only reads your accounts: it creates no campaign and spends nothing)`
          : 'Or call zoma_status again for a fresh LinkedIn Ads connect link (the link could not be created just now).']
        : []),
      'Tell me when it is connected and I will re-check.',
      ...(adsExperience === 'new_to_ads' ? ['', newToAdsGuideText()] : [ZOMA_META_LOGIN_NOTE]),
    ].join('\n');
  }
  if (!payment.ready) {
    if (payment.error) return payment.error;
    return [
      `Add a payment method → ${payment.link}`,
      'Reads work without one; Zoma needs a payment method on file before it changes anything in an ad account. Nothing is charged by adding it.',
      'Tell me when it is done and I will re-check.',
    ].join('\n');
  }
  return null;
}

/** Honest about what LinkedIn lets Zoma do: reporting is confirmed for every ad account; changes need LinkedIn's approval per account. */
function linkedInAdsStatusNote(li: NonNullable<ZomaReadiness['linkedin_ads']>): string {
  if (li.reason === 'linkedin_standard_tier_pending') {
    return 'Reading and reporting work. Creating or editing needs LinkedIn Standard-tier approval and only works on accounts LinkedIn has enabled for the app.';
  }
  if (li.reason === 'linkedin_reconnect_for_changes') {
    return `Reading and reporting work. This connection was made without permission to change ads: reconnect LinkedIn Ads${li.link ? ` → ${li.link}` : ''}. Even then, changes only work on accounts LinkedIn has enabled for the app.`;
  }
  return 'Reading and reporting work. Creating or editing only works on ad accounts LinkedIn has enabled for the app; for any other it says so and changes nothing.';
}

export function formatZomaStatus(r: ZomaReadiness): string {
  // ENG-3134: first contact is the welcome and one question — no checklist yet. A friend gets
  // exactly the thank-you, nothing else.
  if (r.ads_experience === null && r.next_step) return r.next_step;
  if (r.ads_experience === 'not_interested') return ZOMA_NOT_INTERESTED_MESSAGE;
  const box = (ok: boolean) => (ok ? '[x]' : '[ ]');
  const lines = [
    'Zoma setup:',
    `  [x] AgentWeb login${r.email ? ` (${r.email})` : ''}`,
    `  ${box(r.ads_experience !== null)} How familiar you are with ads${r.ads_experience ? ` (${r.ads_experience})` : ''}`,
    // ENG-3195: no card is asked for at setup, so there is nothing to claim as on file.
    ...(r.payment.required === false ? [] : [`  ${box(r.payment.ready)} Payment method on file`]),
    `  ${box(r.meta.ready)} Meta ad account connected${
      r.meta.accounts.length ? ` (${r.meta.accounts.map((a) => `${a.account_id}${a.currency ? `, ${a.currency}` : ''}`).join('; ')})` : ''
    }${!r.meta.ready && r.google_ads.available && r.google_ads.ready && r.meta.link ? ` → ${r.meta.link}` : ''}`,
    ...(r.blocker ? ['  [ ] Facebook Page usable for ads'] : []),
    ...(r.google_ads.available
      ? [`  ${box(r.google_ads.ready)} Google Ads account connected${
        r.google_ads.accounts.length
          ? ` (${r.google_ads.accounts.map((a) => `${a.customer_id}${a.currency ? `, ${a.currency}` : ''}`).join('; ')})`
          : r.google_ads.link ? ` → ${r.google_ads.link}` : ''
      }`]
      : []),
    ...(r.x_ads
      ? [`  ${box(r.x_ads.ready)} X Ads account connected${
        r.x_ads.accounts.length
          ? ` (${r.x_ads.accounts.map((a) => `${a.account_id}${a.currency ? `, ${a.currency}` : ''}`).join('; ')})`
          : r.x_ads.link ? ` → ${r.x_ads.link}` : ''
      }`]
      : []),
    ...(r.linkedin_ads
      ? [
        `  ${box(r.linkedin_ads.ready)} LinkedIn Ads account connected${
          r.linkedin_ads.accounts.length
            ? ` (${r.linkedin_ads.accounts.map((a) => `${a.account_id}${a.currency ? `, ${a.currency}` : ''}`).join('; ')})`
            : r.linkedin_ads.link ? ` → ${r.linkedin_ads.link}` : ''
        }`,
        ...(r.linkedin_ads.ready ? [`      ${linkedInAdsStatusNote(r.linkedin_ads)}`] : []),
      ]
      : []),
    ...(r.plan ? [formatZomaPlanLine(r.plan, getZomaBillingConfig())] : []),
    '',
    r.next_step ?? zomaAllSetText(
      r.docs_url ?? zomaDocsUrl(),
      r.meta.ready,
      r.google_ads.ready ? 'Google Ads' : r.x_ads?.ready ? 'X Ads' : r.linkedin_ads?.ready ? 'LinkedIn Ads' : 'Google Ads',
    ),
  ];
  return lines.join('\n');
}

/** Calendar month (UTC) containing `now`, as [start, end) ISO strings. */
export function currentUsageMonth(now: number): { start: string; end: string } {
  const d = new Date(now);
  return {
    start: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString(),
    end: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString(),
  };
}

export function formatZomaUsage(u: McpUserUsage, billing?: ZomaBillingUsage, google: boolean = googleToolkitEnabled()): string {
  const lines = [
    `Zoma usage ${u.start.slice(0, 7)} (UTC month):`,
    `  Tool calls: ${u.toolCalls}`,
    `  Writes sent to Meta: ${u.writes.total} (confirmed ${u.writes.confirmed}, mismatch ${u.writes.mismatch}, unconfirmed ${u.writes.unconfirmed})`,
    // Google writes are listed (and labelled) only while ZOMA_GOOGLE_ENABLED is on.
    ...u.recentWrites.filter((w) => (google || w.platform !== 'google_ads') && (xAdsToolkitEnabled() || w.platform !== 'x_ads') && (linkedInAdsToolkitEnabled() || w.platform !== 'linkedin_ads')).map((w) => `  • ${w.ts.slice(0, 16).replace('T', ' ')}  ${w.platform === 'google_ads' ? '[Google Ads] ' : w.platform === 'x_ads' ? '[X Ads] ' : w.platform === 'linkedin_ads' ? '[LinkedIn Ads] ' : ''}${w.action ?? ''} ${w.entityType ?? ''}${w.objectId ? ` ${w.objectId}` : ''} → ${w.verification ?? 'unknown'}`),
    ...(billing ? formatZomaBillingUsage(billing) : ['Billing is not enabled yet; usage is only recorded.']),
  ];
  return lines.join('\n');
}

/** Tool entry point for the toolkit gateway. Returns the text plus the structured state. */
export async function runZomaTool(name: ZomaToolName, args: unknown, context: { userId: string }, deps: ZomaOnboardingDeps = defaultDeps) {
  if (name === 'zoma_status') {
    // ENG-3128: an agent that asked "How familiar are you with ads?" in chat records the answer here.
    const raw = (args as { ads_experience?: unknown } | null | undefined)?.ads_experience;
    if (raw !== undefined) {
      const answer = parseZomaAdsExperience(raw);
      if (!answer) throw new ZomaNotReadyError(`ads_experience must be one of: ${ZOMA_ADS_EXPERIENCE_VALUES.join(', ')}.`);
      await (deps.saveAdsExperience ?? defaultDeps.saveAdsExperience!)(context.userId, answer);
    }
    const readiness = await getZomaReadiness(context.userId, deps);
    // ENG-3134: a friend's whole answer is the thank-you — no checklist, links or setup state.
    if (readiness.ads_experience === 'not_interested') {
      return { summary: ZOMA_NOT_INTERESTED_MESSAGE, ads_experience: readiness.ads_experience, next_step: null };
    }
    return { summary: formatZomaStatus(readiness), ...readiness };
  }
  if (name === 'zoma_usage') {
    const usage = await deps.getUsage(context.userId, currentUsageMonth(deps.now()));
    const billing = deps.getBillingUsage ? await deps.getBillingUsage(context.userId) : undefined;
    return { summary: formatZomaUsage(usage, billing), ...usage, ...(billing ? { billing } : {}) };
  }
  throw new ZomaNotReadyError(`Unknown Zoma tool ${name}.`);
}

/**
 * Write gate (P3): payment method on file + a usable Meta connection. Throws a
 * ZomaNotReadyError naming the missing step; never mints links (zoma_status does that).
 */
export async function assertZomaWriteReady(
  userId: string,
  deps: ZomaOnboardingDeps = defaultDeps,
  platform: ZomaPlatform = 'meta',
): Promise<void> {
  const user = await deps.getUser(userId);
  if (!user) throw new ZomaNotReadyError('No AgentWeb account was found for this login.');
  let paid = false;
  try {
    paid = await hasPaymentMethod(user, userId, deps);
  } catch (error) {
    console.error('[zoma] payment check failed:', error instanceof Error ? error.message : error);
    throw new ZomaNotReadyError('Could not verify a payment method right now, so no change was made. Try again shortly.');
  }
  if (!paid) {
    throw new ZomaNotReadyError('No payment method on file, so no change was made. Reads still work. Run zoma_status for the link to add one.');
  }
  const provider = ZOMA_PROVIDERS[platform];
  if (usableAccounts(await deps.listAccounts(userId), provider, deps.now()).length === 0) {
    throw new ZomaNotReadyError(`No usable ${provider.accountNoun} is connected, so no change was made. Run zoma_status for the connect link.`);
  }
}
