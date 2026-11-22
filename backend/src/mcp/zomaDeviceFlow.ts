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
 *   3. pollSetup          POST /api/zoma/setup/poll     -> RFC errors until bound, then
 *      next_step from getZomaReadiness (connect_meta | add_payment | complete). On complete
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
import { createZomaPaymentSetupLink, getZomaReadiness, type ZomaReadiness } from './zomaOnboarding';
import { DynamoZomaDeviceStore, type ZomaDeviceRecord, type ZomaDeviceStore, type ZomaLinkStep } from './zomaDeviceStore';
import { logZomaSetup } from './zomaSetupLog';
import {
  defaultZomaLinkCodec,
  ZOMA_CONTINUE_PATH,
  ZOMA_DONE_PATH,
  ZOMA_META_SELECT_PATH,
  type ZomaLinkClaims,
  type ZomaLinkCodec,
} from './zomaSetupLinks';
import { isEvaluationUser, requireActiveEvaluation } from '../services/evaluationPolicy';
import { getJwtSecret } from '../config/jwt';
import type { MetaFinalizeResult, MetaAdAccountSelection } from '../services/metaOAuthFinalize';

export const ZOMA_DEVICE_CLIENT_ID = 'zoma-device-setup';
export const ZOMA_DEVICE_CLIENT_NAME = 'Zoma (agent setup)';
export const ZOMA_TOKEN_PREFIX = 'zoma_';
/** Time to sign in and approve (RFC 8628 expires_in). */
export const ZOMA_DEVICE_EXPIRES_SEC = 900;
/** After approval the same device_code carries the user through Meta + payment. */
export const ZOMA_ONBOARDING_WINDOW_SEC = 3600;
export const ZOMA_POLL_INTERVAL_SEC = 5;
const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ'; // RFC 8628 §6.1: no vowels, no look-alikes
const USER_CODE_LENGTH = 8;

export type ZomaNextStep = 'sign_in' | ZomaLinkStep | 'complete';

export interface ZomaDeviceFlowDeps {
  store: ZomaDeviceStore;
  now: () => number;
  backendUrl: () => string;
  /** Live state only — never mints links (a 5-second poll must not create Stripe sessions). */
  readiness: (userId: string) => Promise<ZomaReadiness>;
  /** Meta connect URL whose signed state carries `zoma: deviceId` (routes the callback to Zoma). */
  mintMetaLink: (userId: string, deviceId: string) => Promise<string>;
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

export async function startSetup(deps: ZomaDeviceFlowDeps = defaultZomaDeviceFlowDeps) {
  const now = deps.now();
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
    });
    if (!created) continue; // user_code collision
    await track(deps, deviceId, undefined, 'setup_started', 'ok');
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
  return { ok: true, deviceId: device.deviceId };
}

// ─── 2b. One browser journey: approval -> Meta -> payment -> done ────────────

export interface ZomaPickerAccount {
  account_id: string;
  name: string;
  currency: string;
}

export type BrowserStep =
  | { kind: 'redirect'; url: string }
  | { kind: 'page'; status: number; title: string; message: string; retryUrl?: string; done?: boolean }
  | { kind: 'pick_account'; action: string; token: string; accounts: ZomaPickerAccount[]; message?: string };

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

/** Send the browser to the first unfinished step for this setup; "you're set" when none is left. */
export async function continueInBrowser(deviceId: string, deps: ZomaDeviceFlowDeps = defaultZomaDeviceFlowDeps): Promise<BrowserStep> {
  const raw = await deps.store.getDevice(deviceId);
  if (raw?.status === 'issued') return DONE_PAGE;
  const device = journeyDevice(raw, deps.now());
  if (!device) return EXPIRED_PAGE;
  const state = await deps.readiness(device.userId);
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
  return DONE_PAGE;
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
    return {
      kind: 'page',
      status: 400,
      title: 'No ad account found',
      message:
        reason === 'no_ad_accounts'
          ? 'Meta did not share any ad accounts. Reconnect and make sure you select your ad account.'
          : 'Meta did not return your ad accounts just now. Please try again.',
      retryUrl,
    };
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

/** POST /api/zoma/meta/select — the server-rendered picker. Only accounts Meta offered can be chosen. */
export async function selectMetaAccounts(
  params: { t?: unknown; account_id?: unknown },
  deps: ZomaDeviceFlowDeps = defaultZomaDeviceFlowDeps,
): Promise<BrowserStep> {
  const claims: ZomaLinkClaims | null = deps.links.verify(params.t, 'pick_meta_account');
  const device = claims ? journeyDevice(await deps.store.getDevice(claims.zoma), deps.now()) : null;
  if (!claims || !device || !claims.tokenSessionId || !Array.isArray(claims.accounts)) {
    logZomaSetup({ step: 'meta_connect', outcome: 'rejected', reason: 'invalid_picker_link' });
    return { ...EXPIRED_PAGE, message: 'This page has expired. Ask your agent for a new Meta connection link.' };
  }
  const wanted = new Set((Array.isArray(params.account_id) ? params.account_id : [params.account_id]).filter((v): v is string => typeof v === 'string'));
  const chosen = claims.accounts.filter((a) => wanted.has(a.account_id));
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
  params: { t?: unknown; session_id?: unknown; canceled?: unknown },
  deps: ZomaDeviceFlowDeps = defaultZomaDeviceFlowDeps,
): Promise<BrowserStep> {
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
    // Stripe can lag in listing the new payment method; a verified session for this user is enough.
    if (verified) return DONE_PAGE;
  }
  return continueInBrowser(raw.deviceId, deps);
}

// ─── 3. Poll ─────────────────────────────────────────────────────────────────

export type PollResult =
  | { status: 400; body: { error: 'authorization_pending'; error_description: string; next_step: 'sign_in'; link: string; interval: number } }
  | { status: 400; body: { error: 'slow_down'; error_description: string; interval: number } }
  | { status: 400; body: { error: 'expired_token' | 'access_denied' | 'invalid_grant' | 'invalid_request'; error_description: string } }
  | { status: 200; body: { next_step: ZomaLinkStep; link?: string; message?: string; interval: number } }
  | { status: 200; body: { next_step: 'complete'; access_token: string; token_type: 'Bearer'; mcp_url: string; message: string } };

const rfcError = (error: 'expired_token' | 'access_denied' | 'invalid_grant' | 'invalid_request', error_description: string): PollResult => ({
  status: 400,
  body: { error, error_description },
});

/** Poll outcome used to trace state changes only (not every poll). */
const pollOutcomeOf = (r: PollResult) => ('error' in r.body ? r.body.error : r.body.next_step);

export async function pollSetup(rawDeviceCode: unknown, deps: ZomaDeviceFlowDeps = defaultZomaDeviceFlowDeps): Promise<PollResult> {
  if (typeof rawDeviceCode !== 'string' || !rawDeviceCode) return rfcError('invalid_request', 'device_code is required.');
  const device = await deps.store.getDevice(sha256(rawDeviceCode));
  if (!device) return rfcError('invalid_grant', 'Unknown device_code. Start Zoma setup again.');
  const result = await pollDevice(device, deps);
  const outcome = pollOutcomeOf(result);
  if (outcome !== 'slow_down' && outcome !== device.lastPollOutcome) {
    await track(deps, device.deviceId, device.userId, 'poll', outcome, undefined, { pollOutcome: outcome });
  }
  if (result.status === 200 && result.body.next_step === 'complete') await track(deps, device.deviceId, device.userId, 'token_issued', 'ok');
  return result;
}

async function pollDevice(device: ZomaDeviceRecord, deps: ZomaDeviceFlowDeps): Promise<PollResult> {
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
  const state = await deps.readiness(userId);
  const step: ZomaNextStep = !state.meta.ready ? 'connect_meta' : !state.payment.ready ? 'add_payment' : 'complete';

  if (step !== 'complete') {
    if (state.payment.error && step === 'add_payment') {
      return { status: 200, body: { next_step: step, message: state.payment.error, interval: device.intervalSec } };
    }
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
