/**
 * ENG-2496 — agent-driven device-flow onboarding for Zoma (RFC 8628 shape).
 *
 *   1. startSetup         POST /api/zoma/setup          -> device_code + user_code + links
 *   2. beginVerification  GET  /api/zoma/activate       -> existing MCP OAuth consent page
 *      (portal sign-in / sign-up), as first-party client `zoma-device-setup` with PKCE held
 *      server-side; completeVerification on the callback binds the device to the user.
 *   3. pollSetup          POST /api/zoma/setup/poll     -> RFC errors until bound, then
 *      next_step from getZomaReadiness (connect_meta | add_payment | complete). On complete
 *      a per-user Zoma token is issued exactly once; only its hash is stored.
 *   4. validateZomaToken  used by the Meta Toolkit gateway for `zoma_` bearers.
 *   5. revokeZomaToken    POST /api/zoma/token/revoke
 *
 * Readiness and its links come from zomaOnboarding — nothing here re-derives payment or Meta state.
 */
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { mcpOAuthService } from './oauth/oauthService';
import { getBackendUrl, META_TOOLKIT_MCP_RESOURCE_PATH } from './oauth/authChallenge';
import { getZomaReadiness, type ZomaReadiness } from './zomaOnboarding';
import { DynamoZomaDeviceStore, type ZomaDeviceStore, type ZomaLinkStep } from './zomaDeviceStore';
import { isEvaluationUser, requireActiveEvaluation } from '../services/evaluationPolicy';

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
  readiness: (userId: string, opts: { mintLinks: boolean }) => Promise<ZomaReadiness>;
  ensureClient: (redirectUri: string) => Promise<void>;
  consumeAuthCode: (code: string, redirectUri: string, verifier: string) => Promise<{ userId: string } | null>;
  /** Fails closed for a sandbox (evaluation) principal without an active evaluation, like MCP OAuth. */
  principalAllowed: (userId: string) => Promise<boolean>;
}

let defaultStore: ZomaDeviceStore | undefined;
export const defaultZomaDeviceFlowDeps: ZomaDeviceFlowDeps = {
  get store() {
    return (defaultStore ??= new DynamoZomaDeviceStore());
  },
  now: () => Date.now(),
  backendUrl: getBackendUrl,
  readiness: (userId, opts) => getZomaReadiness(userId, undefined, opts),
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
};

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
const mcpUrl = (deps: ZomaDeviceFlowDeps) => `${deps.backendUrl().replace(/\/+$/, '')}${META_TOOLKIT_MCP_RESOURCE_PATH}`;

// ─── 1. Start ─────────────────────────────────────────────────────────────────

export async function startSetup(deps: ZomaDeviceFlowDeps = defaultZomaDeviceFlowDeps) {
  const now = deps.now();
  for (let attempt = 0; attempt < 5; attempt++) {
    const deviceCode = crypto.randomBytes(32).toString('base64url');
    const userCode = newUserCode();
    const created = await deps.store.createDevice({
      deviceId: sha256(deviceCode),
      userCode,
      status: 'pending',
      pkceVerifier: crypto.randomBytes(32).toString('base64url'),
      intervalSec: ZOMA_POLL_INTERVAL_SEC,
      expiresAt: now + ZOMA_DEVICE_EXPIRES_SEC * 1000,
      createdAt: new Date(now).toISOString(),
    });
    if (!created) continue; // user_code collision
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
  if (!userCode) return { ok: false, message: 'That code is not valid. Check the code your agent showed you.' };
  const deviceId = await deps.store.getDeviceIdByUserCode(userCode);
  const device = deviceId ? await deps.store.getDevice(deviceId) : null;
  if (!device || device.expiresAt <= deps.now()) {
    return { ok: false, message: 'That code has expired or does not exist. Ask your agent to start Zoma setup again.' };
  }
  if (device.status !== 'pending') return { ok: false, message: 'That code has already been used.' };

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
): Promise<{ ok: boolean; message: string }> {
  const state = typeof params.state === 'string' ? params.state : '';
  const device = /^[0-9a-f]{64}$/.test(state) ? await deps.store.getDevice(state) : null;
  const now = deps.now();
  if (!device || device.expiresAt <= now || device.status !== 'pending') {
    return { ok: false, message: 'This setup link has expired or was already used. Ask your agent to start Zoma setup again.' };
  }
  if (params.error !== undefined || typeof params.code !== 'string' || !params.code) {
    await deps.store.resolveDevice(device.deviceId, { status: 'denied' }, now);
    return { ok: false, message: 'Zoma setup was not approved. You can close this tab.' };
  }
  const grant = await deps.consumeAuthCode(params.code, callbackUrl(deps), device.pkceVerifier);
  if (!grant?.userId) return { ok: false, message: 'Sign-in could not be verified. Ask your agent to start Zoma setup again.' };
  const bound = await deps.store.resolveDevice(
    device.deviceId,
    { status: 'approved', userId: grant.userId, expiresAt: now + ZOMA_ONBOARDING_WINDOW_SEC * 1000 },
    now,
  );
  if (!bound) return { ok: false, message: 'This setup link has expired or was already used.' };
  return { ok: true, message: 'Approved. Go back to your agent — it will walk you through the remaining steps.' };
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

export async function pollSetup(rawDeviceCode: unknown, deps: ZomaDeviceFlowDeps = defaultZomaDeviceFlowDeps): Promise<PollResult> {
  if (typeof rawDeviceCode !== 'string' || !rawDeviceCode) return rfcError('invalid_request', 'device_code is required.');
  const device = await deps.store.getDevice(sha256(rawDeviceCode));
  if (!device) return rfcError('invalid_grant', 'Unknown device_code. Start Zoma setup again.');
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

  // status === 'approved': onboarding steps, derived live from zomaOnboarding.
  const userId = device.userId;
  const state = await deps.readiness(userId, { mintLinks: false });
  const step: ZomaNextStep = !state.meta.ready ? 'connect_meta' : !state.payment.ready ? 'add_payment' : 'complete';

  if (step !== 'complete') {
    if (state.payment.error && step === 'add_payment') {
      return { status: 200, body: { next_step: step, message: state.payment.error, interval: device.intervalSec } };
    }
    let link = device.links?.[step];
    if (!link) {
      const minted = await deps.readiness(userId, { mintLinks: true });
      link = step === 'connect_meta' ? minted.meta.link : minted.payment.link;
      if (link) await deps.store.saveLink(device.deviceId, step, link);
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
  return deps.store.revokeToken(sha256(rawToken), deps.now());
}
