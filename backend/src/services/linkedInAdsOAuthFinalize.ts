/**
 * LinkedIn Ads OAuth finalize + connect, shared by the customer-portal routes
 * (routes/linkedInAdsAuth.ts) and Zoma's server-rendered connect pages (mcp/zomaLinkedInAdsConnect.ts).
 * Extracted unchanged from the route: the portal behaves exactly as before.
 *
 * Everything here is READ-ONLY toward LinkedIn: it exchanges the code, lists the member's ad accounts,
 * and saves a connected_accounts row. It never creates a campaign, creative or account.
 *
 * KNOWN LIMITATION (not redesigned here): the pending token sessions are an in-memory Map with a 10
 * minute TTL, one process. A finalize on one backend instance followed by a connect that lands on
 * another instance (or after a restart) finds no session and the user must connect again. Same as the
 * portal flow had before the extraction.
 */
import axios from 'axios';
import crypto from 'crypto';
import { getLinkedInAdsConfig } from '../config/integrations';
import { createAccount } from './connectedAccountsDb';
import { listAdAccounts } from './linkedInAdsService';

const TOKEN_SESSION_TTL_MS = 10 * 60 * 1000; // 10 minutes
const SESSION_CLEANUP_INTERVAL_MS = 60 * 1000; // 1 minute

/**
 * ENG-1644 gap-closing: linkedin_ads was a live platform with zero auto-resolve wiring — a
 * customer_credential decision for a LinkedIn Ads reconnect could never resolve on its own, no matter
 * what the customer did. Same pattern as metaAuth.ts/linkedinAuth.ts's identical helper:
 * safeAutoResolveCredentialDecision itself never throws, but the import statement can — own try/catch
 * so that can't abort the response. The wrapper's own logic lives once in approvalInboxCustomerNotify.ts.
 */
async function safeAutoResolve(label: string, userId: string, platform: string, accountId: string): Promise<void> {
  try {
    const { safeAutoResolveCredentialDecision } = await import('./approvalInboxCustomerNotify');
    await safeAutoResolveCredentialDecision(label, userId, platform, accountId);
  } catch (err: any) {
    console.warn(`[${label}] auto-resolve module failed to load:`, err?.message || err);
  }
}

interface TokenSession {
  tokens: {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scopes: string[];
    personUrn?: string;
  };
  userId: string;
  expires: number;
  adAccountRefs: { [accountId: string]: string }; // accountId → organization URN (reference field)
}

const tokenSessions = new Map<string, TokenSession>();

setInterval(() => {
  const now = Date.now();
  for (const [id, session] of tokenSessions.entries()) {
    if (now > session.expires) tokenSessions.delete(id);
  }
}, SESSION_CLEANUP_INTERVAL_MS).unref();

const storeTokenSession = (
  userId: string,
  tokens: TokenSession['tokens'],
  adAccountRefs: TokenSession['adAccountRefs']
): string => {
  const sessionId = crypto.randomBytes(32).toString('hex');
  tokenSessions.set(sessionId, { tokens, userId, expires: Date.now() + TOKEN_SESSION_TTL_MS, adAccountRefs });
  return sessionId;
};

const retrieveTokenSession = (sessionId: string, userId: string): TokenSession | null => {
  const session = tokenSessions.get(sessionId);
  if (!session || session.userId !== userId || Date.now() > session.expires) {
    tokenSessions.delete(sessionId);
    return null;
  }
  tokenSessions.delete(sessionId); // one-time use
  return session;
};

export interface LinkedInAdsFinalizeResult {
  adAccounts: any[];
  tokenSessionId: string;
}

/**
 * Exchange the OAuth code for tokens and list the user's ad accounts. `scopes` is what the consent
 * asked for (stored with the connection); the portal passes none and keeps the configured list.
 */
export async function finalizeLinkedInAdsOAuth(params: { userId: string; code: string; scopes?: string[] }): Promise<LinkedInAdsFinalizeResult> {
  const { userId, code } = params;
  const config = await getLinkedInAdsConfig();

  // Exchange code for tokens
  const tokenResponse = await axios.post(config.tokenUrl, null, {
    params: {
      grant_type: 'authorization_code',
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
    },
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });

  const { access_token, refresh_token, expires_in } = tokenResponse.data as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };

  // Fetch the authenticated person's LinkedIn member ID (r_basicprofile scope)
  let personUrn: string | undefined;
  try {
    const meResp = await axios.get<{ id?: string }>('https://api.linkedin.com/v2/me', {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    const memberId = meResp.data?.id;
    if (memberId) personUrn = `urn:li:person:${memberId}`;
  } catch (e) {
    console.warn('[LinkedIn Ads OAuth] Could not fetch /v2/me (person URN):', e instanceof Error ? e.message : 'request failed');
  }

  // Fetch the user's ad accounts so they can pick one
  const accountsResult = await listAdAccounts(access_token);
  const adAccounts = (accountsResult.data?.elements || []).map((acc: any) => ({
    ...acc,
    id: String(acc.id), // LinkedIn returns numeric IDs; normalize to string for frontend
  }));

  // Build accountId → organization URN map from the reference field on each ad account
  const adAccountRefs: { [accountId: string]: string } = {};
  for (const acc of adAccounts) {
    if (acc.reference) adAccountRefs[String(acc.id)] = acc.reference;
  }

  // Store tokens server-side, return session ID
  const tokenSessionId = storeTokenSession(userId, {
    access_token,
    refresh_token,
    expires_in,
    scopes: params.scopes ?? config.scopes,
    personUrn,
  }, adAccountRefs);

  return { adAccounts, tokenSessionId };
}

export interface LinkedInAdsAccountChoice {
  adAccountId: string;
  adAccountName?: string;
  currency?: string;
  status?: string;
}

export type LinkedInAdsConnectResult =
  | { ok: true; accounts: any[] }
  | { ok: false; reason: 'invalid_session' };

/**
 * Save the chosen ad account(s) as connected_accounts (platform='linkedin_ads'), consuming the token
 * session once. The portal connects one account per session; Zoma's picker may offer several.
 * A failure saving (createAccount throws) propagates; the session is already consumed.
 */
export async function connectLinkedInAdsAccounts(params: {
  userId: string;
  tokenSessionId: string;
  accounts: LinkedInAdsAccountChoice[];
}): Promise<LinkedInAdsConnectResult> {
  const { userId, tokenSessionId } = params;
  const session = retrieveTokenSession(tokenSessionId, userId);
  if (!session) return { ok: false, reason: 'invalid_session' };

  const { tokens } = session;
  const saved: any[] = [];
  for (const choice of params.accounts) {
    const organizationUrn = session.adAccountRefs?.[String(choice.adAccountId)];
    const account = await createAccount(userId, 'linkedin_ads', {
      account_id: choice.adAccountId,
      account_name: choice.adAccountName || choice.adAccountId,
      config: {
        account_type: 'ad_account',
        currency: choice.currency || 'USD',
        status: choice.status || 'ACTIVE',
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        token_expires_at: Date.now() + tokens.expires_in * 1000,
        scopes: tokens.scopes,
        ...(organizationUrn && { organization_urn: organizationUrn }),
        ...(tokens.personUrn && { person_urn: tokens.personUrn }),
      },
    });
    await safeAutoResolve('LinkedIn Ads Connect', userId, 'linkedin_ads', choice.adAccountId);
    saved.push(account);
  }
  return { ok: true, accounts: saved };
}
