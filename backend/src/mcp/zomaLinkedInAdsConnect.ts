/**
 * LinkedIn Ads connect for a Zoma (MCP) user, finished on Zoma's own pages (copied from
 * zomaGoogleConnect.ts).
 *
 * The connect link from zoma_status carries `zoma: ZOMA_MCP_SETUP` in its signed OAuth state, so
 * /api/oauth/linkedin-ads/callback forwards here instead of the AgentWeb (Emma) portal. The state's
 * user is finalized server-side (never the browser's portal session), the account picker is a Zoma
 * page, and every end state points back to the agent.
 *
 * Two independent checks bind the user: the LinkedIn callback only forwards a state whose signature
 * verified, and this handler verifies the signature AND the expiry again and takes the userId only from
 * that verified payload. A missing, tampered or expired state gets the generic "invalid or expired
 * link" page; nothing is ever read from an unsigned query parameter.
 *
 * The signed state is a bearer link (15 minutes, not bound to a browser), like the Meta and Google
 * connect links: whoever completes consent with it connects THEIR LinkedIn account to that user. It is
 * minted only for the user's own agent.
 *
 * Connecting is read-only toward LinkedIn: it lists ad accounts and stores a connected_accounts row,
 * stored exactly like the portal's linkedin_ads accounts (same config fields). It creates no
 * campaign, creative or account and spends nothing. Consent asks only for the scopes of the current
 * mode (services/linkedInAdsConnectUrl.ts).
 */
import jwt from 'jsonwebtoken';
import { getJwtSecret } from '../config/jwt';
import { defaultZomaLinkCodec, ZOMA_LINKEDIN_SELECT_PATH, ZOMA_MCP_SETUP, type ZomaLinkCodec } from './zomaSetupLinks';
import { ZOMA_BACK_TO_AGENT, type BrowserStep } from './zomaDeviceFlow';
import { logZomaSetup } from './zomaSetupLog';
import { linkedInAdsToolkitEnabled, linkedInAdsWritesEnabled } from './zomaToolDefinitions';
import type { LinkedInAdsAccountChoice, LinkedInAdsConnectResult, LinkedInAdsFinalizeResult } from '../services/linkedInAdsOAuthFinalize';

type PageStep = Extract<BrowserStep, { kind: 'page' }>;

export interface ZomaLinkedInAdsDeps {
  links: ZomaLinkCodec;
  /** Verifies a LinkedIn OAuth state (signature AND expiry); null when invalid/expired/tampered. */
  verifyState: (state: unknown) => { userId?: unknown; zoma?: unknown } | null;
  finalize: (userId: string, code: string) => Promise<LinkedInAdsFinalizeResult>;
  connect: (userId: string, tokenSessionId: string, accounts: LinkedInAdsAccountChoice[]) => Promise<LinkedInAdsConnectResult>;
  mintLink: (userId: string) => Promise<string>;
  /** ZOMA_LINKEDIN_ADS_ENABLED is "read" or "true"; defaults to linkedInAdsToolkitEnabled(). Off: these pages are not offered. */
  enabled?: () => boolean;
}

/** The scopes Zoma asks for now (the same call the connect link uses), as the connection's recorded scopes. */
const currentScopes = async () => (await import('../services/linkedInAdsConnectUrl')).zomaLinkedInScopes(linkedInAdsWritesEnabled());

export const defaultZomaLinkedInAdsDeps: ZomaLinkedInAdsDeps = {
  links: defaultZomaLinkCodec,
  verifyState: (state) => {
    if (typeof state !== 'string' || !state) return null;
    try {
      const claims = jwt.verify(state, getJwtSecret()); // signature and expiry
      return typeof claims === 'object' && claims ? (claims as { userId?: unknown; zoma?: unknown }) : null;
    } catch {
      return null;
    }
  },
  finalize: async (userId, code) =>
    (await import('../services/linkedInAdsOAuthFinalize')).finalizeLinkedInAdsOAuth({ userId, code, scopes: await currentScopes() }),
  connect: async (userId, tokenSessionId, accounts) =>
    (await import('../services/linkedInAdsOAuthFinalize')).connectLinkedInAdsAccounts({ userId, tokenSessionId, accounts }),
  mintLink: async (userId) => {
    const { buildLinkedInAdsConnectUrl } = await import('../services/linkedInAdsConnectUrl');
    return buildLinkedInAdsConnectUrl(userId, { zoma: ZOMA_MCP_SETUP }, await currentScopes());
  },
};

/** LinkedIn off: a Zoma LinkedIn page names nothing LinkedIn-specific and answers like an unknown route. */
const UNAVAILABLE: PageStep = {
  kind: 'page',
  status: 404,
  title: 'Zoma setup',
  message: `This link is not available. ${ZOMA_BACK_TO_AGENT}`,
};

const linkedInOff = (deps: ZomaLinkedInAdsDeps) => !(deps.enabled ?? linkedInAdsToolkitEnabled)();

const EXPIRED: PageStep = {
  kind: 'page',
  status: 400,
  title: 'Zoma setup',
  message: `This LinkedIn Ads connection link is invalid or has expired. ${ZOMA_BACK_TO_AGENT}`,
};

const NOTHING_CHANGED = 'Connecting only reads your accounts — no campaign was created and nothing was spent.';

/** LinkedIn lists ad accounts in several states; only an ACTIVE one can be managed. */
const isConnectable = (account: any) => String(account?.status ?? '').toUpperCase() === 'ACTIVE';

async function retryLink(userId: string, deps: ZomaLinkedInAdsDeps): Promise<string | undefined> {
  try {
    return await deps.mintLink(userId);
  } catch (error) {
    logZomaSetup({ userId, step: 'linkedin_link', outcome: 'error', reason: error });
    return undefined;
  }
}

interface FailedPage {
  status: number;
  title: string;
  message: string;
  steps?: readonly string[];
}

async function failedPage(userId: string, deps: ZomaLinkedInAdsDeps, { status, title, message, steps }: FailedPage): Promise<PageStep> {
  const retryUrl = await retryLink(userId, deps);
  return {
    kind: 'page',
    status,
    title,
    message: retryUrl ? message : `${message} ${ZOMA_BACK_TO_AGENT}`,
    ...(steps ? { steps } : {}),
    ...(retryUrl ? { retryUrl, retryLabel: 'Connect LinkedIn Ads again' } : {}),
  };
}

const connectedPage = (count: number): PageStep => ({
  kind: 'page',
  status: 200,
  title: 'LinkedIn Ads connected',
  message: `Your LinkedIn Ads ${count === 1 ? 'account is' : 'accounts are'} connected to Zoma. ${NOTHING_CHANGED} ${ZOMA_BACK_TO_AGENT}`,
  done: true,
});

/** GET /api/zoma/linkedin/callback — finalized server-side for the signed state's user. */
export async function completeLinkedInAdsConnect(
  params: { code?: unknown; state?: unknown; error?: unknown },
  deps: ZomaLinkedInAdsDeps = defaultZomaLinkedInAdsDeps,
): Promise<BrowserStep> {
  if (linkedInOff(deps)) {
    logZomaSetup({ step: 'linkedin_callback', outcome: 'rejected', reason: 'linkedin_disabled' });
    return UNAVAILABLE;
  }
  const claims = deps.verifyState(params.state);
  if (!claims || claims.zoma !== ZOMA_MCP_SETUP || typeof claims.userId !== 'string' || !claims.userId) {
    logZomaSetup({ step: 'linkedin_callback', outcome: 'rejected', reason: claims ? 'not_a_zoma_state' : 'invalid_state' });
    return EXPIRED;
  }
  const userId = claims.userId;
  if (params.error !== undefined || typeof params.code !== 'string' || !params.code) {
    const reason = typeof params.error === 'string' ? params.error : 'no_code';
    logZomaSetup({ userId, step: 'linkedin_callback', outcome: 'denied', reason });
    return failedPage(userId, deps, {
      status: 400,
      title: 'LinkedIn Ads not connected',
      message: 'LinkedIn Ads was not connected. Zoma needs read access to your LinkedIn ad account to continue.',
    });
  }

  let result: LinkedInAdsFinalizeResult;
  try {
    result = await deps.finalize(userId, params.code);
  } catch (error) {
    logZomaSetup({ userId, step: 'linkedin_callback', outcome: 'failed', reason: error });
    return failedPage(userId, deps, {
      status: 502,
      title: 'LinkedIn Ads not connected',
      message: 'We could not finish connecting LinkedIn Ads. Please try again. (If this page was reloaded after it said "LinkedIn Ads connected", you are already done.)',
    });
  }

  const accounts = result.adAccounts.filter(isConnectable).map((a) => ({
    account_id: String(a.id),
    name: String(a.name ?? a.id),
    currency: String(a.currency ?? ''),
    status: String(a.status ?? 'ACTIVE'),
  }));
  if (accounts.length === 0) {
    const other = result.adAccounts.length > 0;
    logZomaSetup({ userId, step: 'linkedin_callback', outcome: 'failed', reason: other ? 'no_active_linkedin_ad_accounts' : 'no_linkedin_ad_accounts' });
    return failedPage(userId, deps, {
      status: 400,
      title: other ? 'No active LinkedIn ad account' : 'No LinkedIn ad account found',
      message: other
        ? 'LinkedIn shared ad accounts on this login, but none is active, so there is nothing to connect. Zoma did not create or change anything.'
        : 'LinkedIn did not share any ad accounts. If you already have one, connect again and sign in with the LinkedIn account that can manage it. If you do not have one yet, create it yourself first in LinkedIn Campaign Manager, then connect again.',
      steps: other ? undefined : ['Open https://www.linkedin.com/campaignmanager signed in with the LinkedIn account you want to manage ads with, and create an ad account there. Zoma never creates it for you.'],
    });
  }
  logZomaSetup({ userId, step: 'linkedin_callback', outcome: 'ok', reason: `${accounts.length}_ad_accounts` });
  if (accounts.length === 1) return connectAccounts(userId, result.tokenSessionId, accounts, deps);

  const token = deps.links.sign(
    { purpose: 'pick_linkedin_account', zoma: ZOMA_MCP_SETUP, uid: userId, tokenSessionId: result.tokenSessionId, linkedinAccounts: accounts },
    600, // the parked token session lives 10 minutes
  );
  return picker(token, accounts);
}

const PICK_MESSAGE = 'Pick the LinkedIn ad account(s) Zoma should manage. Choosing one only connects it — nothing is created or changed in it.';

function picker(token: string, accounts: Array<{ account_id: string; name: string; currency: string }>, message = PICK_MESSAGE): BrowserStep {
  return {
    kind: 'pick_account',
    action: ZOMA_LINKEDIN_SELECT_PATH,
    token,
    accounts: accounts.map((a) => ({ account_id: a.account_id, name: a.name, currency: a.currency })),
    message,
  };
}

async function connectAccounts(
  userId: string,
  tokenSessionId: string,
  accounts: Array<{ account_id: string; name: string; currency: string; status: string }>,
  deps: ZomaLinkedInAdsDeps,
): Promise<BrowserStep> {
  let result: LinkedInAdsConnectResult;
  try {
    result = await deps.connect(userId, tokenSessionId, accounts.map((a) => ({ adAccountId: a.account_id, adAccountName: a.name, currency: a.currency, status: a.status })));
  } catch (error) {
    logZomaSetup({ userId, step: 'linkedin_connect', outcome: 'failed', reason: error });
    return failedPage(userId, deps, { status: 502, title: 'LinkedIn Ads not connected', message: 'We could not save your LinkedIn Ads account.' });
  }
  if (!result.ok) {
    logZomaSetup({ userId, step: 'linkedin_connect', outcome: 'rejected', reason: result.reason });
    return failedPage(userId, deps, { status: 400, title: 'LinkedIn Ads not connected', message: 'This connection expired before it finished. (If it already said "LinkedIn Ads connected", you are already done.)' });
  }
  logZomaSetup({ userId, step: 'linkedin_connect', outcome: 'ok', reason: `${result.accounts.length}_ad_accounts` });
  return connectedPage(result.accounts.length);
}

/** POST /api/zoma/linkedin/select — only accounts LinkedIn offered (carried in the signed picker link) can be chosen. */
export async function selectLinkedInAdsAccounts(
  params: { t?: unknown; account_id?: unknown },
  deps: ZomaLinkedInAdsDeps = defaultZomaLinkedInAdsDeps,
): Promise<BrowserStep> {
  if (linkedInOff(deps)) {
    logZomaSetup({ step: 'linkedin_connect', outcome: 'rejected', reason: 'linkedin_disabled' });
    return UNAVAILABLE;
  }
  const claims = deps.links.verify(params.t, 'pick_linkedin_account');
  if (!claims || claims.zoma !== ZOMA_MCP_SETUP || !claims.uid || !claims.tokenSessionId || !Array.isArray(claims.linkedinAccounts)) {
    logZomaSetup({ step: 'linkedin_connect', outcome: 'rejected', reason: 'invalid_picker_link' });
    return { ...EXPIRED, message: `This page has expired. ${ZOMA_BACK_TO_AGENT}` };
  }
  const wanted = new Set((Array.isArray(params.account_id) ? params.account_id : [params.account_id]).filter((v): v is string => typeof v === 'string'));
  const chosen = claims.linkedinAccounts.filter((a) => wanted.has(a.account_id));
  if (chosen.length === 0) return picker(params.t as string, claims.linkedinAccounts, 'Choose at least one LinkedIn ad account.');
  return connectAccounts(claims.uid, claims.tokenSessionId, chosen, deps);
}
