/**
 * ENG-3135 — Google Ads connect for a Zoma (MCP) user, finished on Zoma's own pages.
 *
 * The connect link from zoma_status carries `zoma: ZOMA_MCP_SETUP` in its signed OAuth state, so
 * /api/oauth/google-ads/callback forwards here instead of the AgentWeb (Emma) portal. The state's
 * user is finalized server-side (never the browser's portal session), the account picker is a Zoma
 * page, and every end state points back to the agent.
 *
 * The signed state is a bearer link (15 minutes, not bound to a browser), like the Meta connect link: whoever
 * completes consent with it connects THEIR Google account to that user. It is minted only for the user's own agent.
 *
 * Connecting is read-only toward Google: it lists accounts and stores a connected_accounts row. It
 * creates no campaign, budget, billing setup or account, and sets no country/currency/time zone. A
 * user with no Google Ads account is shown how to create one themselves, without a campaign.
 */
import jwt from 'jsonwebtoken';
import { getJwtSecret } from '../config/jwt';
import { defaultZomaLinkCodec, ZOMA_GOOGLE_SELECT_PATH, ZOMA_MCP_SETUP, type ZomaLinkCodec } from './zomaSetupLinks';
import { ZOMA_GOOGLE_NEW_ACCOUNT_STEPS } from './zomaAdsExperience';
import { ZOMA_BACK_TO_AGENT, type BrowserStep } from './zomaDeviceFlow';
import { logZomaSetup } from './zomaSetupLog';
import { GoogleAdsInsufficientScopesError } from '../services/googleAdsOAuthErrors';
import type { GoogleAdsConnectResult, GoogleAdsFinalizeResult } from '../services/googleAdsOAuthFinalize';

type PageStep = Extract<BrowserStep, { kind: 'page' }>;

export interface ZomaGoogleDeps {
  links: ZomaLinkCodec;
  /** Verifies a Google OAuth state exactly as the portal does; null when invalid/expired. */
  verifyState: (state: unknown) => { userId?: unknown; zoma?: unknown } | null;
  finalize: (userId: string, code: string) => Promise<GoogleAdsFinalizeResult>;
  connect: (userId: string, tokenSessionId: string, customerIds: string[]) => Promise<GoogleAdsConnectResult>;
  mintLink: (userId: string) => Promise<string>;
}

export const defaultZomaGoogleDeps: ZomaGoogleDeps = {
  links: defaultZomaLinkCodec,
  verifyState: (state) => {
    if (typeof state !== 'string' || !state) return null;
    try {
      const claims = jwt.verify(state, getJwtSecret());
      return typeof claims === 'object' && claims ? (claims as { userId?: unknown; zoma?: unknown }) : null;
    } catch {
      return null;
    }
  },
  finalize: async (userId, code) => (await import('../services/googleAdsOAuthFinalize')).finalizeGoogleAdsOAuth({ userId, code }),
  connect: async (userId, tokenSessionId, customerIds) =>
    (await import('../services/googleAdsOAuthFinalize')).connectGoogleAdsAccounts({ userId, tokenSessionId, customerIds }),
  mintLink: async (userId) =>
    (await import('../services/googleAdsConnectUrl')).buildGoogleAdsConnectUrl(userId, { zoma: ZOMA_MCP_SETUP }),
};

const EXPIRED: PageStep = {
  kind: 'page',
  status: 400,
  title: 'Zoma setup',
  message: `This Google Ads connection link is invalid or has expired. ${ZOMA_BACK_TO_AGENT}`,
};

/** Google lists the account but reports it not enabled (signup unfinished, or deactivated). */
const UNFINISHED_ACCOUNT_STEPS: readonly string[] = [
  'Open https://ads.google.com signed in with the same Google account and look at that account first. If its setup is unfinished, finish it there; do not create another account yet.',
  'Check the billing country, currency and time zone Google shows for it. Google does not let anyone change the currency or time zone once the account exists, and Zoma cannot change any of them. If they are wrong, create a new account yourself and choose them yourself.',
  'If Google pushes you to build a campaign, do not: choose "Create an account without a campaign" (if you only see a Smart campaign setup, look for "Switch to Expert Mode" first).',
];

/** A manager (MCC) login with no active client ad account under it. */
const MANAGER_ONLY_STEPS: readonly string[] = [
  'Connect again in a minute in case Google had a temporary problem listing the accounts under your manager.',
  'Or connect again and sign in with the Google account that owns the ad account itself (not only the manager login).',
  'Or, in Google Ads, make sure the client ad account under your manager is active (not cancelled or still being set up). Zoma only connects active ad accounts.',
];

const NOTHING_CHANGED = 'Connecting only reads your accounts — no campaign was created and nothing was spent.';

async function retryLink(userId: string, deps: ZomaGoogleDeps): Promise<string | undefined> {
  try {
    return await deps.mintLink(userId);
  } catch (error) {
    logZomaSetup({ userId, step: 'google_link', outcome: 'error', reason: error });
    return undefined;
  }
}

interface FailedPage {
  status: number;
  title: string;
  message: string;
  steps?: readonly string[];
}

async function failedPage(userId: string, deps: ZomaGoogleDeps, { status, title, message, steps }: FailedPage): Promise<PageStep> {
  const retryUrl = await retryLink(userId, deps);
  return {
    kind: 'page',
    status,
    title,
    message: retryUrl ? message : `${message} ${ZOMA_BACK_TO_AGENT}`,
    ...(steps ? { steps } : {}),
    ...(retryUrl ? { retryUrl, retryLabel: 'Connect Google Ads again' } : {}),
  };
}

const connectedPage = (count: number): PageStep => ({
  kind: 'page',
  status: 200,
  title: 'Google Ads connected',
  message: `Your Google Ads ${count === 1 ? 'account is' : 'accounts are'} connected to Zoma. ${NOTHING_CHANGED} ${ZOMA_BACK_TO_AGENT}`,
  done: true,
});

/** Nothing to connect: say why (unfinished account, manager without clients, or no account), never "create one" when one exists. */
function noConnectableAccountPage(userId: string, result: GoogleAdsFinalizeResult, deps: ZomaGoogleDeps): Promise<PageStep> {
  if (result.notEnabledCustomerIds.length > 0) {
    const ids = result.notEnabledCustomerIds.filter((id) => /^\d+$/.test(id)).join(', ');
    logZomaSetup({ userId, step: 'google_callback', outcome: 'failed', reason: 'google_ads_account_not_enabled' });
    return failedPage(userId, deps, {
      status: 400,
      title: 'Google Ads account not finished',
      message: `Google found a Google Ads account on this login${ids ? ` (${ids})` : ''}, but it is not active — its setup was started and not finished, or it was deactivated. Zoma did not create it and did not change it.`,
      steps: [...UNFINISHED_ACCOUNT_STEPS, 'Then connect Google Ads again.'],
    });
  }
  if (result.accountTree.length > 0) {
    logZomaSetup({ userId, step: 'google_callback', outcome: 'failed', reason: 'manager_without_connectable_accounts' });
    return failedPage(userId, deps, {
      status: 400,
      title: 'No active Google Ads account to connect',
      message: 'Google shared a manager (MCC) account on this login, but Zoma could not find an active ad account under it to connect (this can also be a temporary Google problem). Zoma did not create or change anything.',
      steps: MANAGER_ONLY_STEPS,
    });
  }
  logZomaSetup({ userId, step: 'google_callback', outcome: 'failed', reason: 'no_google_ads_accounts' });
  return failedPage(userId, deps, {
    status: 400,
    title: 'No Google Ads account found',
    message: 'Google did not share any Google Ads accounts. If you already have one, connect again and sign in with the Google account that owns it. If you do not have one yet, create it yourself first (a few minutes), then connect again:',
    steps: ZOMA_GOOGLE_NEW_ACCOUNT_STEPS,
  });
}

/** GET /api/zoma/google/callback — finalized server-side for the signed state's user. */
export async function completeGoogleConnect(
  params: { code?: unknown; state?: unknown; error?: unknown },
  deps: ZomaGoogleDeps = defaultZomaGoogleDeps,
): Promise<BrowserStep> {
  const claims = deps.verifyState(params.state);
  if (!claims || claims.zoma !== ZOMA_MCP_SETUP || typeof claims.userId !== 'string' || !claims.userId) {
    logZomaSetup({ step: 'google_callback', outcome: 'rejected', reason: claims ? 'not_a_zoma_state' : 'invalid_state' });
    return EXPIRED;
  }
  const userId = claims.userId;
  if (params.error !== undefined || typeof params.code !== 'string' || !params.code) {
    const reason = typeof params.error === 'string' ? params.error : 'no_code';
    logZomaSetup({ userId, step: 'google_callback', outcome: 'denied', reason });
    return failedPage(userId, deps, {
      status: 400,
      title: 'Google Ads not connected',
      message: 'Google Ads was not connected. Zoma needs read access to your Google Ads account to continue.',
    });
  }

  let result: GoogleAdsFinalizeResult;
  try {
    result = await deps.finalize(userId, params.code);
  } catch (error) {
    const scopes = error instanceof GoogleAdsInsufficientScopesError;
    logZomaSetup({ userId, step: 'google_callback', outcome: 'failed', reason: scopes ? 'insufficient_scopes' : error });
    return failedPage(userId, deps, {
      status: scopes ? 422 : 502,
      title: 'Google Ads not connected',
      message: scopes
        ? 'Google Ads permission was not granted. Try again and allow all requested permissions (a Google Workspace admin can also restrict third-party apps).'
        : 'We could not finish connecting Google Ads. Please try again. (If this page was reloaded after it said "Google Ads connected", you are already done.)',
    });
  }

  const leaves = result.connectableLeaves;
  if (leaves.length === 0) return noConnectableAccountPage(userId, result, deps);
  logZomaSetup({ userId, step: 'google_callback', outcome: 'ok', reason: `${leaves.length}_ad_accounts` });
  if (leaves.length === 1) return connectAccounts(userId, result.tokenSessionId, [leaves[0].customerId], deps);

  const googleAccounts = leaves.map((l) => ({ customer_id: l.customerId, name: l.name, currency: l.currency }));
  const token = deps.links.sign(
    { purpose: 'pick_google_account', zoma: ZOMA_MCP_SETUP, uid: userId, tokenSessionId: result.tokenSessionId, googleAccounts },
    600, // the parked token session lives 10 minutes
  );
  return picker(token, googleAccounts);
}

const PICK_MESSAGE = 'Pick the Google Ads account(s) Zoma should manage. Choosing one only connects it — nothing is created or changed in it.';

function picker(token: string, accounts: Array<{ customer_id: string; name: string; currency: string }>, message = PICK_MESSAGE): BrowserStep {
  return {
    kind: 'pick_account',
    action: ZOMA_GOOGLE_SELECT_PATH,
    token,
    accounts: accounts.map((a) => ({ account_id: a.customer_id, name: a.name, currency: a.currency })),
    message,
  };
}

async function connectAccounts(userId: string, tokenSessionId: string, customerIds: string[], deps: ZomaGoogleDeps): Promise<BrowserStep> {
  let result: GoogleAdsConnectResult;
  try {
    result = await deps.connect(userId, tokenSessionId, customerIds);
  } catch (error) {
    logZomaSetup({ userId, step: 'google_connect', outcome: 'failed', reason: error });
    return failedPage(userId, deps, { status: 502, title: 'Google Ads not connected', message: 'We could not save your Google Ads account.' });
  }
  if (!result.ok) {
    logZomaSetup({ userId, step: 'google_connect', outcome: 'rejected', reason: result.reason });
    return failedPage(userId, deps, { status: 400, title: 'Google Ads not connected', message: 'This connection expired before it finished. (If it already said "Google Ads connected", you are already done.)' });
  }
  logZomaSetup({ userId, step: 'google_connect', outcome: 'ok', reason: `${result.connected}_ad_accounts` });
  return connectedPage(result.connected);
}

/** POST /api/zoma/google/select — only accounts Google offered (carried in the signed picker link) can be chosen. */
export async function selectGoogleAccounts(
  params: { t?: unknown; account_id?: unknown },
  deps: ZomaGoogleDeps = defaultZomaGoogleDeps,
): Promise<BrowserStep> {
  const claims = deps.links.verify(params.t, 'pick_google_account');
  if (!claims || claims.zoma !== ZOMA_MCP_SETUP || !claims.uid || !claims.tokenSessionId || !Array.isArray(claims.googleAccounts)) {
    logZomaSetup({ step: 'google_connect', outcome: 'rejected', reason: 'invalid_picker_link' });
    return { ...EXPIRED, message: `This page has expired. ${ZOMA_BACK_TO_AGENT}` };
  }
  const wanted = new Set((Array.isArray(params.account_id) ? params.account_id : [params.account_id]).filter((v): v is string => typeof v === 'string'));
  const chosen = claims.googleAccounts.filter((a) => wanted.has(a.customer_id));
  if (chosen.length === 0) return picker(params.t as string, claims.googleAccounts, 'Choose at least one Google Ads account.');
  return connectAccounts(claims.uid, claims.tokenSessionId, chosen.map((a) => a.customer_id), deps);
}
