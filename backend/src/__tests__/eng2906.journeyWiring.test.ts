/**
 * ENG-2906 PR1 — capture is wired end to end, not helper-only:
 *   - every MCP usage event carries dimensions.product (zoma | emma_mcp | emma_web | unknown)
 *   - the Meta Toolkit gateway (Meta + zoma_ token) meters as zoma and emits first_read / first_write
 *   - POST /api/zoma/setup carries a validated ref through the device record into the OAuth
 *     authorize URL (with the Zoma MCP resource) and the signup attribution; the anonymous
 *     setup id is aliased onto the user at approval
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'eng-2906-test-secret';

const mockJourney = {
  trackJourney: jest.fn().mockResolvedValue(undefined),
  identifyJourney: jest.fn().mockResolvedValue(undefined),
  aliasJourney: jest.fn().mockResolvedValue(undefined),
  anonymousSetupId: (id: string) => `zoma_setup_${id.slice(0, 4)}`,
};
jest.mock('../services/journeyTracking', () => mockJourney);
const mockAttr = {
  recordSignupAttribution: jest.fn().mockResolvedValue(true),
  touchProduct: jest.fn().mockResolvedValue('touched'),
  advanceZomaStage: jest.fn().mockResolvedValue(true),
  markZomaMilestone: jest.fn().mockResolvedValue(true),
};
jest.mock('../services/journeyAttribution', () => ({ ...jest.requireActual('../services/journeyAttribution'), journeyAttribution: mockAttr }));

jest.mock('../mcp/oauth/oauthService', () => ({ mcpOAuthService: {} }));
// Keep real rate-limit behavior without process-lifetime cleanup timers in this scoped suite.
jest.mock('../middleware/rateLimiter', () => {
  const actual = jest.requireActual('../middleware/rateLimiter');
  actual.rateLimiter?.destroy();
  return { ...actual, RateLimiter: class extends actual.RateLimiter {
    constructor(...args: any[]) { super(...args); this.destroy(); }
  } };
});
jest.mock('../mcp/zomaOnboarding', () => ({ getZomaReadiness: jest.fn(), runZomaTool: jest.fn(), ZomaNotReadyError: class extends Error {} }));
jest.mock('../services/agentApiKeyService', () => ({ agentApiKeyService: {} }));
jest.mock('../services/connectedAccountsDb', () => ({ getAccountsByUserIdIncludingOrgShared: jest.fn() }));
jest.mock('../mcp/metaToolkitManifest', () => ({
  MetaToolkitRefusal: class extends Error {},
  executeMetaToolkitCall: jest.fn(),
  getMetaToolkitManifest: () => [{ name: 'meta_insights', inputSchema: { properties: { account_id: {} } } }],
}));
jest.mock('../mcp/metaToolkitWrites', () => ({ executeMetaToolkitWrite: jest.fn(), isGuardedWriteRequest: (_n: string, a: any) => a?.action === 'CREATE' }));
jest.mock('../mcp/metaToolkitCreatives', () => ({ executeMetaToolkitCreative: jest.fn(), isCreativeAssetRequest: () => false, prepareZomaUpload: jest.fn() }));
jest.mock('../mcp/zomaProviders', () => ({
  googleToolkitEnabled: () => false,
  META_PROVIDER: 'meta',
  resolveProviderAccount: () => ({ ok: true, accountId: 'act_1' }),
}));

import {
  recordMcpConnectionAttempt,
  recordMcpFirstToolUse,
  recordMcpOAuthAuthorized,
  recordMcpOAuthStarted,
  recordMcpOAuthTokenIssued,
  recordMcpToolUse,
  recordMcpWriteExecuted,
  type McpUsageEventStore,
} from '../services/mcpUsageEventsService';
import { handleMetaToolkitCall, type MetaToolkitGatewayDeps } from '../mcp/metaToolkitGateway';
import { beginVerification, completeVerification, startSetup, type ZomaDeviceFlowDeps } from '../mcp/zomaDeviceFlow';
import type { ZomaDeviceRecord } from '../mcp/zomaDeviceStore';
import { noteSignup, zomaMilestone } from '../services/journeyMilestones';

const flush = () => new Promise((r) => setImmediate(r));

beforeEach(() => jest.clearAllMocks());

describe('ENG-2906 usage events carry dimensions.product', () => {
  const store = (): McpUsageEventStore & { items: any[] } => {
    const items: any[] = [];
    return { items, put: async (item) => { items.push(item); }, queryByLoopId: async () => [] };
  };

  it('stamps the given product on every event kind', async () => {
    const s = store();
    await recordMcpOAuthStarted({ clientId: 'c', product: 'zoma' }, s);
    await recordMcpOAuthAuthorized({ userId: 'u', clientId: 'c', product: 'zoma' }, s);
    await recordMcpOAuthTokenIssued({ userId: 'u', clientId: 'c', product: 'emma_mcp' }, s);
    await recordMcpConnectionAttempt({ userId: 'u', product: 'emma_mcp' }, s);
    await recordMcpToolUse({ userId: 'u', toolName: 't', product: 'zoma' }, s);
    await recordMcpFirstToolUse({ userId: 'u', toolName: 't', product: 'emma_mcp' }, s);
    await recordMcpWriteExecuted({ userId: 'u', toolName: 't', product: 'zoma', entityType: 'AD', action: 'CREATE', verification: 'CONFIRMED' }, s);
    expect(s.items.map((i) => i.dimensions.product)).toEqual(['zoma', 'zoma', 'emma_mcp', 'emma_mcp', 'zoma', 'emma_mcp', 'zoma']);
  });

  it('defaults to unknown instead of guessing, and drops an invalid product', async () => {
    const s = store();
    await recordMcpToolUse({ userId: 'u', toolName: 't' }, s);
    await recordMcpToolUse({ userId: 'u', toolName: 't', product: 'evil' as any }, s);
    expect(s.items.map((i) => i.dimensions.product)).toEqual(['unknown', 'unknown']);
  });

  it('records a validated ref on the connection attempt and drops an invalid one', async () => {
    const s = store();
    await recordMcpConnectionAttempt({ userId: 'u', product: 'emma_mcp', ref: 'docs' }, s);
    await recordMcpConnectionAttempt({ userId: 'u', product: 'emma_mcp', ref: 'BAD REF' }, s);
    expect(s.items[0].dimensions.ref).toBe('docs');
    expect(s.items[1].dimensions.ref).toBeUndefined();
  });
});

describe('ENG-2906 Meta Toolkit gateway meters as zoma', () => {
  const gatewayDeps = (overrides: Partial<MetaToolkitGatewayDeps> = {}): MetaToolkitGatewayDeps => ({
    validateApiKey: jest.fn(),
    validateOAuthToken: jest.fn(),
    validateZomaToken: jest.fn().mockResolvedValue({ userId: 'u1', tokenId: 't1' }),
    listAccounts: jest.fn().mockResolvedValue([]),
    execute: jest.fn().mockResolvedValue({ data: [] }) as any,
    recordUsage: jest.fn().mockResolvedValue(true),
    recordWrite: jest.fn().mockResolvedValue(true),
    executeWrite: jest.fn().mockResolvedValue({ verification: 'CONFIRMED', id: '1' }),
    now: () => Date.now(),
    rateLimiter: { check: () => ({ allowed: true, remaining: 1, resetInMs: 0 }) } as any,
    ...overrides,
  });

  it('a zoma_ token read is metered with product zoma and advances first_read', async () => {
    const deps = gatewayDeps();
    await handleMetaToolkitCall({ authorization: `Bearer zoma_${'x'.repeat(43)}`, toolName: 'meta_insights', args: {} }, deps);
    expect((deps.recordUsage as jest.Mock).mock.calls[0][0]).toMatchObject({ product: 'zoma', platform: 'meta' });
    await flush();
    expect(mockAttr.touchProduct).toHaveBeenCalledWith('u1', 'zoma');
    expect(mockAttr.advanceZomaStage).toHaveBeenCalledWith('u1', 'first_read');
    expect(mockAttr.markZomaMilestone).toHaveBeenCalledWith('u1', 'first_read');
    expect(mockJourney.trackJourney).toHaveBeenCalledWith({ userId: 'u1' }, 'first_read', expect.objectContaining({ product: 'zoma', platform: 'meta' }));
  });

  it('first_read is not re-emitted once its milestone is already recorded', async () => {
    mockAttr.markZomaMilestone.mockResolvedValueOnce(false);
    await handleMetaToolkitCall({ authorization: `Bearer zoma_${'x'.repeat(43)}`, toolName: 'meta_insights', args: {} }, gatewayDeps());
    await flush();
    expect(mockJourney.trackJourney).not.toHaveBeenCalledWith(expect.anything(), 'first_read', expect.anything());
  });

  it('first_write before first_read does not suppress first_read: emitted once although the stage cannot move back', async () => {
    // Stage is already first_write, so the forward-only stage write fails for first_read...
    mockAttr.advanceZomaStage.mockResolvedValueOnce(false);
    // ...but the first_read milestone field has never been set.
    mockAttr.markZomaMilestone.mockResolvedValueOnce(true);
    await handleMetaToolkitCall({ authorization: `Bearer zoma_${'x'.repeat(43)}`, toolName: 'meta_insights', args: {} }, gatewayDeps());
    await flush();
    expect(mockJourney.trackJourney).toHaveBeenCalledWith({ userId: 'u1' }, 'first_read', expect.objectContaining({ product: 'zoma' }));
    expect(mockJourney.identifyJourney).not.toHaveBeenCalledWith('u1', { zomaStage: 'first_read' });
  });

  it('an executed write is recorded with product zoma and emits first_write', async () => {
    const deps = gatewayDeps();
    await handleMetaToolkitCall({ authorization: `Bearer zoma_${'x'.repeat(43)}`, toolName: 'meta_campaigns', args: { action: 'CREATE', entity_type: 'CAMPAIGN' } }, deps);
    expect((deps.recordWrite as jest.Mock).mock.calls[0][0]).toMatchObject({ product: 'zoma' });
    await flush();
    expect(mockAttr.advanceZomaStage).toHaveBeenCalledWith('u1', 'first_write');
    expect(mockJourney.trackJourney).toHaveBeenCalledWith({ userId: 'u1' }, 'first_write', expect.objectContaining({ product: 'zoma' }));
    expect(mockJourney.trackJourney).not.toHaveBeenCalledWith(expect.anything(), 'first_read', expect.anything());
  });

  it('journey failures never fail the tool call', async () => {
    mockAttr.advanceZomaStage.mockRejectedValueOnce(new Error('dynamo down'));
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(
      handleMetaToolkitCall({ authorization: `Bearer zoma_${'x'.repeat(43)}`, toolName: 'meta_insights', args: {} }, gatewayDeps()),
    ).resolves.toBeDefined();
    await flush();
  });
});

describe('ENG-2906 Zoma device setup ref + journey', () => {
  function flowDeps(): ZomaDeviceFlowDeps & { devices: Map<string, ZomaDeviceRecord> } {
    const devices = new Map<string, ZomaDeviceRecord>();
    const codes = new Map<string, string>();
    return {
      devices,
      store: {
        createDevice: async (r: ZomaDeviceRecord) => { devices.set(r.deviceId, { ...r }); codes.set(r.userCode, r.deviceId); return true; },
        getDevice: async (id: string) => (devices.get(id) ? { ...devices.get(id)! } : null),
        getDeviceIdByUserCode: async (c: string) => codes.get(c) ?? null,
        resolveDevice: async (id: string, o: any) => { Object.assign(devices.get(id)!, o); return true; },
        appendEvent: async () => undefined,
      } as any,
      now: () => Date.now(),
      backendUrl: () => 'https://api.agentweb.pro',
      ensureClient: jest.fn().mockResolvedValue(undefined),
      consumeAuthCode: jest.fn().mockResolvedValue({ userId: 'u7' }),
    } as any;
  }

  it('stores a valid ref, emits setup_started anonymously, and forwards resource + ref to authorize', async () => {
    const deps = flowDeps();
    const started = await startSetup(deps, { ref: 'hn_launch' });
    const device = [...deps.devices.values()][0];
    expect(device.ref).toBe('hn_launch');
    expect(mockJourney.trackJourney).toHaveBeenCalledWith(
      { anonId: `zoma_setup_${device.deviceId.slice(0, 4)}` }, 'setup_started', expect.objectContaining({ product: 'zoma', ref: 'hn_launch' }),
    );
    const begin = await beginVerification(started.user_code, deps);
    expect(begin.ok).toBe(true);
    const url = new URL((begin as any).redirect);
    expect(url.searchParams.get('resource')).toBe('https://api.agentweb.pro/api/meta-toolkit/mcp');
    expect(url.searchParams.get('ref')).toBe('hn_launch');
  });

  it('drops an invalid ref silently (setup still starts)', async () => {
    const deps = flowDeps();
    await startSetup(deps, { ref: 'NOT OK' });
    expect([...deps.devices.values()][0].ref).toBeUndefined();
  });

  it('on approval: aliases the anon id, attributes a zoma_device signup with the ref, and advances signed_up', async () => {
    const deps = flowDeps();
    await startSetup(deps, { ref: 'hn_launch' });
    const device = [...deps.devices.values()][0];
    const out = await completeVerification({ code: 'c', state: device.deviceId }, deps);
    expect(out.ok).toBe(true);
    await flush();
    expect(mockJourney.aliasJourney).toHaveBeenCalledWith('u7', `zoma_setup_${device.deviceId.slice(0, 4)}`);
    expect(mockAttr.recordSignupAttribution).toHaveBeenCalledWith(
      'u7',
      { product: 'zoma', path: 'zoma_device', client: 'zoma_device', ref: 'hn_launch', confidence: 'explicit' },
      { requireSignupSource: 'mcp' },
    );
    expect(mockAttr.touchProduct).toHaveBeenCalledWith('u7', 'zoma');
    expect(mockAttr.advanceZomaStage).toHaveBeenCalledWith('u7', 'signed_up');
  });
});

describe('ENG-2906 noteSignup', () => {
  it('a zoma signup advances zomaStage to signed_up and reports confidence as tracked', async () => {
    await expect(
      noteSignup('u9', { product: 'zoma', path: 'oauth_direct', client: 'claude_code', ref: 'hn', confidence: 'explicit' }),
    ).resolves.toBe(true);
    expect(mockAttr.advanceZomaStage).toHaveBeenCalledWith('u9', 'signed_up');
    expect(mockJourney.identifyJourney).toHaveBeenCalledWith('u9', expect.objectContaining({ signupProduct: 'zoma', attributionConfidence: 'tracked' }));
    expect(mockJourney.trackJourney).toHaveBeenCalledWith({ userId: 'u9' }, 'signed_up', expect.objectContaining({ confidence: 'tracked' }));
    // signed_up is emitted once by noteSignup itself, not again by the stage move.
    expect(mockJourney.trackJourney.mock.calls.filter((c) => c[1] === 'signed_up')).toHaveLength(1);
  });

  it('a non-zoma signup does not touch zomaStage', async () => {
    await noteSignup('u9', { product: 'emma_mcp', path: 'oauth_direct', client: 'claude_code', confidence: 'explicit' });
    expect(mockAttr.advanceZomaStage).not.toHaveBeenCalled();
  });

  it('a signup that was not written (already attributed / not a consent-page account) emits nothing', async () => {
    mockAttr.recordSignupAttribution.mockResolvedValueOnce(false);
    await expect(noteSignup('u9', { product: 'zoma', path: 'oauth_direct', client: 'x', confidence: 'explicit' })).resolves.toBe(false);
    expect(mockJourney.trackJourney).not.toHaveBeenCalled();
    expect(mockAttr.advanceZomaStage).not.toHaveBeenCalled();
  });

  it('card_saved (no milestone field) keeps stage-based if_advanced semantics', async () => {
    mockAttr.advanceZomaStage.mockResolvedValueOnce(false);
    await zomaMilestone('u9', 'card_saved', { emit: 'if_advanced', requireZoma: true });
    expect(mockAttr.markZomaMilestone).not.toHaveBeenCalled();
    expect(mockJourney.trackJourney).not.toHaveBeenCalled();
  });
});
