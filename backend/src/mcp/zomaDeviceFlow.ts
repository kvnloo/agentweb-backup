/**
 * ENG-2496 — agent-driven device-flow onboarding for Zoma (RFC 8628 shape).
 *
 *   1. startSetup         POST /api/zoma/setup          -> device_code + user_code + links
 *   2. beginVerification  GET  /api/zoma/activate       -> existing MCP OAuth consent page
 *      (portal sign-in / sign-up), as first-party client `zoma-device-setup` with PKCE held
 *      server-side; completeVerification on the callback binds the device to the user.
 *   2b. One browser journey (continueInBrowser): after approval the browser goes straight to
 *      Meta connect, Meta's callback finishes SERVER-SIDE for the setup's user
 *      (completeMetaConnect — never the browser's portal session), then straight to Stripe
 *      setup-mode Checkout, whose success_url is Zoma's "you're set" page. Done steps are skipped.
 *   2c. ENG-3128: before Meta, the browser is asked "How familiar are you with ads?"
 *      (answerAdsExperience). ENG-3134: runs_ads and new_to_ads both go straight to Meta connect
 *      -> payment (a new advertiser without an ad account gets the setup guide on the "no ad
 *      account" page); not_interested -> a thank-you page and nothing else (no token).
 *   2d. ENG-3134: an MCP-connected user (OAuth / aw_ key, no device) gets a Meta link whose
 *      state carries `zoma: ZOMA_MCP_SETUP`; it finishes on these same Zoma pages for the state's
 *      user (completeMetaConnect / selectMetaAccounts), never in the AgentWeb (Emma) portal.
 *   3. pollSetup          POST /api/zoma/setup/poll     -> RFC errors until bound, then
 *      next_step from getZomaReadiness (ads_experience | connect_meta | add_payment |
 *      not_interested | fix_meta_page | complete). The poll body may carry `ads_experience` so an agent can
 *      ask the question in chat. On complete
 *      a per-user Zoma token is issued exactly once; only its hash is stored.
 *   4. validateZomaToken  used by the Meta Toolkit gateway for `zoma_` bearers.
 *   5. revokeZomaToken    POST /api/zoma/token/revoke
 *
 * Readiness comes from zomaOnboarding — nothing here re-derives payment or Meta state.
 * Every step is traced (zomaSetupLog: one JSON log line + the device item's `events` list).
 */
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { mcpOAuthService } from './oauth/oauthService';
import { getBackendUrl, META_TOOLKIT_MCP_RESOURCE_PATH } from './oauth/authChallenge';
import {
  createZomaPaymentSetupLink,
  getZomaReadiness,
  metaPageFixSteps,
  type ZomaMetaPageBlocker,
  type ZomaMetaPageBlockerReason,
  type ZomaReadiness,
} from './zomaOnboarding';
import { DynamoZomaDeviceStore, type ZomaDeviceRecord, type ZomaDeviceStore, type ZomaLinkStep } from './zomaDeviceStore';
import { logZomaSetup } from './zomaSetupLog';
import {
  defaultAdsExperienceStore,
  parseZomaAdsExperience,
  zomaAdsExperienceOptions,
  ZOMA_ADS_EXPERIENCE_QUESTION,
  ZOMA_ADS_EXPERIENCE_VALUES,
  ZOMA_META_LOGIN_NOTE,
  zomaNewToAdsSteps,
  ZOMA_NOT_INTERESTED_MESSAGE,
  ZOMA_WELCOME,
  type ZomaAdsExperience,
} from './zomaAdsExperience';
import {
  defaultZomaLinkCodec,
  ZOMA_CONTINUE_PATH,
  ZOMA_MCP_SETUP,
  ZOMA_DONE_PATH,
  ZOMA_META_SELECT_PATH,
  type ZomaLinkClaims,
  type ZomaLinkCodec,
} from './zomaSetupLinks';
import { isEvaluationUser, requireActiveEvaluation } from '../services/evaluationPolicy';
import { getJwtSecret } from '../config/jwt';
import type { MetaFinalizeResult, MetaAdAccountSelection } from '../services/metaOAuthFinalize';
import { MCP_CONSENT_SIGNUP_SOURCE, validateRef, ZOMA_DEVICE_OAUTH_CLIENT_ID } from '../services/journeyAttribution';
import { aliasJourney, anonymousSetupId, trackJourney } from '../services/journeyTracking';
import { noteProductUse, noteSignup, zomaMilestone } from '../services/journeyMilestones';

export const ZOMA_DEVICE_CLIENT_ID = ZOMA_DEVICE_OAUTH_CLIENT_ID;
export const ZOMA_DEVICE_CLIENT_NAME = 'Zoma (agent setup)';
export const ZOMA_TOKEN_PREFIX = 'zoma_';
/** Time to sign in and approve (RFC 8628 expires_in). */
export const ZOMA_DEVICE_EXPIRES_SEC = 900;
/** After approval the same device_code carries the user through Meta + payment. */
export const ZOMA_ONBOARDING_WINDOW_SEC = 3600;
export const ZOMA_POLL_INTERVAL_SEC = 5;
const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ'; // RFC 8628 §6.1: no vowels, no look-alikes
const USER_CODE_LENGTH = 8;

/** ENG-3125: Meta is connected but no Facebook Page is usable for ads — guided fix, no stored link. */
export type ZomaBlockerStep = 'fix_meta_page';
const META_LINK_UNAVAILABLE = 'Could not create the Meta connect link right now; poll again for a fresh one.';
export type ZomaNextStep = 'sign_in' | 'ads_experience' | ZomaLinkStep | ZomaBlockerStep | 'not_interested' | 'complete';
export const ZOMA_ADS_EXPERIENCE_PATH = '/api/zoma/ads-experience';

/**
 * ENG-3134: the Meta connect link zoma_status hands an MCP-connected user. Its callback finishes
 * on Zoma's own pages (completeMetaConnect), not the AgentWeb portal.
 */
export async function buildZomaMcpMetaConnectUrl(userId: string): Promise<string> {
  const { buildMetaConnectUrl } = await import('../services/metaConnectUrl');
  return buildMetaConnectUrl(userId, 'marketing', { zoma: ZOMA_MCP_SETUP });
}

/** ENG-3134: what to say to the agent once a browser step is finished. */
export const ZOMA_BACK_TO_AGENT = 'Go back to your agent and say: "Check my Zoma setup".';

export interface ZomaDeviceFlowDeps {
  store: ZomaDeviceStore;
  now: () => number;
  backendUrl: () => string;
  /** Live state only — never mints links (a 5-second poll must not create Stripe sessions). */
  readiness: (userId: string) => Promise<ZomaReadiness>;
  /** Meta connect URL whose signed state carries `zoma: deviceId` (routes the callback to Zoma). */
  mintMetaLink: (userId: string, deviceId: string) => Promise<string>;
  /** ENG-3134: Meta connect URL for an MCP-connected user (state `zoma: ZOMA_MCP_SETUP`); defaults to buildZomaMcpMetaConnectUrl. */
  mintMcpMetaLink?: (userId: string) => Promise<string>;
  mintPaymentLink: (userId: string, urls: { successUrl: string; cancelUrl: string }) => Promise<string>;
  ensureClient: (redirectUri: string) => Promise<void>;
  consumeAuthCode: (code: string, redirectUri: string, verifier: string) => Promise<{ userId: string } | null>;
  /** Fails closed for a sandbox (evaluation) principal without an active evaluation, like MCP OAuth. */
  principalAllowed: (userId: string) => Promise<boolean>;
  links: ZomaLinkCodec;
  /** Verifies a Meta OAuth state exactly as the portal callback does; null when invalid/expired. */
  verifyMetaState: (state: unknown) => { userId?: unknown; zoma?: unknown } | null;
  finalizeMeta: (userId: string, code: string) => Promise<MetaFinalizeResult>;
  connectAdAccounts: (userId: string, accounts: MetaAdAccountSelection[], tokenSessionId: string) => Promise<void>;
  getCheckoutSession: (sessionId: string) => Promise<{ status?: string | null; userId?: string } | null>;
  /** ENG-3128: persist the "How familiar are you with ads?" answer on the user row. */
  saveAdsExperience: (userId: string, answer: ZomaAdsExperience) => Promise<void>;
}

let defaultStore: ZomaDeviceStore | undefined;
export const defaultZomaDeviceFlowDeps: ZomaDeviceFlowDeps = {
  get store() {
    return (defaultStore ??= new DynamoZomaDeviceStore());
  },
  now: () => Date.now(),
  backendUrl: getBackendUrl,
  readiness: (userId) => getZomaReadiness(userId, undefined, { mintLinks: false }),
  mintMetaLink: async (userId, deviceId) => {
    const { buildMetaConnectUrl } = await import('../services/metaConnectUrl');
    return buildMetaConnectUrl(userId, 'marketing', { zoma: deviceId });
  },
  mintMcpMetaLink: (userId) => buildZomaMcpMetaConnectUrl(userId),
  mintPaymentLink: (userId, urls) => createZomaPaymentSetupLink(userId, urls),
  ensureClient: (redirectUri) => mcpOAuthService.ensureFirstPartyClient(ZOMA_DEVICE_CLIENT_ID, ZOMA_DEVICE_CLIENT_NAME, redirectUri),
  consumeAuthCode: (code, redirectUri, verifier) =>
    mcpOAuthService.consumeAuthorizationCode(code, ZOMA_DEVICE_CLIENT_ID, redirectUri, verifier),
  principalAllowed: async (userId) => {
    if (!isEvaluationUser(userId)) return true;
    try {
      await requireActiveEvaluation(userId);
      return true;
    } catch {
      return false;
    }
  },
  links: defaultZomaLinkCodec,
  verifyMetaState: (state) => {
    if (typeof state !== 'string' || !state) return null;
    try {
      const claims = jwt.verify(state, getJwtSecret());
      return typeof claims === 'object' && claims ? (claims as { userId?: unknown; zoma?: unknown }) : null;
    } catch {
      return null;
    }
  },
  finalizeMeta: async (userId, code) => {
    const { finalizeMetaOAuth } = await import('../services/metaOAuthFinalize');
    return finalizeMetaOAuth({ userId, code, flow: 'marketing' });
  },
  connectAdAccounts: async (userId, adAccounts, tokenSessionId) => {
    const { connectMetaAdAccounts } = await import('../services/metaOAuthFinalize');
    await connectMetaAdAccounts({ userId, adAccounts, tokenSessionId });
  },
  getCheckoutSession: async (sessionId) => {
    const { stripeService } = await import('../services/stripeService');
    const session: any = await stripeService.getCheckoutSession(sessionId);
    return session ? { status: session.status, userId: session.metadata?.userId } : null;
  },
  saveAdsExperience: (userId, answer) => defaultAdsExperienceStore.save(userId, answer, new Date().toISOString()),
};

/**
 * Trace one setup event: a JSON log line plus an entry on the device item's `events` list.
 * Tracing never breaks the flow — a failed persist is itself logged and swallowed.
 */
async function track(
  deps: ZomaDeviceFlowDeps,
  deviceId: string,
  userId: string | undefined,
  step: string,
  outcome: string,
  reason?: unknown,
  opts?: { pollOutcome?: string },
): Promise<void> {
  const event = logZomaSetup({ deviceId, userId, step, outcome, reason });
  try {
    await deps.store.appendEvent(deviceId, event, opts);
  } catch (error) {
    logZomaSetup({ deviceId, userId, step: 'trace_persist', outcome: 'error', reason: error });
  }
}

export const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

export function normalizeUserCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const code = raw.toUpperCase().replace(/[^A-Z]/g, '');
  if (code.length !== USER_CODE_LENGTH || [...code].some((c) => !USER_CODE_ALPHABET.includes(c))) return null;
  return code;
}

function newUserCode(): string {
  let code = '';
  for (let i = 0; i < USER_CODE_LENGTH; i++) code += USER_CODE_ALPHABET[crypto.randomInt(USER_CODE_ALPHABET.length)];
  return code;
}

const displayUserCode = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;
const activateUrl = (deps: ZomaDeviceFlowDeps) => `${deps.backendUrl().replace(/\/+$/, '')}/api/zoma/activate`;
const callbackUrl = (deps: ZomaDeviceFlowDeps) => `${activateUrl(deps)}/callback`;
const backendPath = (deps: ZomaDeviceFlowDeps, path: string) => `${deps.backendUrl().replace(/\/+$/, '')}${path}`;
const mcpUrl = (deps: ZomaDeviceFlowDeps) => `${deps.backendUrl().replace(/\/+$/, '')}${META_TOOLKIT_MCP_RESOURCE_PATH}`;

// ─── 1. Start ─────────────────────────────────────────────────────────────────

export async function startSetup(deps: ZomaDeviceFlowDeps = defaultZomaDeviceFlowDeps, opts: { ref?: unknown } = {}) {
  const now = deps.now();
  const ref = validateRef(opts.ref);
  for (let attempt = 0; attempt < 5; attempt++) {
    const deviceCode = crypto.randomBytes(32).toString('base64url');
    const userCode = newUserCode();
    const deviceId = sha256(deviceCode);
    const created = await deps.store.createDevice({
      deviceId,
      userCode,
      status: 'pending',
      pkceVerifier: crypto.randomBytes(32).toString('base64url'),
      intervalSec: ZOMA_POLL_INTERVAL_SEC,
      expiresAt: now + ZOMA_DEVICE_EXPIRES_SEC * 1000,
      createdAt: new Date(now).toISOString(),
      events: [],
      ...(ref ? { ref } : {}),
    });
    if (!created) continue; // user_code collision
    await track(deps, deviceId, undefined, 'setup_started', 'ok');
    void trackJourney({ anonId: anonymousSetupId(deviceId) }, 'setup_started', { product: 'zoma', path: 'zoma_device', ...(ref ? { ref } : {}) });
    const verificationUri = activateUrl(deps);
    return {
      device_code: deviceCode,
      user_code: displayUserCode(userCode),
      verification_uri: verificationUri,
      verification_uri_complete: `${verificationUri}?user_code=${displayUserCode(userCode)}`,
      interval: ZOMA_POLL_INTERVAL_SEC,
      expires_in: ZOMA_DEVICE_EXPIRES_SEC,
    };
  }
  throw new Error('Could not allocate a Zoma user code.');
}

// ─── 2. Verification (browser) ───────────────────────────────────────────────

export type VerificationStart = { ok: true; redirect: string } | { ok: false; message: string };

export async function beginVerification(rawUserCode: unknown, deps: ZomaDeviceFlowDeps = defaultZomaDeviceFlowDeps): Promise<VerificationStart> {
  const userCode = normalizeUserCode(rawUserCode);
  if (!userCode) {
    logZomaSetup({ step: 'activate_visited', outcome: 'rejected', reason: 'malformed_user_code' });
    return { ok: false, message: 'That code is not valid. Check the code your agent showed you.' };
  }
  const deviceId = await deps.store.getDeviceIdByUserCode(userCode);
  const device = deviceId ? await deps.store.getDevice(deviceId) : null;
  if (!device) {
    logZomaSetup({ step: 'activate_visited', outcome: 'rejected', reason: 'unknown_user_code' });
    return { ok: false, message: 'That code has expired or does not exist. Ask your agent to start Zoma setup again.' };
  }
  if (device.expiresAt <= deps.now()) {
    await track(deps, device.deviceId, device.userId, 'activate_visited', 'rejected', 'expired');
    return { ok: false, message: 'That code has expired or does not exist. Ask your agent to start Zoma setup again.' };
  }
  if (device.status !== 'pending') {
    await track(deps, device.deviceId, device.userId, 'activate_visited', 'rejected', `already_${device.status}`);
    return { ok: false, message: 'That code has already been used.' };
  }
  await track(deps, device.deviceId, undefined, 'activate_visited', 'ok');

  const redirectUri = callbackUrl(deps);
  await deps.ensureClient(redirectUri);
  const authorize = new URL(`${deps.backendUrl().replace(/\/+$/, '')}/oauth/authorize`);
  authorize.searchParams.set('response_type', 'code');
  authorize.searchParams.set('client_id', ZOMA_DEVICE_CLIENT_ID);
  authorize.searchParams.set('redirect_uri', redirectUri);
  authorize.searchParams.set('scope', 'mcp:tools');
  authorize.searchParams.set('state', device.deviceId);
  authorize.searchParams.set('code_challenge', crypto.createHash('sha256').update(device.pkceVerifier).digest('base64url'));
  authorize.searchParams.set('code_challenge_method', 'S256');
  // ENG-2906: RFC 8707 resource names the product; ref rides to the auth code / signup.
  authorize.searchParams.set('resource', mcpUrl(deps));
  if (device.ref) authorize.searchParams.set('ref', device.ref);
  return { ok: true, redirect: authorize.toString() };
}

export async function completeVerification(
  params: { code?: unknown; state?: unknown; error?: unknown },
  deps: ZomaDeviceFlowDeps = defaultZomaDeviceFlowDeps,
): Promise<{ ok: true; deviceId: string } | { ok: false; message: string }> {
  const state = typeof params.state === 'string' ? params.state : '';
  const device = /^[0-9a-f]{64}$/.test(state) ? await deps.store.getDevice(state) : null;
  const now = deps.now();
  if (!device || device.expiresAt <= now || device.status !== 'pending') {
    if (device) await track(deps, device.deviceId, device.userId, 'approval', 'rejected', device.status !== 'pending' ? `already_${device.status}` : 'expired');
    else logZomaSetup({ step: 'approval', outcome: 'rejected', reason: 'unknown_state' });
    return { ok: false, message: 'This setup link has expired or was already used. Ask your agent to start Zoma setup again.' };
  }
  if (params.error !== undefined || typeof params.code !== 'string' || !params.code) {
    await deps.store.resolveDevice(device.deviceId, { status: 'denied' }, now);
    await track(deps, device.deviceId, undefined, 'approval', 'denied', typeof params.error === 'string' ? params.error : 'no_code');
    return { ok: false, message: 'Zoma setup was not approved. You can close this tab.' };
  }
  const grant = await deps.consumeAuthCode(params.code, callbackUrl(deps), device.pkceVerifier);
  if (!grant?.userId) {
    await track(deps, device.deviceId, undefined, 'approval', 'failed', 'auth_code_not_verified');
    return { ok: false, message: 'Sign-in could not be verified. Ask your agent to start Zoma setup again.' };
  }
  const bound = await deps.store.resolveDevice(
    device.deviceId,
    { status: 'approved', userId: grant.userId, expiresAt: now + ZOMA_ONBOARDING_WINDOW_SEC * 1000 },
    now,
  );
  if (!bound) {
    await track(deps, device.deviceId, grant.userId, 'approval', 'failed', 'bind_lost_race');
    return { ok: false, message: 'This setup link has expired or was already used.' };
  }
  await track(deps, device.deviceId, grant.userId, 'approval', 'approved');
  void journeyOnApproval(grant.userId, device);
  return { ok: true, deviceId: device.deviceId };
}

/**
 * ENG-2906: join the anonymous setup to the user, attribute a signup made on the consent page
 * (row stamped signupSource "mcp" — usually already attributed by the consent decision, so this
 * is a no-op backstop), mark Zoma use.
 */
async function journeyOnApproval(userId: string, device: ZomaDeviceRecord): Promise<void> {
  await aliasJourney(userId, anonymousSetupId(device.deviceId));
  await noteSignup(
    userId,
    { product: 'zoma', path: 'zoma_device', client: 'zoma_device', ref: validateRef(device.ref), confidence: 'explicit' },
    { requireSignupSource: MCP_CONSENT_SIGNUP_SOURCE },
  );
  await noteProductUse(userId, 'zoma');
  await zomaMilestone(userId, 'signed_up', { emit: 'never' });
}

// ─── 2b. One browser journey: approval -> Meta -> payment -> done ────────────

export interface ZomaPickerAccount {
  account_id: string;
  name: string;
  currency: string;
}

export type BrowserStep =
  | { kind: 'redirect'; url: string }
  | {
      kind: 'page'; status: number; title: string; message: string; retryUrl?: string; done?: boolean;
      /** ENG-3128: ordered instructions (the new-to-ads setup guide) and a label for the retry link. */
      steps?: readonly string[]; retryLabel?: string;
    }
  | { kind: 'pick_account'; action: string; token: string; accounts: ZomaPickerAccount[]; message?: string; /** Button text; the shared page says "Continue" when absent. */ submitLabel?: string }
  | {
      kind: 'ask_ads_experience'; action: string; token: string; question: string;
      options: ReadonlyArray<{ value: ZomaAdsExperience; label: string }>; message?: string;
    };

type PageStep = Extract<BrowserStep, { kind: 'page' }>;

const EXPIRED_PAGE: PageStep = {
  kind: 'page',
  status: 400,
  title: 'Zoma setup',
  message: 'This setup link has expired or is no longer valid. Ask your agent to start Zoma setup again.',
};
const DONE_PAGE: PageStep = {
  kind: 'page',
  status: 200,
  title: "You're set",
  message: 'Zoma is connected. Return to your agent — it will finish setup on its own.',
  done: true,
};

const THANK_YOU_PAGE: PageStep = {
  kind: 'page',
  status: 200,
  title: 'Thanks for stopping by',
  message: ZOMA_NOT_INTERESTED_MESSAGE,
  done: true,
};

/** A device that may still move through the browser journey for its bound user. */
function journeyDevice(device: ZomaDeviceRecord | null, now: number): (ZomaDeviceRecord & { userId: string }) | null {
  if (!device || !device.userId || device.status !== 'approved' || device.expiresAt <= now) return null;
  return device as ZomaDeviceRecord & { userId: string };
}

function continueLink(deps: ZomaDeviceFlowDeps, deviceId: string): string {
  const token = deps.links.sign({ purpose: 'continue', zoma: deviceId }, ZOMA_ONBOARDING_WINDOW_SEC);
  return `${backendPath(deps, ZOMA_CONTINUE_PATH)}?t=${encodeURIComponent(token)}`;
}

/** One Checkout session per setup, shared by the browser journey and the agent's poll. */
async function paymentLink(deps: ZomaDeviceFlowDeps, device: ZomaDeviceRecord & { userId: string }): Promise<string> {
  const cached = device.links?.add_payment;
  if (cached) return cached;
  const token = encodeURIComponent(deps.links.sign({ purpose: 'continue', zoma: device.deviceId }, ZOMA_ONBOARDING_WINDOW_SEC));
  const done = backendPath(deps, ZOMA_DONE_PATH);
  // {CHECKOUT_SESSION_ID} is substituted by Stripe; it must stay literal (not URL-encoded).
  const link = await deps.mintPaymentLink(device.userId, {
    successUrl: `${done}?t=${token}&session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${done}?t=${token}&canceled=1`,
  });
  await deps.store.saveLink(device.deviceId, 'add_payment', link);
  await track(deps, device.deviceId, device.userId, 'payment_checkout', 'created');
  return link;
}

/**
 * ENG-3125: the fresh Meta connect link that is the whole point of the Page-blocker reply. One
 * retry absorbs a transient Secrets Manager/JWT blip; a persistent failure is traced and returns
 * undefined so the caller states the gap explicitly instead of silently omitting the link.
 */
async function blockerMetaLink(deps: ZomaDeviceFlowDeps, deviceId: string, userId: string): Promise<string | undefined> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await deps.mintMetaLink(userId, deviceId);
    } catch (error) {
      if (attempt >= 2) {
        await track(deps, deviceId, userId, 'meta_link', 'error', error);
        return undefined;
      }
    }
  }
}

/**
 * ENG-3125: the browser's guided fix for a Meta connection that cannot create ads. Never the
 * "you're set" page while the blocker exists; the button is a fresh Meta connect link for this
 * setup, so reconnecting returns here and readiness is re-derived.
 */
async function metaPageBlockedPage(
  deps: ZomaDeviceFlowDeps,
  device: ZomaDeviceRecord & { userId: string },
  blocker: ZomaMetaPageBlocker,
): Promise<PageStep> {
  const link = await blockerMetaLink(deps, device.deviceId, device.userId);
  await track(deps, device.deviceId, device.userId, 'meta_page_blocked', blocker.reason);
  return {
    kind: 'page',
    status: 200,
    title: 'One more step: your Facebook Page',
    message: blocker.message,
    steps: metaPageFixSteps(blocker.reason, { pageId: blocker.page_id, connectText: link ? 'use the Reconnect Meta button below and log in with the same Facebook account.' : undefined }),
    retryUrl: link ?? continueLink(deps, device.deviceId),
    retryLabel: link ? 'Reconnect Meta' : 'Try again',
  };
}

/** Send the browser to the first unfinished step for this setup; "you're set" when none is left. */
export async function continueInBrowser(deviceId: string, deps: ZomaDeviceFlowDeps = defaultZomaDeviceFlowDeps): Promise<BrowserStep> {
  const raw = await deps.store.getDevice(deviceId);
  if (raw?.status === 'issued') return DONE_PAGE;
  const device = journeyDevice(raw, deps.now());
  if (!device) return EXPIRED_PAGE;
  const state = await deps.readiness(device.userId);
  if (!state.ads_experience) return askAdsExperience(deps, device.deviceId);
  if (state.ads_experience === 'not_interested') return THANK_YOU_PAGE;
  if (!state.meta.ready) {
    const url = await deps.mintMetaLink(device.userId, device.deviceId);
    await track(deps, device.deviceId, device.userId, 'meta_redirect', 'ok');
    return { kind: 'redirect', url };
  }
  if (!state.payment.ready) {
    if (state.payment.error) {
      await track(deps, device.deviceId, device.userId, 'payment_checkout', 'failed', 'payment_state_unreadable');
      return { kind: 'page', status: 503, title: 'Zoma setup', message: state.payment.error, retryUrl: continueLink(deps, device.deviceId) };
    }
    return { kind: 'redirect', url: await paymentLink(deps, device) };
  }
  if (state.blocker) return metaPageBlockedPage(deps, device, state.blocker);
  return DONE_PAGE;
}

function askAdsExperience(deps: ZomaDeviceFlowDeps, deviceId: string, message?: string): BrowserStep {
  return {
    kind: 'ask_ads_experience',
    action: ZOMA_ADS_EXPERIENCE_PATH,
    token: deps.links.sign({ purpose: 'continue', zoma: deviceId }, ZOMA_ONBOARDING_WINDOW_SEC),
    question: ZOMA_ADS_EXPERIENCE_QUESTION,
    options: zomaAdsExperienceOptions(),
    ...(message ? { message } : {}),
  };
}

/** Save the answer and say what happens next. Shared by the browser form and the agent's poll. */
async function recordAdsExperience(
  deps: ZomaDeviceFlowDeps,
  device: ZomaDeviceRecord & { userId: string },
  answer: ZomaAdsExperience,
): Promise<void> {
  await deps.saveAdsExperience(device.userId, answer);
  await track(deps, device.deviceId, device.userId, 'ads_experience', answer);
}

/**
 * POST /api/zoma/ads-experience — the "How familiar are you with ads?" form.
 *   runs_ads        -> straight on to the next unfinished step (Meta, then payment)
 *   new_to_ads      -> straight on too (ENG-3134); the setup guide shows if Meta finds no ad account
 *   not_interested  -> thank-you; nothing further
 */
export async function answerAdsExperience(
  params: { t?: unknown; answer?: unknown },
  deps: ZomaDeviceFlowDeps = defaultZomaDeviceFlowDeps,
): Promise<BrowserStep> {
  const claims = deps.links.verify(params.t, 'continue');
  const device = claims ? journeyDevice(await deps.store.getDevice(claims.zoma), deps.now()) : null;
  if (!claims || !device) {
    logZomaSetup({ step: 'ads_experience', outcome: 'rejected', reason: 'invalid_link' });
    return EXPIRED_PAGE;
  }
  const answer = parseZomaAdsExperience(params.answer);
  if (!answer) return askAdsExperience(deps, device.deviceId, 'Choose one of the options.');
  await recordAdsExperience(deps, device, answer);
  if (answer === 'not_interested') return THANK_YOU_PAGE;
  // ENG-3134: both ads answers lead straight to Meta connect. Someone with no ad account yet gets
  // the setup guide on the "No ad account found" page Meta's empty answer leads to.
  return continueInBrowser(device.deviceId, deps);
}

/** GET /api/zoma/continue?t= — resume the journey from a signed link (retry buttons, Stripe cancel). */
export async function resumeInBrowser(token: unknown, deps: ZomaDeviceFlowDeps = defaultZomaDeviceFlowDeps): Promise<BrowserStep> {
  const claims = deps.links.verify(token, 'continue');
  if (!claims) {
    logZomaSetup({ step: 'continue', outcome: 'rejected', reason: 'invalid_link' });
    return EXPIRED_PAGE;
  }
  return continueInBrowser(claims.zoma, deps);
}

const toPickerAccounts = (accounts: MetaAdAccountSelection[]): ZomaPickerAccount[] =>
  accounts.map((a) => ({ account_id: a.account_id, name: a.name, currency: a.currency }));

/**
 * Zoma's Meta callback. The signed OAuth state names the user AND the setup (`zoma` = deviceId);
 * both must match the device item, which is then finalized server-side for that user. The
 * browser's own AgentWeb session (if any) is never consulted.
 */
export async function completeMetaConnect(
  params: { code?: unknown; state?: unknown; error?: unknown; error_reason?: unknown },
  deps: ZomaDeviceFlowDeps = defaultZomaDeviceFlowDeps,
): Promise<BrowserStep> {
  const claims = deps.verifyMetaState(params.state);
  if (claims?.zoma === ZOMA_MCP_SETUP && typeof claims.userId === 'string' && claims.userId) {
    return completeMcpMetaConnect(claims.userId, params, deps);
  }
  const deviceId = typeof claims?.zoma === 'string' && /^[0-9a-f]{64}$/.test(claims.zoma) ? claims.zoma : null;
  if (!claims || !deviceId || typeof claims.userId !== 'string' || !claims.userId) {
    logZomaSetup({ step: 'meta_callback', outcome: 'rejected', reason: claims ? 'not_a_zoma_state' : 'invalid_state' });
    return { ...EXPIRED_PAGE, message: 'This Meta connection link is invalid or has expired. Ask your agent for a new link.' };
  }
  const raw = await deps.store.getDevice(deviceId);
  const device = journeyDevice(raw, deps.now());
  if (!device || device.userId !== claims.userId) {
    const reason = !raw ? 'unknown_setup' : raw.userId && raw.userId !== claims.userId ? 'state_user_mismatch' : `setup_${raw.status}_or_expired`;
    if (raw) await track(deps, raw.deviceId, raw.userId, 'meta_callback', 'rejected', reason);
    else logZomaSetup({ step: 'meta_callback', outcome: 'rejected', reason });
    return { ...EXPIRED_PAGE, message: 'This Meta connection link is invalid or has expired. Ask your agent for a new link.' };
  }
  const retryUrl = continueLink(deps, device.deviceId);
  if (params.error !== undefined || typeof params.code !== 'string' || !params.code) {
    const reason = typeof params.error_reason === 'string' ? params.error_reason : typeof params.error === 'string' ? params.error : 'no_code';
    await track(deps, device.deviceId, device.userId, 'meta_callback', 'denied', reason);
    return { kind: 'page', status: 400, title: 'Meta not connected', message: 'Meta was not connected. Zoma needs access to your ad account to continue.', retryUrl };
  }

  let result: MetaFinalizeResult;
  try {
    result = await deps.finalizeMeta(device.userId, params.code);
  } catch (error) {
    await track(deps, device.deviceId, device.userId, 'meta_callback', 'failed', error);
    return { kind: 'page', status: 502, title: 'Meta not connected', message: 'We could not finish connecting Meta. Please try again.', retryUrl };
  }
  const accounts = result.flow === 'marketing' ? result.adAccounts ?? [] : [];
  if (accounts.length === 0) {
    const reason = result.flow === 'marketing' && result.adAccountsError ? 'ad_accounts_unavailable' : 'no_ad_accounts';
    await track(deps, device.deviceId, device.userId, 'meta_callback', 'failed', reason);
    return noAdAccountPage(reason, retryUrl);
  }
  await track(deps, device.deviceId, device.userId, 'meta_callback', 'ok', `${accounts.length}_ad_accounts`);
  if (accounts.length === 1) return connectAndContinue(deps, device, accounts, result.tokenSessionId);

  const selection = accounts.map((a) => ({ account_id: a.account_id, name: a.name, currency: a.currency, account_status: a.account_status }));
  const token = deps.links.sign(
    { purpose: 'pick_meta_account', zoma: device.deviceId, tokenSessionId: result.tokenSessionId, accounts: selection },
    600, // the parked Meta token session lives 10 minutes
  );
  return { kind: 'pick_account', action: ZOMA_META_SELECT_PATH, token, accounts: toPickerAccounts(selection) };
}

/**
 * Meta returned no ad account. ENG-3134: a new advertiser lands here straight from the question,
 * so the page carries the ad-account setup guide and the reconnect button (same flow, no detour).
 */
function noAdAccountPage(reason: 'no_ad_accounts' | 'ad_accounts_unavailable', retryUrl: string): PageStep {
  if (reason === 'ad_accounts_unavailable') {
    return { kind: 'page', status: 400, title: 'No ad account found', message: 'Meta did not return your ad accounts just now. Please try again.', retryUrl };
  }
  return {
    kind: 'page',
    status: 400,
    title: 'No ad account found',
    message: `Meta did not share any ad accounts. If you already have one, reconnect with a Facebook login that has access to it and select it. If you have never run ads, set one up first (a few minutes), then reconnect. ${ZOMA_META_LOGIN_NOTE}`,
    steps: zomaNewToAdsSteps().slice(0, -1),
    retryUrl,
    retryLabel: 'Reconnect Meta',
  };
}

/** ENG-3134: the end of an MCP user's Meta connect — the Page blocker if any, else back to the agent. */
async function mcpMetaConnectedPage(userId: string, deps: ZomaDeviceFlowDeps): Promise<PageStep> {
  let blocker: ZomaMetaPageBlocker | null = null;
  try {
    blocker = (await deps.readiness(userId)).blocker;
  } catch (error) {
    logZomaSetup({ userId, step: 'meta_connect', outcome: 'error', reason: error });
  }
  if (blocker) {
    let link: string | undefined;
    try {
      link = await (deps.mintMcpMetaLink ?? buildZomaMcpMetaConnectUrl)(userId);
    } catch (error) {
      logZomaSetup({ userId, step: 'meta_link', outcome: 'error', reason: error });
    }
    logZomaSetup({ userId, step: 'meta_page_blocked', outcome: blocker.reason });
    return {
      kind: 'page',
      status: 200,
      title: 'One more step: your Facebook Page',
      message: blocker.message,
      steps: metaPageFixSteps(blocker.reason, {
        pageId: blocker.page_id,
        connectText: link ? 'use the Reconnect Meta button below and log in with the same Facebook account.' : 'ask your agent for a fresh Meta connect link (it runs zoma_status) and log in with the same Facebook account.',
      }),
      ...(link ? { retryUrl: link, retryLabel: 'Reconnect Meta' } : {}),
    };
  }
  return { kind: 'page', status: 200, title: 'Meta connected', message: `Your Meta ad account is connected to Zoma. ${ZOMA_BACK_TO_AGENT}`, done: true };
}

/** ENG-3134: Meta callback for an MCP-connected user — finalized server-side for the signed state's user. */
async function completeMcpMetaConnect(
  userId: string,
  params: { code?: unknown; error?: unknown; error_reason?: unknown },
  deps: ZomaDeviceFlowDeps,
): Promise<BrowserStep> {
  const retry = async (): Promise<string | undefined> => {
    try {
      return await (deps.mintMcpMetaLink ?? buildZomaMcpMetaConnectUrl)(userId);
    } catch (error) {
      logZomaSetup({ userId, step: 'meta_link', outcome: 'error', reason: error });
      return undefined;
    }
  };
  const failed = async (status: number, title: string, message: string): Promise<PageStep> => {
    const retryUrl = await retry();
    return { kind: 'page', status, title, message: retryUrl ? message : `${message} ${ZOMA_BACK_TO_AGENT}`, ...(retryUrl ? { retryUrl, retryLabel: 'Connect Meta again' } : {}) };
  };
  if (params.error !== undefined || typeof params.code !== 'string' || !params.code) {
    const reason = typeof params.error_reason === 'string' ? params.error_reason : typeof params.error === 'string' ? params.error : 'no_code';
    logZomaSetup({ userId, step: 'meta_callback', outcome: 'denied', reason });
    return failed(400, 'Meta not connected', 'Meta was not connected. Zoma needs access to your ad account to continue.');
  }
  let result: MetaFinalizeResult;
  try {
    result = await deps.finalizeMeta(userId, params.code);
  } catch (error) {
    logZomaSetup({ userId, step: 'meta_callback', outcome: 'failed', reason: error });
    return failed(502, 'Meta not connected', 'We could not finish connecting Meta. Please try again.');
  }
  const accounts = result.flow === 'marketing' ? result.adAccounts ?? [] : [];
  if (accounts.length === 0) {
    const reason = result.flow === 'marketing' && result.adAccountsError ? 'ad_accounts_unavailable' : 'no_ad_accounts';
    logZomaSetup({ userId, step: 'meta_callback', outcome: 'failed', reason });
    const retryUrl = await retry();
    const page = noAdAccountPage(reason, retryUrl ?? '');
    return retryUrl ? page : { ...page, retryUrl: undefined, message: `${page.message} ${ZOMA_BACK_TO_AGENT}` };
  }
  logZomaSetup({ userId, step: 'meta_callback', outcome: 'ok', reason: `${accounts.length}_ad_accounts` });
  if (accounts.length === 1) return connectMcpAccounts(userId, accounts, result.tokenSessionId, deps);
  const selection = accounts.map((a) => ({ account_id: a.account_id, name: a.name, currency: a.currency, account_status: a.account_status }));
  const token = deps.links.sign(
    { purpose: 'pick_meta_account', zoma: ZOMA_MCP_SETUP, uid: userId, tokenSessionId: result.tokenSessionId, accounts: selection },
    600,
  );
  return { kind: 'pick_account', action: ZOMA_META_SELECT_PATH, token, accounts: toPickerAccounts(selection) };
}

async function connectMcpAccounts(
  userId: string,
  accounts: MetaAdAccountSelection[],
  tokenSessionId: string,
  deps: ZomaDeviceFlowDeps,
): Promise<BrowserStep> {
  try {
    await deps.connectAdAccounts(userId, accounts, tokenSessionId);
  } catch (error) {
    logZomaSetup({ userId, step: 'meta_connect', outcome: 'failed', reason: error });
    return { kind: 'page', status: 502, title: 'Meta not connected', message: `We could not save your ad account. ${ZOMA_BACK_TO_AGENT}` };
  }
  logZomaSetup({ userId, step: 'meta_connect', outcome: 'ok', reason: `${accounts.length}_ad_accounts` });
  return mcpMetaConnectedPage(userId, deps);
}

async function connectAndContinue(
  deps: ZomaDeviceFlowDeps,
  device: ZomaDeviceRecord & { userId: string },
  accounts: MetaAdAccountSelection[],
  tokenSessionId: string,
): Promise<BrowserStep> {
  try {
    await deps.connectAdAccounts(device.userId, accounts, tokenSessionId);
  } catch (error) {
    await track(deps, device.deviceId, device.userId, 'meta_connect', 'failed', error);
    return {
      kind: 'page',
      status: 502,
      title: 'Meta not connected',
      message: 'We could not save your ad account. Please try again.',
      retryUrl: continueLink(deps, device.deviceId),
    };
  }
  await track(deps, device.deviceId, device.userId, 'meta_connect', 'ok', `${accounts.length}_ad_accounts`);
  return continueInBrowser(device.deviceId, deps);
}

/** Only accounts Meta offered (carried in the signed picker link) can be chosen. */
function pickedAccounts(claims: ZomaLinkClaims, raw: unknown) {
  const wanted = new Set((Array.isArray(raw) ? raw : [raw]).filter((v): v is string => typeof v === 'string'));
  return (claims.accounts ?? []).filter((a) => wanted.has(a.account_id));
}

/** POST /api/zoma/meta/select — the server-rendered picker. Only accounts Meta offered can be chosen. */
export async function selectMetaAccounts(
  params: { t?: unknown; account_id?: unknown },
  deps: ZomaDeviceFlowDeps = defaultZomaDeviceFlowDeps,
): Promise<BrowserStep> {
  const claims: ZomaLinkClaims | null = deps.links.verify(params.t, 'pick_meta_account');
  if (claims?.zoma === ZOMA_MCP_SETUP && claims.uid) {
    const chosenMcp = pickedAccounts(claims, params.account_id);
    if (!claims.tokenSessionId || !Array.isArray(claims.accounts)) {
      return { ...EXPIRED_PAGE, message: `This page has expired. ${ZOMA_BACK_TO_AGENT}` };
    }
    if (chosenMcp.length === 0) {
      return { kind: 'pick_account', action: ZOMA_META_SELECT_PATH, token: params.t as string, accounts: toPickerAccounts(claims.accounts), message: 'Choose at least one ad account.' };
    }
    return connectMcpAccounts(claims.uid, chosenMcp, claims.tokenSessionId, deps);
  }
  const device = claims ? journeyDevice(await deps.store.getDevice(claims.zoma), deps.now()) : null;
  if (!claims || !device || !claims.tokenSessionId || !Array.isArray(claims.accounts)) {
    logZomaSetup({ step: 'meta_connect', outcome: 'rejected', reason: 'invalid_picker_link' });
    return { ...EXPIRED_PAGE, message: 'This page has expired. Ask your agent for a new Meta connection link.' };
  }
  const chosen = pickedAccounts(claims, params.account_id);
  if (chosen.length === 0) {
    return {
      kind: 'pick_account',
      action: ZOMA_META_SELECT_PATH,
      token: params.t as string,
      accounts: toPickerAccounts(claims.accounts),
      message: 'Choose at least one ad account.',
    };
  }
  return connectAndContinue(deps, device, chosen, claims.tokenSessionId);
}

/** GET /api/zoma/done — Stripe's success/cancel return. */
export async function finishPayment(
  params: { t?: unknown; session_id?: unknown; canceled?: unknown; mcp?: unknown },
  deps: ZomaDeviceFlowDeps = defaultZomaDeviceFlowDeps,
): Promise<BrowserStep> {
  // ENG-3134: Stripe's return for a card added from zoma_status (no device). Informational only:
  // zoma_status re-derives payment state live, so nothing here is trusted or written.
  if (params.t === undefined && params.mcp !== undefined) {
    return params.canceled !== undefined
      ? { kind: 'page', status: 200, title: 'Payment method not added', message: `Nothing was saved or charged. ${ZOMA_BACK_TO_AGENT}` }
      : { kind: 'page', status: 200, title: 'Payment method added', message: `Nothing was charged. ${ZOMA_BACK_TO_AGENT}`, done: true };
  }
  const claims = deps.links.verify(params.t, 'continue');
  const raw = claims ? await deps.store.getDevice(claims.zoma) : null;
  if (!claims || !raw) {
    logZomaSetup({ step: 'checkout_completed', outcome: 'rejected', reason: 'invalid_link' });
    return EXPIRED_PAGE;
  }
  if (params.canceled !== undefined) {
    await track(deps, raw.deviceId, raw.userId, 'checkout_completed', 'canceled');
    return {
      kind: 'page',
      status: 200,
      title: 'Payment method not added',
      message: 'Zoma needs a payment method on file before it changes anything in your ad account. Nothing is charged by adding it.',
      retryUrl: continueLink(deps, raw.deviceId),
    };
  }
  if (typeof params.session_id === 'string' && /^cs_[A-Za-z0-9_]+$/.test(params.session_id)) {
    let verified = false;
    try {
      const session = await deps.getCheckoutSession(params.session_id);
      verified = !!session && session.status === 'complete' && !!raw.userId && session.userId === raw.userId;
    } catch (error) {
      await track(deps, raw.deviceId, raw.userId, 'checkout_completed', 'error', error);
    }
    await track(deps, raw.deviceId, raw.userId, 'checkout_completed', verified ? 'ok' : 'unverified');
    // ENG-2906: a Stripe-verified setup session for this user is the card_saved moment.
    if (verified) void zomaMilestone(raw.userId, 'card_saved', { emit: 'always', requireZoma: true, props: { product: 'zoma', source: 'checkout' } });
    // Stripe can lag in listing the new payment method; a verified session for this user is enough
    // for payment — but not for a Meta Page blocker (ENG-3125), which still withholds "you're set".
    if (verified) {
      const device = journeyDevice(raw, deps.now());
      const blocker = device ? (await deps.readiness(device.userId)).blocker : null;
      return device && blocker ? metaPageBlockedPage(deps, device, blocker) : DONE_PAGE;
    }
  }
  return continueInBrowser(raw.deviceId, deps);
}

// ─── 3. Poll ─────────────────────────────────────────────────────────────────

export type PollResult =
  | { status: 400; body: { error: 'authorization_pending'; error_description: string; next_step: 'sign_in'; link: string; interval: number } }
  | { status: 400; body: { error: 'slow_down'; error_description: string; interval: number } }
  | { status: 400; body: { error: 'expired_token' | 'access_denied' | 'invalid_grant' | 'invalid_request'; error_description: string } }
  | { status: 200; body: { next_step: ZomaLinkStep; link?: string; message?: string; guide?: readonly string[]; note?: string; interval: number } }
  | {
      status: 200;
      body: {
        next_step: 'ads_experience'; question: string;
        options: ReadonlyArray<{ value: ZomaAdsExperience; label: string }>; message: string; interval: number;
      };
    }
  | { status: 200; body: { next_step: 'not_interested'; message: string } }
  | {
      status: 200;
      body: {
        next_step: ZomaBlockerStep;
        reason: ZomaMetaPageBlockerReason;
        message: string;
        instructions: string[];
        link?: string;
        /** Set exactly when `link` is absent: the Meta link could not be minted on this poll. */
        link_error?: string;
        create_page_url?: string;
        page_id?: string;
        interval: number;
      };
    }
  | { status: 200; body: { next_step: 'complete'; access_token: string; token_type: 'Bearer'; mcp_url: string; message: string } };

const rfcError = (error: 'expired_token' | 'access_denied' | 'invalid_grant' | 'invalid_request', error_description: string): PollResult => ({
  status: 400,
  body: { error, error_description },
});

/** Poll outcome used to trace state changes only (not every poll). */
const pollOutcomeOf = (r: PollResult) => ('error' in r.body ? r.body.error : r.body.next_step);

export async function pollSetup(
  rawDeviceCode: unknown,
  deps: ZomaDeviceFlowDeps = defaultZomaDeviceFlowDeps,
  opts: { adsExperience?: unknown } = {},
): Promise<PollResult> {
  if (typeof rawDeviceCode !== 'string' || !rawDeviceCode) return rfcError('invalid_request', 'device_code is required.');
  const device = await deps.store.getDevice(sha256(rawDeviceCode));
  if (!device) return rfcError('invalid_grant', 'Unknown device_code. Start Zoma setup again.');
  // ENG-3128: the agent asked "How familiar are you with ads?" in chat and sends the answer here.
  let answer: ZomaAdsExperience | undefined;
  if (opts.adsExperience !== undefined) {
    const parsed = parseZomaAdsExperience(opts.adsExperience);
    if (!parsed) return rfcError('invalid_request', `ads_experience must be one of: ${ZOMA_ADS_EXPERIENCE_VALUES.join(', ')}.`);
    answer = parsed;
  }
  const result = await pollDevice(device, deps, answer);
  const outcome = pollOutcomeOf(result);
  if (outcome !== 'slow_down' && outcome !== device.lastPollOutcome) {
    await track(deps, device.deviceId, device.userId, 'poll', outcome, undefined, { pollOutcome: outcome });
  }
  if (result.status === 200 && result.body.next_step === 'complete') await track(deps, device.deviceId, device.userId, 'token_issued', 'ok');
  return result;
}

async function pollDevice(device: ZomaDeviceRecord, deps: ZomaDeviceFlowDeps, answer?: ZomaAdsExperience): Promise<PollResult> {
  const now = deps.now();
  if (device.expiresAt <= now) return rfcError('expired_token', 'This setup code has expired. Start Zoma setup again.');
  if (device.status === 'issued') return rfcError('invalid_grant', 'A Zoma token was already issued for this device_code; it is shown only once.');
  if (device.status === 'denied') return rfcError('access_denied', 'The user did not approve Zoma setup.');

  const claim = await deps.store.claimPoll(device.deviceId, device.intervalSec, now);
  if (!claim.ok) {
    return { status: 400, body: { error: 'slow_down', error_description: `Polling too fast; wait ${claim.intervalSec}s between polls.`, interval: claim.intervalSec } };
  }

  if (device.status === 'pending' || !device.userId) {
    return {
      status: 400,
      body: {
        error: 'authorization_pending',
        error_description: 'Waiting for the user to sign in and approve.',
        next_step: 'sign_in',
        link: `${activateUrl(deps)}?user_code=${displayUserCode(device.userCode)}`,
        interval: device.intervalSec,
      },
    };
  }

  // status === 'approved': onboarding steps, derived live from zomaOnboarding. The links are the
  // same ones the browser journey uses, so an agent can re-send one if the user drops off.
  const userId = device.userId;
  if (answer) await recordAdsExperience(deps, { ...device, userId }, answer);
  const state = await deps.readiness(userId);
  if (!state.ads_experience) {
    return {
      status: 200,
      body: {
        next_step: 'ads_experience',
        question: ZOMA_ADS_EXPERIENCE_QUESTION,
        options: zomaAdsExperienceOptions(),
        message: `Say "${ZOMA_WELCOME}" to the user, then ask "${ZOMA_ADS_EXPERIENCE_QUESTION}" and poll again with ads_experience set to the value of their answer.`,
        interval: device.intervalSec,
      },
    };
  }
  // A friend must never be issued a token or sent through setup.
  if (state.ads_experience === 'not_interested') {
    return { status: 200, body: { next_step: 'not_interested', message: ZOMA_NOT_INTERESTED_MESSAGE } };
  }
  // Same order as zoma_status: connect Meta, payment, then the Page blocker (ENG-3125).
  const step: ZomaNextStep = !state.meta.ready ? 'connect_meta' : !state.payment.ready ? 'add_payment' : state.blocker ? 'fix_meta_page' : 'complete';

  if (step === 'fix_meta_page') {
    const blocker = state.blocker as ZomaMetaPageBlocker;
    const link = await blockerMetaLink(deps, device.deviceId, userId);
    return {
      status: 200,
      body: {
        next_step: 'fix_meta_page',
        reason: blocker.reason,
        message: blocker.message,
        // Without a link, the step points the agent back at this poll (which mints a fresh one),
        // never at "ask me" — the polling agent is the one who would have to ask.
        instructions: metaPageFixSteps(blocker.reason, {
          link,
          pageId: blocker.page_id,
          connectText: link ? undefined : 'poll setup again for a fresh Meta connect link, then open it and log in with the same Facebook account.',
        }),
        ...(link ? { link } : { link_error: META_LINK_UNAVAILABLE }),
        ...(blocker.create_page_url ? { create_page_url: blocker.create_page_url } : {}),
        ...(blocker.page_id ? { page_id: blocker.page_id } : {}),
        interval: device.intervalSec,
      },
    };
  }

  if (step !== 'complete') {
    if (state.payment.error && step === 'add_payment') {
      return { status: 200, body: { next_step: step, message: state.payment.error, interval: device.intervalSec } };
    }
    // The new-advertiser guide already ends with the login note; everyone else gets it on its own.
    const guide = step !== 'connect_meta'
      ? {}
      : state.ads_experience === 'new_to_ads' ? { guide: zomaNewToAdsSteps() } : { note: ZOMA_META_LOGIN_NOTE };
    let link: string | undefined;
    try {
      // Meta links are cheap signed URLs (state expires in 10 min), so mint fresh per poll;
      // the Checkout session is minted once per setup and reused.
      link = step === 'connect_meta' ? await deps.mintMetaLink(userId, device.deviceId) : await paymentLink(deps, { ...device, userId });
    } catch (error) {
      await track(deps, device.deviceId, userId, step === 'connect_meta' ? 'meta_link' : 'payment_checkout', 'error', error);
    }
    return {
      status: 200,
      body: {
        next_step: step,
        ...(link ? { link } : { message: 'Could not create the link right now; keep polling.' }),
        ...guide,
        interval: device.intervalSec,
      },
    };
  }

  if (!(await deps.principalAllowed(userId))) return rfcError('access_denied', 'This account cannot use Zoma.');
  const rawToken = `${ZOMA_TOKEN_PREFIX}${crypto.randomBytes(32).toString('base64url')}`;
  const issued = await deps.store.issueToken(device.deviceId, {
    tokenHash: sha256(rawToken),
    tokenId: uuidv4(),
    userId,
    deviceId: device.deviceId,
    revoked: false,
    createdAt: new Date(now).toISOString(),
  });
  if (!issued) return rfcError('invalid_grant', 'A Zoma token was already issued for this device_code; it is shown only once.');
  // ENG-2906: readiness said payment is ready (card_saved, once, if not already recorded via
  // checkout) and the agent now holds a zoma_ credential (connected).
  void (async () => {
    await noteProductUse(userId, 'zoma');
    await zomaMilestone(userId, 'card_saved', { emit: 'if_advanced', requireZoma: true, props: { product: 'zoma', source: 'readiness' } });
    await zomaMilestone(userId, 'connected', { emit: 'always', props: { product: 'zoma', path: 'zoma_device' } });
  })();
  return {
    status: 200,
    body: {
      next_step: 'complete',
      access_token: rawToken,
      token_type: 'Bearer',
      mcp_url: mcpUrl(deps),
      message: 'Setup complete. This token is shown once; register the MCP server with it now.',
    },
  };
}

// ─── 4/5. Token validation + revocation ──────────────────────────────────────

export async function validateZomaToken(
  rawToken: string,
  deps: ZomaDeviceFlowDeps = defaultZomaDeviceFlowDeps,
): Promise<{ userId: string; tokenId: string } | null> {
  if (!rawToken.startsWith(ZOMA_TOKEN_PREFIX)) return null;
  const tokenHash = sha256(rawToken);
  const record = await deps.store.getToken(tokenHash);
  if (!record || record.tokenHash !== tokenHash || record.revoked !== false || typeof record.userId !== 'string' || !record.userId) return null;
  if (!(await deps.principalAllowed(record.userId))) return null;
  return { userId: record.userId, tokenId: record.tokenId };
}

export async function revokeZomaToken(rawToken: string, deps: ZomaDeviceFlowDeps = defaultZomaDeviceFlowDeps): Promise<boolean> {
  if (!rawToken.startsWith(ZOMA_TOKEN_PREFIX)) return false;
  const tokenHash = sha256(rawToken);
  const record = await deps.store.getToken(tokenHash);
  const revoked = await deps.store.revokeToken(tokenHash, deps.now());
  if (revoked && record?.deviceId) await track(deps, record.deviceId, record.userId, 'token_revoked', 'ok');
  return revoked;
}
