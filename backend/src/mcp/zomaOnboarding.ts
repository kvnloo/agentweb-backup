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
import { stripeService } from '../services/stripeService';
import { buildMetaConnectUrl } from '../services/metaConnectUrl';
import { getAccountsByUserIdIncludingOrgShared, type ConnectedAccount } from '../services/connectedAccountsDb';
import { isMetaAdAccount } from '../services/metaTokenRefresh';
import { getMcpUserUsage, type McpUserUsage } from '../services/mcpUsageEventsService';

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
}

export interface ZomaReadiness {
  email?: string;
  payment: { ready: boolean; link?: string; error?: string };
  meta: { ready: boolean; accounts: ZomaMetaAccountSummary[]; link?: string };
  writes_enabled: boolean;
  next_step: string | null;
}

export interface ZomaOnboardingDeps {
  getUser: (userId: string) => Promise<any>;
  listAccounts: (userId: string) => Promise<ConnectedAccount[]>;
  findCustomerIdsByUserId: (userId: string) => Promise<string[]>;
  createCustomerForUser: (userId: string, email: string | undefined) => Promise<string>;
  customerHasPaymentMethod: (customerId: string) => Promise<boolean>;
  createPaymentMethodSetupSession: (p: { stripeCustomerId: string; userId: string; successUrl: string; cancelUrl: string }) => Promise<{ url?: string | null }>;
  buildMetaConnectUrl: (userId: string) => Promise<string>;
  frontendUrl: () => string;
  now: () => number;
  getUsage: (userId: string, range: { start: string; end: string }) => Promise<McpUserUsage>;
}

const defaultDeps: ZomaOnboardingDeps = {
  getUser: (userId) => userDb.getUserById(userId),
  listAccounts: getAccountsByUserIdIncludingOrgShared,
  findCustomerIdsByUserId: (userId) => stripeService.findCustomerIdsByUserId(userId),
  createCustomerForUser: (userId, email) => stripeService.createCustomerForUser(userId, email),
  customerHasPaymentMethod: (id) => stripeService.customerHasPaymentMethod(id),
  createPaymentMethodSetupSession: (p) => stripeService.createPaymentMethodSetupSession(p),
  buildMetaConnectUrl: (userId) => buildMetaConnectUrl(userId, 'marketing'),
  frontendUrl: () => process.env.CUSTOMER_FRONTEND_URL || 'https://app.agentweb.pro',
  now: () => Date.now(),
  getUsage: (userId, range) => getMcpUserUsage(userId, range),
};

/** Same usability rule the toolkit gateway applies to account resolution. */
export function metaConnectionIsUsable(account: ConnectedAccount, now: number): boolean {
  const config: any = account.config;
  if (config?.ads_scope_revoked_at) return false;
  const expiresAt = config?.token_expires_at;
  return !(typeof expiresAt === 'number' && expiresAt < now);
}

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
  };
}

async function usableMetaAccounts(userId: string, deps: ZomaOnboardingDeps): Promise<ConnectedAccount[]> {
  const now = deps.now();
  return (await deps.listAccounts(userId)).filter((a) => isMetaAdAccount(a) && metaConnectionIsUsable(a, now));
}

/**
 * True when any Stripe customer for this user has a saved payment method. The user-row
 * flag (set by subscription webhooks) short-circuits; otherwise Stripe is asked live,
 * because a setup-mode checkout deliberately does not touch the user row.
 */
async function hasPaymentMethod(user: any, userId: string, deps: ZomaOnboardingDeps): Promise<boolean> {
  if (user?.has_payment_method === true) return true;
  const ids = new Set<string>();
  if (typeof user?.stripe_customer_id === 'string' && user.stripe_customer_id) ids.add(user.stripe_customer_id);
  for (const id of await deps.findCustomerIdsByUserId(userId)) ids.add(id);
  for (const id of ids) {
    if (await deps.customerHasPaymentMethod(id)) return true;
  }
  return false;
}

async function paymentSetupLink(
  user: any,
  userId: string,
  deps: ZomaOnboardingDeps,
  returnUrls?: { successUrl: string; cancelUrl: string },
): Promise<string> {
  let customerId: string | undefined =
    typeof user?.stripe_customer_id === 'string' && user.stripe_customer_id ? user.stripe_customer_id : undefined;
  if (!customerId) customerId = (await deps.findCustomerIdsByUserId(userId))[0];
  if (!customerId) customerId = await deps.createCustomerForUser(userId, user?.email);
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

  const accounts = await usableMetaAccounts(userId, deps);
  const meta: ZomaReadiness['meta'] = { ready: accounts.length > 0, accounts: accounts.map(summarize) };
  if (!meta.ready && mintLinks) meta.link = await deps.buildMetaConnectUrl(userId);

  const writes_enabled = payment.ready && meta.ready;
  return { email: user.email, payment, meta, writes_enabled, next_step: nextStep(payment, meta) };
}

function nextStep(payment: ZomaReadiness['payment'], meta: ZomaReadiness['meta']): string | null {
  if (!payment.ready) {
    if (payment.error) return payment.error;
    return [
      `Add a payment method → ${payment.link}`,
      'Reads work without one; Zoma needs a payment method on file before it changes anything in an ad account. Nothing is charged by adding it.',
      'Tell me when it is done and I will re-check.',
    ].join('\n');
  }
  if (!meta.ready) {
    return [
      `Connect Meta (Facebook Business login) and pick your ad account → ${meta.link}`,
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
    }`,
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
    ...u.recentWrites.map((w) => `  • ${w.ts.slice(0, 16).replace('T', ' ')}  ${w.action ?? ''} ${w.entityType ?? ''}${w.objectId ? ` ${w.objectId}` : ''} → ${w.verification ?? 'unknown'}`),
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
export async function assertZomaWriteReady(userId: string, deps: ZomaOnboardingDeps = defaultDeps): Promise<void> {
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
  if ((await usableMetaAccounts(userId, deps)).length === 0) {
    throw new ZomaNotReadyError('No usable Meta ad account is connected, so no change was made. Run zoma_status for the connect link.');
  }
}
