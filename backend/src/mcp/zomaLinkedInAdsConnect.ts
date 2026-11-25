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

/** A usable email address, trimmed; null when there is none. */
const plainEmail = (email: unknown): string | null =>
  (typeof email === 'string' && /^[^@\s]+@[^@\s]+$/.test(email.trim()) ? email.trim() : null);

export interface ZomaLinkedInAdsDeps {
  links: ZomaLinkCodec;
  /** Verifies a LinkedIn OAuth state (signature AND expiry); null when invalid/expired/tampered. */
  verifyState: (state: unknown) => { userId?: unknown; zoma?: unknown } | null;
  finalize: (userId: string, code: string) => Promise<LinkedInAdsFinalizeResult>;
  connect: (userId: string, tokenSessionId: string, accounts: LinkedInAdsAccountChoice[]) => Promise<LinkedInAdsConnectResult>;
  mintLink: (userId: string) => Promise<string>;
  /** The Zoma login's email, to show whose account is being connected; undefined when unknown. */
  getUserEmail?: (userId: string) => Promise<string | undefined>;
  /** ZOMA_LINKEDIN_ADS_ENABLED is "read" or "true"; defaults to linkedInAdsToolkitEnabled(). Off: these pages are not offered. */
  enabled?: () => boolean;
}

/** The scopes Zoma asks for now for this user (the same call the connect link uses): the mode's plus those already stored. */
const currentScopes = async (userId: string) => (await import('../services/linkedInAdsConnectUrl')).zomaLinkedInConsentScopes(userId, linkedInAdsWritesEnabled());

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
  // Stores the scopes LinkedIn actually granted (else the requested set), and never replaces a stored connection with a narrower one.
  finalize: async (userId, code) =>
    (await import('../services/linkedInAdsOAuthFinalize')).finalizeLinkedInAdsOAuth({ userId, code, scopes: await currentScopes(userId), recordGrantedScopes: true }),
  connect: async (userId, tokenSessionId, accounts) =>
    (await import('../services/linkedInAdsOAuthFinalize')).connectLinkedInAdsAccounts({ userId, tokenSessionId, accounts, keepWiderExisting: true }),
  mintLink: async (userId) => {
    const { buildLinkedInAdsConnectUrl } = await import('../services/linkedInAdsConnectUrl');
    return buildLinkedInAdsConnectUrl(userId, { zoma: ZOMA_MCP_SETUP }, await currentScopes(userId));
  },
  getUserEmail: async (userId) => {
    const user = await (await import('../services/db')).userDb.getUserById(userId);
    return typeof user?.email === 'string' ? user.email : undefined;
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

const connectedPage = (savedCount: number, keptCount = 0, replacedCount = 0): PageStep => {
  const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
  const parts: string[] = [];
  const fresh = savedCount - replacedCount;
  if (fresh > 0) parts.push(`Your LinkedIn Ads ${plural(fresh, 'account is', 'accounts are')} connected to Zoma.`);
  if (replacedCount > 0) {
    parts.push(
      `The earlier connection for ${replacedCount} ${plural(replacedCount, 'account', 'accounts')} had expired or been revoked and could not be used, so this new connection replaced it. `
      + 'It may hold fewer permissions than the earlier one (for example organization posting); to get those back, connect again and approve every permission LinkedIn asks for.',
    );
  }
  if (keptCount > 0) {
    parts.push(`${keptCount} ${plural(keptCount, 'account was', 'accounts were')} already connected with wider access that still works, so ${plural(keptCount, 'it was', 'they were')} left exactly as ${plural(keptCount, 'it was', 'they were')}.`);
  }
  return { kind: 'page', status: 200, title: 'LinkedIn Ads connected', message: `${parts.join(' ')} ${NOTHING_CHANGED} ${ZOMA_BACK_TO_AGENT}`, done: true };
};

/**
 * The FULL email of the Zoma account the link connects, shown on the confirm page so a link someone else sent cannot
 * look right to the person who opens it (a masked address matches every account that starts with the same letter at
 * the same domain). The link is already a secret bearer link, so showing the address to its holder discloses nothing
 * new. null when the account has no usable email or it cannot be read: the page then does not proceed.
 */
async function accountEmail(userId: string, deps: ZomaLinkedInAdsDeps): Promise<string | null> {
  try {
    return plainEmail(await deps.getUserEmail?.(userId));
  } catch {
    return null;
  }
}

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

  // Whose account this connects must be nameable on the confirm page. Without an email it cannot be, so do not proceed
  // (and do not exchange the OAuth code): the generic invalid-link page.
  const email = await accountEmail(userId, deps);
  if (!email) {
    logZomaSetup({ userId, step: 'linkedin_callback', outcome: 'rejected', reason: 'no_account_email' });
    return EXPIRED;
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

  if (result.listFailed) {
    // Nothing could be read from LinkedIn: that is not "no ad account", so no create-an-account steps.
    const denied = result.listStatus === 401 || result.listStatus === 403;
    logZomaSetup({ userId, step: 'linkedin_callback', outcome: 'failed', reason: denied ? `ad_account_list_denied_${result.listStatus}` : 'ad_account_list_failed' });
    return failedPage(userId, deps, denied
      ? {
        status: 403,
        title: 'LinkedIn Ads not connected',
        message: 'LinkedIn would not share your ad accounts with Zoma, which usually means the access Zoma asked for was not approved. Nothing was connected. Connect again and approve every permission LinkedIn asks for.',
      }
      : {
        status: 502,
        title: 'LinkedIn Ads not connected',
        message: 'We could not read your LinkedIn ad accounts from LinkedIn just now, so nothing was connected. This is usually temporary. Please try again.',
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

  // Never connect on arrival, not even for a single account. The link is a bearer link: someone could send theirs
  // to a LinkedIn user so that the victim's ad accounts land on the sender's Zoma account. So the page always names
  // the Zoma account being connected and waits for an explicit Connect.
  const token = deps.links.sign(
    { purpose: 'pick_linkedin_account', zoma: ZOMA_MCP_SETUP, uid: userId, tokenSessionId: result.tokenSessionId, linkedinAccounts: accounts },
    600, // the parked token session lives 10 minutes
  );
  return picker(token, accounts, `the Zoma account ${email}`);
}

function pickMessage(who: string, extra?: string): string {
  return `${extra ? `${extra} ` : ''}Connect your LinkedIn ad account(s) to ${who}? Only continue if that is your Zoma account: a link like this can be sent to you by someone else. Connecting only reads your accounts; nothing is created or changed in LinkedIn.`;
}

function picker(token: string, accounts: Array<{ account_id: string; name: string; currency: string }>, who: string, extra?: string): BrowserStep {
  return {
    kind: 'pick_account',
    action: ZOMA_LINKEDIN_SELECT_PATH,
    token,
    accounts: accounts.map((a) => ({ account_id: a.account_id, name: a.name, currency: a.currency })),
    message: pickMessage(who, extra),
    submitLabel: 'Connect',
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
  logZomaSetup({ userId, step: 'linkedin_connect', outcome: 'ok', reason: `${result.accounts.length}_ad_accounts${result.kept.length ? `_${result.kept.length}_kept` : ''}${result.replaced.length ? `_${result.replaced.length}_replaced_dead` : ''}` });
  return connectedPage(result.accounts.length, result.kept.length, result.replaced.length);
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
  if (chosen.length === 0) {
    const email = await accountEmail(claims.uid, deps);
    if (!email) return { ...EXPIRED, message: `This page has expired. ${ZOMA_BACK_TO_AGENT}` };
    return picker(params.t as string, claims.linkedinAccounts, `the Zoma account ${email}`, 'Choose at least one LinkedIn ad account.');
  }
  return connectAccounts(claims.uid, claims.tokenSessionId, chosen, deps);
}
