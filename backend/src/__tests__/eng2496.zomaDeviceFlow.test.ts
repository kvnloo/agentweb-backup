process.env.ZOMA_REQUIRE_PAYMENT_METHOD = 'true';
/**
 * ENG-2496 — Zoma device-flow onboarding: security/auth invariants only.
 *  - expired device codes never progress or yield a token
 *  - a device_code yields its token once; a reused device_code yields nothing
 *  - polling faster than `interval` gets slow_down and a longer interval (RFC 8628 §3.5)
 *  - a revoked token is rejected by the Meta Toolkit gateway
 *  - an unbound (pending / denied / failed-consent) code never yields a token
 *  - only the token hash is persisted
 *  - Zoma's Meta callback rejects a tampered / other-user / non-Zoma state, and finalizes for
 *    the state's user regardless of the browser's AgentWeb session
 *  - the browser journey reaches the payment step (Checkout minted) right after Meta
 *  - setup trace logs and the stored timeline never contain codes or tokens
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'eng-2496-test-secret';

jest.mock('../mcp/oauth/oauthService', () => ({ mcpOAuthService: {} }));
jest.mock('../mcp/zomaOnboarding', () => ({
  getZomaReadiness: jest.fn(),
  metaConnectionIsUsable: jest.fn(),
  runZomaTool: jest.fn(),
  ZomaNotReadyError: class extends Error {},
}));
jest.mock('../services/agentApiKeyService', () => ({ agentApiKeyService: {} }));
jest.mock('../services/connectedAccountsDb', () => ({ getAccountsByUserIdIncludingOrgShared: jest.fn() }));
jest.mock('../services/mcpUsageEventsService', () => ({ recordMcpToolUse: jest.fn(), recordMcpWriteExecuted: jest.fn() }));
jest.mock('../mcp/metaToolkitManifest', () => ({ MetaToolkitRefusal: class extends Error {}, executeMetaToolkitCall: jest.fn(), getMetaToolkitManifest: () => [] }));
jest.mock('../mcp/metaToolkitWrites', () => ({ executeMetaToolkitWrite: jest.fn(), isGuardedWriteRequest: jest.fn() }));
jest.mock('../middleware/auth', () => ({ authenticateToken: (_req: any, _res: any, next: any) => next() }));
jest.mock('../services/metaOAuthFinalize', () => ({ META_PRECONNECT_INSTRUCTIONS: '', MetaTokenSessionError: class extends Error {} }));

import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';

import {
  beginVerification,
  completeMetaConnect,
  completeVerification,
  continueInBrowser,
  defaultZomaDeviceFlowDeps,
  finishPayment,
  pollSetup,
  selectMetaAccounts,
  revokeZomaToken,
  sha256,
  startSetup,
  validateZomaToken,
  type ZomaDeviceFlowDeps,
} from '../mcp/zomaDeviceFlow';
import { DynamoZomaDeviceStore, type ZomaDeviceRecord, type ZomaDeviceStore, type ZomaTokenRecord } from '../mcp/zomaDeviceStore';
import { authenticateMetaToolkitCaller, MetaToolkitAuthError, type MetaToolkitGatewayDeps } from '../mcp/metaToolkitGateway';
import { generateMetaOAuthState } from '../services/metaConnectUrl';
import { defaultZomaLinkCodec, ZOMA_META_CALLBACK_PATH } from '../mcp/zomaSetupLinks';
import { scrubReason } from '../mcp/zomaSetupLog';
import { createZomaRouter } from '../routes/zoma';
import metaAuthRouter from '../routes/metaAuth';

/** In-memory store with the same atomic semantics the DynamoDB conditions enforce. */
class MemoryStore implements ZomaDeviceStore {
  devices = new Map<string, ZomaDeviceRecord>();
  userCodes = new Map<string, string>();
  tokens = new Map<string, ZomaTokenRecord>();
  async createDevice(r: ZomaDeviceRecord) {
    if (this.userCodes.has(r.userCode) || this.devices.has(r.deviceId)) return false;
    this.userCodes.set(r.userCode, r.deviceId);
    this.devices.set(r.deviceId, { ...r });
    return true;
  }
  async getDevice(id: string) {
    const d = this.devices.get(id);
    return d ? { ...d } : null;
  }
  async getDeviceIdByUserCode(code: string) {
    return this.userCodes.get(code) ?? null;
  }
  async claimPoll(id: string, intervalSec: number, now: number) {
    const d = this.devices.get(id)!;
    if (d.intervalSec === intervalSec && (d.lastPollAt === undefined || d.lastPollAt <= now - intervalSec * 1000)) {
      d.lastPollAt = now;
      return { ok: true as const };
    }
    d.lastPollAt = now;
    d.intervalSec += 5;
    return { ok: false as const, intervalSec: d.intervalSec };
  }
  async resolveDevice(id: string, outcome: any, now: number) {
    const d = this.devices.get(id);
    if (!d || d.status !== 'pending' || d.expiresAt <= now) return false;
    d.status = outcome.status;
    if (outcome.status === 'approved') Object.assign(d, { userId: outcome.userId, expiresAt: outcome.expiresAt });
    return true;
  }
  async saveLink(id: string, step: any, link: string) {
    const d = this.devices.get(id)!;
    d.links = { ...(d.links ?? {}), [step]: link };
  }
  async issueToken(id: string, token: ZomaTokenRecord) {
    const d = this.devices.get(id);
    if (!d || d.status !== 'approved' || d.userId !== token.userId || this.tokens.has(token.tokenHash)) return false;
    d.status = 'issued';
    this.tokens.set(token.tokenHash, { ...token });
    return true;
  }
  async getToken(hash: string) {
    const t = this.tokens.get(hash);
    return t ? { ...t } : null;
  }
  async revokeToken(hash: string) {
    const t = this.tokens.get(hash);
    if (!t) return false;
    t.revoked = true;
    return true;
  }
  async appendEvent(id: string, event: any, opts: { pollOutcome?: string } = {}) {
    const d = this.devices.get(id);
    if (!d) return;
    d.events = [...(d.events ?? []), event];
    if (opts.pollOutcome) d.lastPollOutcome = opts.pollOutcome;
  }
}

const READY = { payment: { ready: true }, meta: { ready: true, accounts: [] }, writes_enabled: true, next_step: null };
const ACCT = (id: string) => ({ id: `act_${id}`, account_id: id, name: `Acct ${id}`, currency: 'USD', account_status: 1 });
/** The real Meta connect state format (signed with JWT_SECRET), carrying the Zoma marker. */
const metaState = (userId: string, extra: Record<string, string> = {}) => generateMetaOAuthState(userId, { flow: 'marketing', ...extra });

function harness(over: Partial<ZomaDeviceFlowDeps> = {}) {
  let now = 1_800_000_000_000;
  const store = new MemoryStore();
  const deps: ZomaDeviceFlowDeps = {
    store,
    now: () => now,
    backendUrl: () => 'https://api.example.test',
    readiness: jest.fn().mockResolvedValue(READY),
    mintMetaLink: jest.fn(async (userId: string, deviceId: string) => `https://www.facebook.com/v1/dialog/oauth?state=${metaState(userId, { zoma: deviceId })}`),
    mintPaymentLink: jest.fn(async (_u: string, urls: { successUrl: string }) => `https://checkout.stripe.com/c/pay/cs_test_1#${urls.successUrl}`),
    ensureClient: jest.fn().mockResolvedValue(undefined),
    consumeAuthCode: jest.fn().mockResolvedValue({ userId: 'user-1' }),
    principalAllowed: jest.fn().mockResolvedValue(true),
    links: defaultZomaLinkCodec,
    verifyMetaState: defaultZomaDeviceFlowDeps.verifyMetaState,
    finalizeMeta: jest.fn().mockResolvedValue({ flow: 'marketing', adAccounts: [ACCT('111')], tokenSessionId: 'tsid-secret', preconnectInstructions: '' }),
    connectAdAccounts: jest.fn().mockResolvedValue(undefined),
    getCheckoutSession: jest.fn().mockResolvedValue({ status: 'complete', userId: 'user-1' }),
    ...over,
  };
  return { deps, store, advance: (ms: number) => (now += ms) };
}

/** Start, sign in + approve through the consent round-trip; returns the device_code. */
async function startAndApprove(h: ReturnType<typeof harness>) {
  const start = await startSetup(h.deps);
  const begin = await beginVerification(start.user_code, h.deps);
  if (!begin.ok) throw new Error(begin.message);
  const state = new URL(begin.redirect).searchParams.get('state');
  const done = await completeVerification({ code: 'auth-code', state }, h.deps);
  expect(done.ok).toBe(true);
  return start.device_code;
}

/** Readiness that flips as the journey connects Meta / adds payment. */
function liveReadiness() {
  const live = { meta: false, payment: false };
  const readiness = jest.fn(async () => ({
    payment: { ready: live.payment },
    meta: { ready: live.meta, accounts: [] },
    writes_enabled: live.meta && live.payment,
    next_step: null,
  }));
  return { live, readiness: readiness as any };
}

describe('ENG-2496 Zoma device flow — security invariants', () => {
  it('an unbound code never yields a token (pending, failed consent, denied)', async () => {
    const h = harness({ consumeAuthCode: jest.fn().mockResolvedValue(null) });
    const start = await startSetup(h.deps);

    const pending = await pollSetup(start.device_code, h.deps);
    expect(pending.body).toMatchObject({ error: 'authorization_pending', next_step: 'sign_in' });
    expect(pending.body).not.toHaveProperty('access_token');

    // Consent round-trip whose auth code does not verify (wrong code / PKCE): still unbound.
    const begin = await beginVerification(start.user_code, h.deps);
    const state = begin.ok ? new URL(begin.redirect).searchParams.get('state') : null;
    expect((await completeVerification({ code: 'forged', state }, h.deps)).ok).toBe(false);
    h.advance(5_000);
    expect((await pollSetup(start.device_code, h.deps)).body).toMatchObject({ error: 'authorization_pending' });

    // User denies: access_denied, forever.
    await completeVerification({ error: 'access_denied', state }, h.deps);
    h.advance(5_000);
    const denied = await pollSetup(start.device_code, h.deps);
    expect(denied.body).toMatchObject({ error: 'access_denied' });
    expect(h.store.tokens.size).toBe(0);
  });

  it('a bound user who is not finished onboarding gets next_step, not a token', async () => {
    const h = harness({
      readiness: jest.fn(async () => ({ payment: { ready: false }, meta: { ready: true, accounts: [] }, writes_enabled: false, next_step: 'x' })) as any,
      mintPaymentLink: jest.fn().mockResolvedValue('https://checkout.stripe.test/setup'),
    });
    const deviceCode = await startAndApprove(h);
    const r = await pollSetup(deviceCode, h.deps);
    expect(r).toMatchObject({ status: 200, body: { next_step: 'add_payment', link: 'https://checkout.stripe.test/setup' } });
    expect(r.body).not.toHaveProperty('access_token');
    expect(h.store.tokens.size).toBe(0);
  });

  it('expired codes: no verification, no poll progress, no token', async () => {
    const h = harness();
    const start = await startSetup(h.deps);
    h.advance(start.expires_in * 1000);
    expect((await beginVerification(start.user_code, h.deps)).ok).toBe(false);
    expect((await pollSetup(start.device_code, h.deps)).body).toMatchObject({ error: 'expired_token' });
    // A consent result arriving after expiry cannot bind it either.
    const state = sha256(start.device_code);
    expect((await completeVerification({ code: 'auth-code', state }, h.deps)).ok).toBe(false);
    expect(h.store.tokens.size).toBe(0);
  });

  it('polling faster than the interval returns slow_down and grows the interval', async () => {
    const h = harness();
    const start = await startSetup(h.deps);
    await pollSetup(start.device_code, h.deps);
    h.advance(1_000);
    const fast = await pollSetup(start.device_code, h.deps);
    expect(fast.body).toMatchObject({ error: 'slow_down', interval: start.interval + 5 });
    h.advance(start.interval * 1000); // old interval is no longer enough
    expect((await pollSetup(start.device_code, h.deps)).body).toMatchObject({ error: 'slow_down' });
  });

  it('a token is issued exactly once and only its hash is stored; a reused device_code gets nothing', async () => {
    const h = harness();
    const deviceCode = await startAndApprove(h);

    const first = await pollSetup(deviceCode, h.deps);
    expect(first).toMatchObject({ status: 200, body: { next_step: 'complete', token_type: 'Bearer', mcp_url: 'https://api.example.test/api/meta-toolkit/mcp' } });
    const token = (first.body as any).access_token as string;
    expect(token).toMatch(/^zoma_/);
    expect(h.store.tokens.size).toBe(1);
    expect(JSON.stringify([...h.store.tokens.entries()])).not.toContain(token);
    expect(h.store.tokens.has(sha256(token))).toBe(true);

    h.advance(10_000);
    const reused = await pollSetup(deviceCode, h.deps);
    expect(reused.body).toMatchObject({ error: 'invalid_grant' });
    expect(reused.body).not.toHaveProperty('access_token');
    expect(h.store.tokens.size).toBe(1);
  });

  it('concurrent completions race for one token: the store elects exactly one issuer', async () => {
    const h = harness();
    const deviceCode = await startAndApprove(h);
    const deviceId = sha256(deviceCode);
    const base = { userId: 'user-1', deviceId, revoked: false, createdAt: '' };
    const results = await Promise.all([
      h.store.issueToken(deviceId, { ...base, tokenHash: 'a', tokenId: '1' }),
      h.store.issueToken(deviceId, { ...base, tokenHash: 'b', tokenId: '2' }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('a revoked token is rejected by validation and by the Meta Toolkit gateway', async () => {
    const h = harness();
    const deviceCode = await startAndApprove(h);
    const token = ((await pollSetup(deviceCode, h.deps)).body as any).access_token as string;

    const gatewayDeps = {
      validateApiKey: jest.fn(),
      validateOAuthToken: jest.fn(),
      validateZomaToken: (raw: string) => validateZomaToken(raw, h.deps),
      rateLimiter: { check: () => ({ allowed: true, remaining: 1, resetInMs: 0 }) },
      now: () => 0,
    } as unknown as MetaToolkitGatewayDeps;

    await expect(authenticateMetaToolkitCaller(`Bearer ${token}`, gatewayDeps)).resolves.toMatchObject({ userId: 'user-1', authMethod: 'zoma_token' });
    expect(gatewayDeps.validateOAuthToken).not.toHaveBeenCalled();

    expect(await revokeZomaToken(token, h.deps)).toBe(true);
    expect(await validateZomaToken(token, h.deps)).toBeNull();
    await expect(authenticateMetaToolkitCaller(`Bearer ${token}`, gatewayDeps)).rejects.toMatchObject({ status: 401 });
    await expect(authenticateMetaToolkitCaller('Bearer zoma_never-issued', gatewayDeps)).rejects.toBeInstanceOf(MetaToolkitAuthError);
  });

  it('DynamoDB store: issuance is conditional on approved+same user and token-row absence (one transaction)', async () => {
    const transactWrite = jest.fn().mockReturnValue({ promise: () => Promise.reject(Object.assign(new Error('ConditionalCheckFailed'), { code: 'TransactionCanceledException' })) });
    const store = new DynamoZomaDeviceStore({ transactWrite } as any, 'T');
    const ok = await store.issueToken('dev', { tokenHash: 'h', tokenId: 't', userId: 'u', deviceId: 'dev', revoked: false, createdAt: '' });
    expect(ok).toBe(false);
    const [update, put] = transactWrite.mock.calls[0][0].TransactItems;
    expect(update.Update.ConditionExpression).toBe('#status = :approved AND userId = :userId');
    expect(put.Put.ConditionExpression).toBe('attribute_not_exists(pk)');
    expect(put.Put.Item).toMatchObject({ pk: 'token#h' });
  });
});

describe('ENG-2496 Zoma Meta connect — session-independent, bound to the setup', () => {
  async function approvedSetup(over: Partial<ZomaDeviceFlowDeps> = {}) {
    const h = harness(over);
    const deviceCode = await startAndApprove(h);
    return { h, deviceCode, deviceId: sha256(deviceCode) };
  }

  it('rejects a tampered, other-user, expired, or non-Zoma state and never finalizes', async () => {
    const { h, deviceId } = await approvedSetup();
    const valid = metaState('user-1', { zoma: deviceId });
    const [head, body, sig] = valid.split('.');
    const forgedBody = Buffer.from(JSON.stringify({ ...(jwt.decode(valid) as object), userId: 'user-2' })).toString('base64url');
    const states = [
      `${head}.${forgedBody}.${sig}`, // payload swapped to another user, signature kept
      `${head}.${body}.${sig.slice(0, -2)}xx`, // signature tampered
      jwt.sign({ userId: 'user-1', flow: 'marketing', zoma: deviceId }, 'not-the-secret'), // wrong key
      metaState('user-2', { zoma: deviceId }), // validly signed, but for another user than the setup's
      metaState('user-1'), // a portal (non-Zoma) state
      metaState('user-1', { zoma: sha256('another-setup') }), // unknown setup
      jwt.sign({ userId: 'user-1', flow: 'marketing', zoma: deviceId }, process.env.JWT_SECRET!, { expiresIn: -10 }), // expired
    ];
    for (const state of states) {
      const step = await completeMetaConnect({ code: 'meta-code', state }, h.deps);
      expect(step).toMatchObject({ kind: 'page', status: 400 });
    }
    expect(h.deps.finalizeMeta).not.toHaveBeenCalled();
    expect(h.deps.connectAdAccounts).not.toHaveBeenCalled();
  });

  it('a picker submit cannot connect an account Meta did not offer, nor use a forged picker link', async () => {
    const { h, deviceId } = await approvedSetup({
      finalizeMeta: jest.fn().mockResolvedValue({ flow: 'marketing', adAccounts: [ACCT('111'), ACCT('222')], tokenSessionId: 'tsid', preconnectInstructions: '' }),
    });
    const picker = await completeMetaConnect({ code: 'meta-code', state: metaState('user-1', { zoma: deviceId }) }, h.deps);
    expect(picker).toMatchObject({ kind: 'pick_account' });
    const t = (picker as any).token as string;

    expect(await selectMetaAccounts({ t, account_id: 'attacker-999' }, h.deps)).toMatchObject({ kind: 'pick_account', message: expect.any(String) });
    expect(await selectMetaAccounts({ t: `${t.slice(0, -2)}xx`, account_id: '111' }, h.deps)).toMatchObject({ kind: 'page', status: 400 });
    // A portal-style JWT signed with the raw secret is not a Zoma link token.
    const raw = jwt.sign({ purpose: 'pick_meta_account', zoma: deviceId, tokenSessionId: 'x', accounts: [ACCT('999')] }, process.env.JWT_SECRET!);
    expect(await selectMetaAccounts({ t: raw, account_id: '999' }, h.deps)).toMatchObject({ kind: 'page', status: 400 });
    expect(h.deps.connectAdAccounts).not.toHaveBeenCalled();

    await selectMetaAccounts({ t, account_id: ['222', 'attacker-999'] }, h.deps);
    expect(h.deps.connectAdAccounts).toHaveBeenCalledTimes(1);
    expect((h.deps.connectAdAccounts as jest.Mock).mock.calls[0]).toEqual(['user-1', [{ account_id: '222', name: 'Acct 222', currency: 'USD', account_status: 1 }], 'tsid']);
  });

  it('HTTP: the multi-account picker is served with a referrer policy under which its POST carries a real Origin', async () => {
    // Prod regression: with Referrer-Policy no-referrer the browser sent `Origin: null` on the picker
    // submit, and the global CORS check answered {"error":"Forbidden"} before Zoma ever saw it.
    const { h, deviceId } = await approvedSetup({
      finalizeMeta: jest.fn().mockResolvedValue({ flow: 'marketing', adAccounts: [ACCT('111'), ACCT('222')], tokenSessionId: 'tsid', preconnectInstructions: '' }),
    });
    const app = express();
    app.use('/api/zoma', createZomaRouter(h.deps));

    const res = await request(app).get(ZOMA_META_CALLBACK_PATH).query({ code: 'meta-code', state: metaState('user-1', { zoma: deviceId }) });
    expect(res.status).toBe(200);
    expect(res.text).toContain('<form method="post" action="/api/zoma/meta/select">');
    expect(res.headers['referrer-policy']).toBe('same-origin');
  });

  it('HTTP: the callback finalizes for the state\'s user even when the browser is signed in as someone else', async () => {
    const { live, readiness } = liveReadiness();
    const { h, deviceId } = await approvedSetup({ readiness });
    (h.deps.connectAdAccounts as jest.Mock).mockImplementation(async () => { live.meta = true; });
    const app = express();
    app.use('/api/oauth/meta', metaAuthRouter);
    app.use('/api/zoma', createZomaRouter(h.deps));

    // Meta redirects to the EXISTING registered redirect URI; a Zoma state is forwarded to Zoma.
    const state = metaState('user-1', { zoma: deviceId });
    const forwarded = await request(app).get('/api/oauth/meta/callback').query({ code: 'meta-code', state });
    expect(forwarded.status).toBe(302);
    expect(forwarded.headers.location.startsWith(`${ZOMA_META_CALLBACK_PATH}?`)).toBe(true);

    const otherUsersSession = jwt.sign({ userId: 'user-2', email: 'other@example.com' }, process.env.JWT_SECRET!);
    const res = await request(app)
      .get(forwarded.headers.location)
      .set('Authorization', `Bearer ${otherUsersSession}`)
      .set('Cookie', `token=${otherUsersSession}`);
    expect(h.deps.finalizeMeta).toHaveBeenCalledWith('user-1', 'meta-code');
    expect((h.deps.connectAdAccounts as jest.Mock).mock.calls[0][0]).toBe('user-1');
    // ...and goes straight on to payment.
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/^https:\/\/checkout\.stripe\.com\//);

    // The portal flow is untouched: a portal state still goes to the portal's callback page.
    process.env.CUSTOMER_FRONTEND_URL = 'https://app.example.test';
    const portal = await request(app).get('/api/oauth/meta/callback').query({ code: 'c', state: metaState('user-2') });
    expect(portal.headers.location).toMatch(/^https:\/\/app\.example\.test\/oauth\/meta\/callback\?code=c&state=/);
  });
});

describe('ENG-2496 one browser journey: approval -> Meta -> payment -> done', () => {
  it('reaches the payment step right after Meta, mints Checkout once, and the agent poll gets the same link', async () => {
    const { live, readiness } = liveReadiness();
    const h = harness({ readiness });
    (h.deps.connectAdAccounts as jest.Mock).mockImplementation(async () => { live.meta = true; });
    const deviceCode = await startAndApprove(h);
    const deviceId = sha256(deviceCode);

    // After approval the browser goes straight to Meta.
    const afterApproval = await continueInBrowser(deviceId, h.deps);
    expect(afterApproval).toMatchObject({ kind: 'redirect', url: expect.stringMatching(/^https:\/\/www\.facebook\.com\//) });
    const state = new URL((afterApproval as any).url).searchParams.get('state');

    // Meta's callback goes straight on to Stripe setup-mode Checkout.
    const afterMeta = await completeMetaConnect({ code: 'meta-code', state }, h.deps);
    expect(afterMeta).toMatchObject({ kind: 'redirect', url: expect.stringMatching(/^https:\/\/checkout\.stripe\.com\//) });
    expect(h.deps.mintPaymentLink).toHaveBeenCalledTimes(1);
    const [payUser, urls] = (h.deps.mintPaymentLink as jest.Mock).mock.calls[0];
    expect(payUser).toBe('user-1');
    expect(urls.successUrl).toMatch(/^https:\/\/api\.example\.test\/api\/zoma\/done\?t=.+&session_id=\{CHECKOUT_SESSION_ID\}$/);

    // The agent's poll reports add_payment with the same link; no second session is minted.
    h.advance(5_000);
    const poll = await pollSetup(deviceCode, h.deps);
    expect(poll).toMatchObject({ status: 200, body: { next_step: 'add_payment', link: (afterMeta as any).url } });
    expect(h.deps.mintPaymentLink).toHaveBeenCalledTimes(1);

    // Stripe returns to Zoma's own "you're set" page.
    const t = new URL(urls.successUrl.replace('{CHECKOUT_SESSION_ID}', 'cs_test_1')).searchParams.get('t');
    const done = await finishPayment({ t, session_id: 'cs_test_1' }, h.deps);
    expect(done).toMatchObject({ kind: 'page', status: 200, done: true });
    expect((h.store.devices.get(deviceId)!.events ?? []).map((e) => `${e.step}:${e.outcome}`)).toEqual(
      expect.arrayContaining(['approval:approved', 'meta_redirect:ok', 'meta_callback:ok', 'meta_connect:ok', 'payment_checkout:created', 'checkout_completed:ok']),
    );
  });

  it('skips steps that are already done', async () => {
    const { live, readiness } = liveReadiness();
    live.meta = true;
    const h = harness({ readiness });
    const deviceId = sha256(await startAndApprove(h));
    expect(await continueInBrowser(deviceId, h.deps)).toMatchObject({ kind: 'redirect', url: expect.stringMatching(/checkout\.stripe\.com/) });
    live.payment = true;
    expect(await continueInBrowser(deviceId, h.deps)).toMatchObject({ kind: 'page', done: true });
    expect(h.deps.mintMetaLink).not.toHaveBeenCalled();
  });
});

describe('ENG-2496 setup tracing never leaks codes or tokens', () => {
  it('a full setup, poll, token issue and revoke logs one JSON line per event with no secrets', async () => {
    const lines: string[] = [];
    const spy = jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
    try {
      const { live, readiness } = liveReadiness();
      const h = harness({ readiness });
      (h.deps.connectAdAccounts as jest.Mock).mockImplementation(async () => { live.meta = true; });
      (h.deps.finalizeMeta as jest.Mock).mockRejectedValueOnce(new Error('Meta said no: access_token=EAABsecretsecretsecretsecret code=meta-code-123'));
      const start = await startSetup(h.deps);
      const begin = await beginVerification(start.user_code, h.deps);
      const consentState = begin.ok ? new URL(begin.redirect).searchParams.get('state') : null;
      await completeVerification({ code: 'auth-code-xyz', state: consentState }, h.deps);
      const deviceId = sha256(start.device_code);
      const toMeta = (await continueInBrowser(deviceId, h.deps)) as any;
      const state = new URL(toMeta.url).searchParams.get('state')!;
      await completeMetaConnect({ code: 'meta-code-123', state }, h.deps); // fails with a secret-laden error
      const toPay = (await completeMetaConnect({ code: 'meta-code-123', state }, h.deps)) as any;
      live.payment = true;
      h.advance(5_000);
      const issued = await pollSetup(start.device_code, h.deps);
      const token = (issued.body as any).access_token as string;
      expect(token).toMatch(/^zoma_/);
      await revokeZomaToken(token, h.deps);

      const zomaLines = lines.filter((l) => l.includes('zoma_setup')).map((l) => JSON.parse(l));
      expect(zomaLines.length).toBeGreaterThan(5);
      expect(zomaLines.every((l) => l.event === 'zoma_setup' && /^[0-9a-f]{12}$/.test(l.setup_id ?? '000000000000'))).toBe(true);
      expect(zomaLines.map((l) => `${l.step}:${l.outcome}`)).toEqual(
        expect.arrayContaining(['setup_started:ok', 'activate_visited:ok', 'approval:approved', 'meta_callback:failed', 'payment_checkout:created', 'token_issued:ok', 'token_revoked:ok']),
      );

      const secrets = [
        start.device_code,
        start.user_code,
        start.user_code.replace('-', ''),
        'auth-code-xyz',
        'meta-code-123',
        'EAABsecretsecretsecretsecret',
        token,
        token.slice('zoma_'.length),
        state,
        toPay.url,
        'tsid-secret',
        h.store.devices.get(deviceId)!.pkceVerifier,
      ];
      const stored = JSON.stringify(h.store.devices.get(deviceId)!.events);
      for (const secret of secrets) {
        expect(lines.join('\n')).not.toContain(secret);
        expect(stored).not.toContain(secret);
      }
    } finally {
      spy.mockRestore();
    }
  });

  it('scrubReason redacts tokens, codes, JWTs and Stripe secrets from free-text errors', () => {
    const jwtLike = jwt.sign({ a: 1 }, 'k');
    const out = scrubReason(`bad zoma_abcDEF123 ${jwtLike} sk_live_abc123XYZ cs_test_a1b2c3d4e5 ?code=xyz&state=abc`);
    for (const s of ['zoma_abcDEF123', jwtLike, 'sk_live_abc123XYZ', 'cs_test_a1b2c3d4e5', 'code=xyz', 'state=abc']) expect(out).not.toContain(s);
  });
});

