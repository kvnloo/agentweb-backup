/**
 * ENG-2303 P2 — Zoma onboarding for external MCP agents (Claude Code, Codex, Hermes).
 *
 * `zoma_status` tells the agent what the user still has to do, one step at a time, with a
 * direct link: login is handled by MCP OAuth before any tool runs; then a payment method on
 * file (Stripe-hosted Checkout, mode=setup — saves a card, charges nothing); then a usable
 * Meta ad-account connection (the existing Meta OAuth connect URL).
 *
 * State is DERIVED, never stored: the user row, connected accounts, and the Stripe
 * customer's payment methods. No table, column or index is added (data-plane gate). A
 * Stripe customer created for a user without `stripe_customer_id` carries
 * `metadata.userId` and is found again by search instead of being written to the user row.
 *
 * Reads never depend on this module. Writes (ENG-2303 P3) call `assertZomaWriteReady`.
 */
import { userDb } from '../services/db';
import { stripeService, type UserPaymentMethod } from '../services/stripeService';
import { buildMetaConnectUrl } from '../services/metaConnectUrl';
import { getAccountsByUserIdIncludingOrgShared, type ConnectedAccount } from '../services/connectedAccountsDb';
import { getMcpUserUsage, type McpUserUsage } from '../services/mcpUsageEventsService';
import { getMetaAdsNoPagesMessage, getMetaPagesAccessState } from '../utils/metaAdsScope';
import {
  GOOGLE_ADS_PROVIDER, googleToolkitEnabled, META_PROVIDER, metaConnectionIsUsable,
  ZOMA_PROVIDERS, type ZomaPlatform, type ZomaProvider,
} from './zomaProviders';

import { type ZomaToolName } from './zomaToolDefinitions';

export class ZomaNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZomaNotReadyError';
  }
}

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

export interface ZomaGoogleAdsAccountSummary {
  customer_id: string;
  name?: string;
  currency?: string;
  login_customer_id?: string;
}

export interface ZomaReadiness {
  email?: string;
  payment: { ready: boolean; link?: string; error?: string };
  meta: { ready: boolean; accounts: ZomaMetaAccountSummary[]; link?: string };
  /**
   * ENG-2823/ENG-2973: always present. While the Google Ads provider is disabled
   * (ZOMA_GOOGLE_ADS_ENABLED off) it is `{ available: false, ready: false, accounts: [],
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
  /** Meta writes (unchanged meaning). Google writes are google_ads.writes_enabled. */
  writes_enabled: boolean;
  next_step: string | null;
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
  frontendUrl: () => string;
  now: () => number;
  getUsage: (userId: string, range: { start: string; end: string }) => Promise<McpUserUsage>;
}

const defaultDeps: ZomaOnboardingDeps = {
  getUser: (userId) => userDb.getUserById(userId),
  listAccounts: getAccountsByUserIdIncludingOrgShared,
  findLiveCustomerId: (user, userId) => stripeService.findLiveCustomerIdForUser(user, userId),
  createCustomerForUser: (userId, email) => stripeService.createCustomerForUser(userId, email),
  resolvePaymentMethod: (user, userId) => stripeService.resolveUserPaymentMethod(user, userId),
  createPaymentMethodSetupSession: (p) => stripeService.createPaymentMethodSetupSession(p),
  buildMetaConnectUrl: (userId) => buildMetaConnectUrl(userId, 'marketing'),
  frontendUrl: () => process.env.CUSTOMER_FRONTEND_URL || 'https://app.agentweb.pro',
  now: () => Date.now(),
  getUsage: (userId, range) => getMcpUserUsage(userId, range),
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

/**
 * ENG-3078: the same refusal text the ad write gate returns (emma/impl/adsApis.ts), one per
 * distinct message, for usable Meta accounts whose Page access is confirmed missing.
 */
function metaPageProblem(accounts: ConnectedAccount[]): string | null {
  const messages = accounts
    .filter((a) => getMetaPagesAccessState(a.config as any) === 'missing')
    .map((a) => getMetaAdsNoPagesMessage(a.config as any));
  // ENG-3127: say plainly that reading/reporting still works; only ad creation is blocked.
  return messages.length
    ? `Reading your Meta campaigns and reports works. Creating new ads is blocked until this is fixed:\n${[...new Set(messages)].join('\n')}`
    : null;
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

async function defaultGoogleAdsConnectUrl(userId: string): Promise<string> {
  return (await import('../services/googleAdsConnectUrl')).buildGoogleAdsConnectUrl(userId);
}

/**
 * True when any Stripe customer for this user has a saved payment method, asked live every
 * time (ENG-2571): the user-row `has_payment_method` flag is never cleared when a card or
 * customer is removed, so it cannot make a user ready on its own.
 */
async function hasPaymentMethod(user: any, userId: string, deps: ZomaOnboardingDeps): Promise<boolean> {
  // Card requirement paused (2026-11-10, eng lead). Set ZOMA_REQUIRE_PAYMENT_METHOD=true to re-enable.
  if (process.env.ZOMA_REQUIRE_PAYMENT_METHOD !== 'true') return true;
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
  const base = deps.frontendUrl().replace(/\/+$/, '');
  const session = await deps.createPaymentMethodSetupSession({
    stripeCustomerId: customerId,
    userId,
    successUrl: returnUrls?.successUrl ?? `${base}/settings?zoma=payment_method_added`,
    cancelUrl: returnUrls?.cancelUrl ?? `${base}/settings?zoma=payment_method_canceled`,
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
  const mintLinks = opts.mintLinks !== false;
  const user = await deps.getUser(userId);
  if (!user) throw new ZomaNotReadyError('No AgentWeb account was found for this login.');

  const payment: ZomaReadiness['payment'] = { ready: false };
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
  if (!meta.ready && mintLinks) meta.link = await deps.buildMetaConnectUrl(userId);

  const writes_enabled = payment.ready && meta.ready;
  const readiness: ZomaReadiness = {
    email: user.email, payment, meta, writes_enabled, next_step: null,
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
  readiness.next_step = nextStep(payment, meta, readiness.google_ads) ?? metaPageProblem(accounts);
  return readiness;
}

function nextStep(payment: ZomaReadiness['payment'], meta: ZomaReadiness['meta'], googleAds: ZomaReadiness['google_ads']): string | null {
  const google = googleAds.available ? googleAds : undefined;
  if (!payment.ready) {
    if (payment.error) return payment.error;
    return [
      `Add a payment method → ${payment.link}`,
      'Reads work without one; Zoma needs a payment method on file before it changes anything in an ad account. Nothing is charged by adding it.',
      'Tell me when it is done and I will re-check.',
    ].join('\n');
  }
  if (!meta.ready && !google?.ready) {
    return [
      `Connect Meta (Facebook Business login) and pick your ad account → ${meta.link}`,
      ...(google ? [`Or connect Google Ads → ${google.link ?? 'Settings → Connected accounts'}`] : []),
      'Tell me when it is connected and I will re-check.',
    ].join('\n');
  }
  return null;
}

export function formatZomaStatus(r: ZomaReadiness): string {
  const box = (ok: boolean) => (ok ? '[x]' : '[ ]');
  const lines = [
    'Zoma setup:',
    `  [x] AgentWeb login${r.email ? ` (${r.email})` : ''}`,
    `  ${box(r.payment.ready)} Payment method on file`,
    `  ${box(r.meta.ready)} Meta ad account connected${
      r.meta.accounts.length ? ` (${r.meta.accounts.map((a) => `${a.account_id}${a.currency ? `, ${a.currency}` : ''}`).join('; ')})` : ''
    }${!r.meta.ready && r.google_ads.available && r.google_ads.ready && r.meta.link ? ` → ${r.meta.link}` : ''}`,
    ...(r.google_ads.available
      ? [`  ${box(r.google_ads.ready)} Google Ads account connected${
        r.google_ads.accounts.length
          ? ` (${r.google_ads.accounts.map((a) => `${a.customer_id}${a.currency ? `, ${a.currency}` : ''}`).join('; ')})`
          : r.google_ads.link ? ` → ${r.google_ads.link}` : ''
      }`]
      : []),
    '',
    r.next_step ?? 'All set. Ask me about your Meta ads, e.g. "how are my campaigns doing this week?"',
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

export function formatZomaUsage(u: McpUserUsage): string {
  const lines = [
    `Zoma usage ${u.start.slice(0, 7)} (UTC month):`,
    `  Tool calls: ${u.toolCalls}`,
    `  Writes sent to Meta: ${u.writes.total} (confirmed ${u.writes.confirmed}, mismatch ${u.writes.mismatch}, unconfirmed ${u.writes.unconfirmed})`,
    ...u.recentWrites.map((w) => `  • ${w.ts.slice(0, 16).replace('T', ' ')}  ${w.platform === 'google_ads' ? '[Google Ads] ' : ''}${w.action ?? ''} ${w.entityType ?? ''}${w.objectId ? ` ${w.objectId}` : ''} → ${w.verification ?? 'unknown'}`),
    'Billing is not enabled yet; usage is only recorded.',
  ];
  return lines.join('\n');
}

/** Tool entry point for the toolkit gateway. Returns the text plus the structured state. */
export async function runZomaTool(name: ZomaToolName, _args: unknown, context: { userId: string }, deps: ZomaOnboardingDeps = defaultDeps) {
  if (name === 'zoma_status') {
    const readiness = await getZomaReadiness(context.userId, deps);
    return { summary: formatZomaStatus(readiness), ...readiness };
  }
  if (name === 'zoma_usage') {
    const usage = await deps.getUsage(context.userId, currentUsageMonth(deps.now()));
    return { summary: formatZomaUsage(usage), ...usage };
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
