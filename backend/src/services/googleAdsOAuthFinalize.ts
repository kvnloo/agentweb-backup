/**
 * Google Ads OAuth finalize + connect, shared by the customer-portal routes
 * (routes/googleAdsAuth.ts) and Zoma's server-rendered connect pages (ENG-3135).
 *
 * Everything here is READ-ONLY toward Google: it exchanges the code, lists accessible
 * accounts, and saves a connected_accounts row. It never creates a campaign, budget,
 * billing setup or account, and never sets a country/currency/time zone.
 */
import axios from 'axios';
import crypto from 'crypto';
import { getGoogleAdsConfig } from '../config/integrations';
import { createAccount, getAccountsByUserId } from './connectedAccountsDb';
import { zomaMilestone } from './journeyMilestones';
import { googleAdsService } from './googleAdsService';
import type { GoogleAdsAccountNode, GoogleAdLeaf } from './googleAdsService';

const TOKEN_SESSION_TTL_MS = 10 * 60 * 1000;
const SESSION_CLEANUP_INTERVAL_MS = 60 * 1000;

interface TokenSession {
  tokens: { access_token: string; refresh_token?: string; expires_in: number; };
  // Flat list of every connectable leaf across the tree — the trusted source for connect
  // validation (the client only sends customerIds; name/currency/loginCustomerId come from here).
  connectableLeaves: GoogleAdLeaf[];
  userId: string;
  expires: number;
}

const tokenSessions = new Map<string, TokenSession>();

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of tokenSessions.entries()) {
    if (now > s.expires) tokenSessions.delete(id);
  }
}, SESSION_CLEANUP_INTERVAL_MS).unref();

const storeTokenSession = (userId: string, tokens: TokenSession['tokens'], connectableLeaves: GoogleAdLeaf[]): string => {
  const sessionId = crypto.randomBytes(32).toString('hex');
  tokenSessions.set(sessionId, { tokens, connectableLeaves, userId, expires: Date.now() + TOKEN_SESSION_TTL_MS });
  return sessionId;
};

const retrieveTokenSession = (sessionId: string, userId: string): TokenSession | null => {
  const session = tokenSessions.get(sessionId);
  if (!session || session.userId !== userId || Date.now() > session.expires) {
    tokenSessions.delete(sessionId);
    return null;
  }
  tokenSessions.delete(sessionId);
  return session;
};

/** Google issued a token but the adwords scope was not granted. */
export class GoogleAdsInsufficientScopesError extends Error {
  constructor(public readonly grantedScopes: string[]) {
    super('insufficient_scopes');
  }
}

export interface GoogleAdsFinalizeResult {
  accountTree: GoogleAdsAccountNode[];
  connectableLeaves: GoogleAdLeaf[];
  tokenSessionId: string;
  /** Accounts Google lists but reports CUSTOMER_NOT_ENABLED (signup started, not finished, or deactivated). */
  notEnabledCustomerIds: string[];
}

export async function finalizeGoogleAdsOAuth(params: { userId: string; code: string }): Promise<GoogleAdsFinalizeResult> {
  const { userId, code } = params;
  const config = await getGoogleAdsConfig();

  const tokenResponse = await axios.post(
    config.tokenUrl,
    new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
    }).toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );

  const { access_token, refresh_token, expires_in, scope } = tokenResponse.data as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope?: string;
  };

  // Google returns the scopes actually granted. A Google Workspace admin policy
  // (common in regulated orgs) or an unchecked box on the "unverified app" consent
  // screen can drop the sensitive adwords scope while still issuing a token for the
  // userinfo scopes. Without adwords, listAccessibleCustomers fails or returns nothing,
  // so the connection silently ends with 0 accounts. Detect it here and return an
  // actionable error instead — mirrors the google_drive finalize flow.
  const grantedScopes = (scope || '').split(' ').filter(Boolean);
  const hasAdwords = grantedScopes.some(s => s.includes('/auth/adwords'));
  if (!hasAdwords) {
    console.warn('[GoogleAds OAuth /finalize] insufficient_scopes', {
      userId,
      grantedScopes,
      missingScope: 'https://www.googleapis.com/auth/adwords',
    });
    throw new GoogleAdsInsufficientScopesError(grantedScopes);
  }

  const diagnostics: { notEnabledCustomerIds?: string[] } = {};
  const accountTree = await googleAdsService.listAccountHierarchy(access_token, diagnostics);

  // Mark leaves the user has already connected so the modal can disable them.
  const existing = await getAccountsByUserId(userId);
  const connectedIds = new Set(
    existing.filter(a => a.platform === 'google_ads').map(a => a.account_id)
  );
  const markedTree: GoogleAdsAccountNode[] = accountTree.map(node =>
    node.type === 'leaf'
      ? { ...node, alreadyConnected: connectedIds.has(node.customerId) }
      : { ...node, children: node.children.map(c => ({ ...c, alreadyConnected: connectedIds.has(c.customerId) })) }
  );

  const connectableLeaves = googleAdsService.flattenConnectableLeaves(markedTree);
  const tokenSessionId = storeTokenSession(userId, { access_token, refresh_token, expires_in }, connectableLeaves);

  console.log('[GoogleAds OAuth /finalize] success', {
    userId,
    accountCount: connectableLeaves.length,
    notEnabledAccountCount: diagnostics.notEnabledCustomerIds?.length ?? 0,
    grantedScopes,
  });

  return { accountTree: markedTree, connectableLeaves, tokenSessionId, notEnabledCustomerIds: diagnostics.notEnabledCustomerIds ?? [] };
}

export type GoogleAdsConnectResult =
  | { ok: true; connected: number }
  | { ok: false; reason: 'invalid_session' }
  | { ok: false; reason: 'unknown_account'; customerId: string };

/**
 * Save the chosen leaf accounts as connected_accounts (platform='google_ads'). Account metadata
 * (name, currency, login-customer-id) comes from the trusted server-side session, not the caller.
 */
export async function connectGoogleAdsAccounts(params: {
  userId: string;
  tokenSessionId: string;
  customerIds: string[];
}): Promise<GoogleAdsConnectResult> {
  const { userId, tokenSessionId, customerIds } = params;
  const session = retrieveTokenSession(tokenSessionId, userId);
  if (!session) return { ok: false, reason: 'invalid_session' };

  // Resolve every requested id against the session; reject the whole request if any is unknown.
  const selected: GoogleAdLeaf[] = [];
  for (const id of customerIds) {
    const leaf = session.connectableLeaves.find(l => l.customerId === id);
    if (!leaf) return { ok: false, reason: 'unknown_account', customerId: id };
    selected.push(leaf);
  }

  const tokenExpiresAt = Date.now() + session.tokens.expires_in * 1000;
  for (const leaf of selected) {
    await createAccount(userId, 'google_ads', {
      account_id: leaf.customerId,
      account_name: leaf.name || leaf.customerId,
      config: {
        account_type: 'google_ads',
        customer_id: leaf.customerId,
        currency: leaf.currency || 'USD',
        login_customer_id: leaf.loginCustomerId,
        // ENG-1362: recorded at connect time from the discovery query, so nothing
        // downstream has to infer spend risk from the account name.
        test_account: leaf.testAccount === true,
        access_token: session.tokens.access_token,
        refresh_token: session.tokens.refresh_token,
        token_expires_at: tokenExpiresAt,
      },
    });
  }
  // ENG-2906: journey event; zomaStage only moves for users who already use Zoma.
  void zomaMilestone(userId, 'google_connected', { emit: 'always', requireZoma: true, props: { platform: 'google_ads' } });
  return { ok: true, connected: selected.length };
}
