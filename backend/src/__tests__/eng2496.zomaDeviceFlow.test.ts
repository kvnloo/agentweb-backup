/**
 * ENG-2496 — Zoma device-flow onboarding: security/auth invariants only.
 *  - expired device codes never progress or yield a token
 *  - a device_code yields its token once; a reused device_code yields nothing
 *  - polling faster than `interval` gets slow_down and a longer interval (RFC 8628 §3.5)
 *  - a revoked token is rejected by the Meta Toolkit gateway
 *  - an unbound (pending / denied / failed-consent) code never yields a token
 *  - only the token hash is persisted
 */
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

import {
  beginVerification,
  completeVerification,
  pollSetup,
  revokeZomaToken,
  sha256,
  startSetup,
  validateZomaToken,
  type ZomaDeviceFlowDeps,
} from '../mcp/zomaDeviceFlow';
import { DynamoZomaDeviceStore, type ZomaDeviceRecord, type ZomaDeviceStore, type ZomaTokenRecord } from '../mcp/zomaDeviceStore';
import { authenticateMetaToolkitCaller, MetaToolkitAuthError, type MetaToolkitGatewayDeps } from '../mcp/metaToolkitGateway';

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
}

const READY = { payment: { ready: true }, meta: { ready: true, accounts: [] }, writes_enabled: true, next_step: null };

function harness(over: Partial<ZomaDeviceFlowDeps> = {}) {
  let now = 1_800_000_000_000;
  const store = new MemoryStore();
  const deps: ZomaDeviceFlowDeps = {
    store,
    now: () => now,
    backendUrl: () => 'https://api.example.test',
    readiness: jest.fn().mockResolvedValue(READY),
    ensureClient: jest.fn().mockResolvedValue(undefined),
    consumeAuthCode: jest.fn().mockResolvedValue({ userId: 'user-1' }),
    principalAllowed: jest.fn().mockResolvedValue(true),
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
      readiness: jest.fn(async (_u: string, opts: { mintLinks: boolean }) => ({
        payment: { ready: false, ...(opts.mintLinks ? { link: 'https://checkout.stripe.test/setup' } : {}) },
        meta: { ready: true, accounts: [] },
        writes_enabled: false,
        next_step: 'x',
      })) as any,
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
