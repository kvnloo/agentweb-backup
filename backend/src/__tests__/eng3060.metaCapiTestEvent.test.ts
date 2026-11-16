// ENG-3060: Zoma Conversions API test event (mocked Graph; no network, no storage).
jest.mock('../services/agentApiKeyService', () => ({ agentApiKeyService: { validateKey: jest.fn() } }));
jest.mock('../mcp/oauth/oauthService', () => ({ mcpOAuthService: { validateAccessToken: jest.fn() } }));
jest.mock('../services/connectedAccountsDb', () => ({ getAccountsByUserIdIncludingOrgShared: jest.fn() }));
jest.mock('../services/mcpUsageEventsService', () => ({ recordMcpToolUse: jest.fn(), recordMcpWriteExecuted: jest.fn() }));
jest.mock('../services/agentModeService', () => ({ agentModeService: {} }));
jest.mock('../utils/scheduledPublishConsentGuard', () => ({
  refuseUnauthorizedScheduledPublish: jest.fn().mockResolvedValue(null),
  attachPublishRevalidation: (_: unknown, context: unknown) => context,
}));
jest.mock('../services/evaluationPolicy', () => ({ enforceEvaluationTool: jest.fn().mockResolvedValue(undefined) }));

import { createHash } from 'crypto';
import { handleMetaToolkitCall, MetaToolkitGatewayDeps } from '../mcp/metaToolkitGateway';
import { runMetaEventSourceTool, isMetaEventSourceWrite, MetaEventSourceDeps } from '../mcp/metaToolkitEventSources';
import { getMetaToolkitManifest } from '../mcp/metaToolkitManifest';

const TOOL = 'meta_send_test_event' as const;
const NOW = Date.parse('2026-11-11T12:00:00Z');
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const BASE = { pixel_id: '41', test_event_code: 'TEST123', event_name: 'Purchase', action_source: 'system_generated', user_data: { email: ' John_Smith@gmail.com ', phone: '+1 (650) 555-1212' } };

function graph(response: any = { events_received: 1, messages: [], fbtrace_id: 'trace1' }) {
  const writes: Array<{ method: string; path: string; params: Record<string, string> }> = [];
  const readGraph = jest.fn(async (_u: string, _a: string, path: string) => {
    if (path === 'act_111/adspixels') return { data: [{ id: '41', name: 'Live' }] };
    throw Object.assign(new Error('not found'), { metaError: { code: 100, message: 'not found' } });
  });
  const writeGraph = jest.fn(async (_u: string, _a: string, method: 'POST' | 'DELETE', path: string, params: Record<string, string>) => {
    writes.push({ method, path, params });
    if (response instanceof Error) throw response;
    return response;
  });
  const deps: MetaEventSourceDeps = { readGraph, writeGraph, secret: () => 's', now: () => NOW, consumedTokens: new Map(), tokenOutcomes: new Map() };
  return { deps, writes, readGraph };
}
const run = (args: any, deps: MetaEventSourceDeps) => runMetaEventSourceTool(TOOL, 'u', '111', args, deps) as Promise<any>;
async function confirmed(args: any, g: ReturnType<typeof graph>) {
  const preview = await run(args, g.deps);
  return run({ ...args, confirm: true, preview_token: preview.preview_token }, g.deps);
}

describe('ENG-3060 Conversions API test event', () => {
  it('is advertised and is a write', () => {
    expect(getMetaToolkitManifest().map((d: any) => d.name)).toContain(TOOL);
    expect(isMetaEventSourceWrite(TOOL)).toBe(true);
  });

  it('rejects a call without test_event_code before any Graph request', async () => {
    for (const code of [undefined, '', '   ', 42]) {
      const g = graph();
      await expect(run({ ...BASE, test_event_code: code }, g.deps)).rejects.toThrow(/test_event_code/);
      await expect(run({ ...BASE, test_event_code: code, confirm: true, preview_token: 'x' }, g.deps)).rejects.toThrow(/test_event_code/);
      expect(g.readGraph).not.toHaveBeenCalled();
      expect(g.writes).toEqual([]);
    }
  });

  it('rejects a dataset that is not in the selected ad account, with no Graph POST', async () => {
    const g = graph();
    await expect(run({ ...BASE, pixel_id: '99' }, g.deps)).rejects.toMatchObject({ forbidden: true });
    await expect(run({ ...BASE, pixel_id: '99', confirm: true, preview_token: 'x' }, g.deps)).rejects.toMatchObject({ forbidden: true });
    expect(g.writes).toEqual([]);
  });

  it('previews first, says test events count, and sends nothing until confirmed with the token', async () => {
    const g = graph();
    const preview = await run(BASE, g.deps);
    expect(preview.status).toBe('PREVIEW');
    expect(preview.preview).toMatch(/not dropped/i);
    expect(preview.preview).toMatch(/measurement/i);
    expect(JSON.stringify(preview)).not.toMatch(/john_smith|6505551212|555-1212|555 1212/i);
    expect(g.writes).toEqual([]);
    await expect(run({ ...BASE, confirm: true }, g.deps)).resolves.toMatchObject({ status: 'PREVIEW_MISMATCH' });
    await expect(run({ ...BASE, event_name: 'Lead', confirm: true, preview_token: preview.preview_token }, g.deps)).resolves.toMatchObject({ status: 'PREVIEW_MISMATCH' });
    expect(g.writes).toEqual([]);
  });

  it('sends one event with the code and hashed user data; reports what Meta returned', async () => {
    const g = graph();
    const out = await confirmed(BASE, g);
    expect(g.writes).toHaveLength(1);
    const { method, path, params } = g.writes[0];
    expect(method).toBe('POST');
    expect(path).toBe('41/events');
    expect(params.test_event_code).toBe('TEST123');
    const data = JSON.parse(params.data);
    expect(data).toHaveLength(1);
    // Meta's own documented examples (customer information parameters page).
    expect(data[0].user_data.em).toEqual(['62a14e44f765419d10fea99367361a727c12365e2520f32218d505ed9aa0f62f']);
    expect(data[0].user_data.ph).toEqual(['e323ec626319ca94ee8bff2e4c87cf613be6ea19919ed1364124e16807ab3176']);
    expect(data[0]).toMatchObject({ event_name: 'Purchase', action_source: 'system_generated', event_time: Math.floor(NOW / 1000) });
    expect(JSON.stringify(g.writes)).not.toMatch(/john_smith|555-1212|6505551212/i);
    expect(out).toMatchObject({ success: true, events_received: 1, fbtrace_id: 'trace1', messages: [], id: '41' });
    expect(out.message).toMatch(/does not show|not confirm/i);
    expect(JSON.stringify(out)).not.toMatch(/john_smith|555-1212|6505551212/i);
  });

  it('hashes external_id, keeps an already hashed value, and never hashes ip, user agent, fbc or fbp', async () => {
    const g = graph();
    const pre = sha('a@b.co');
    await confirmed({ ...BASE, action_source: 'website', event_source_url: 'https://example.com/x', user_data: { email: pre, external_id: 'User-7', client_ip_address: '168.212.226.204', client_user_agent: 'UA/1', fbc: 'fb.1.1.abc', fbp: 'fb.1.1.123' } }, g);
    const ud = JSON.parse(g.writes[0].params.data)[0].user_data;
    expect(ud).toEqual({ em: [pre], external_id: [sha('User-7')], client_ip_address: '168.212.226.204', client_user_agent: 'UA/1', fbc: 'fb.1.1.abc', fbp: 'fb.1.1.123' });
  });

  it('refuses unknown user_data keys, empty user_data and a website event without a URL, before any send', async () => {
    const g = graph();
    await expect(run({ ...BASE, user_data: { email: 'a@b.co', ssn: '1' } }, g.deps)).rejects.toThrow(/ssn/);
    await expect(run({ ...BASE, user_data: {} }, g.deps)).rejects.toThrow(/user_data/);
    await expect(run({ ...BASE, user_data: { email: 'not-an-email' } }, g.deps)).rejects.toThrow(/email/);
    await expect(run({ ...BASE, action_source: 'website' }, g.deps)).rejects.toThrow(/event_source_url/);
    expect(g.writes).toEqual([]);
  });

  it('passes a Meta error through as FAILED and an unanswered send as UNCONFIRMED', async () => {
    const refused = graph(Object.assign(new Error('Invalid parameter'), { metaError: { code: 100, error_subcode: 2804050, message: 'Invalid parameter' }, outcomeUnknown: false }));
    await expect(confirmed(BASE, refused)).resolves.toMatchObject({ status: 'FAILED', success: false, message: expect.stringContaining('Invalid parameter'), meta_error: { code: 100, error_subcode: 2804050 } });
    const lost = graph(Object.assign(new Error('timeout'), { metaError: null, outcomeUnknown: true }));
    await expect(confirmed(BASE, lost)).resolves.toMatchObject({ success: false, verification: 'UNCONFIRMED' });
  });

  it('does not report success when Meta answers without events_received', async () => {
    const g = graph({ fbtrace_id: 't' });
    await expect(confirmed(BASE, g)).resolves.toMatchObject({ success: false, verification: 'MISMATCH' });
  });

  it('a used token never sends a second event', async () => {
    const g = graph();
    const preview = await run(BASE, g.deps);
    const args = { ...BASE, confirm: true, preview_token: preview.preview_token };
    await run(args, g.deps);
    await run(args, g.deps);
    expect(g.writes).toHaveLength(1);
  });
});

describe('ENG-3060 gateway: scope, 403 and metering', () => {
  const accounts = [{ platform: 'meta', account_id: '111', config: { account_type: 'ad_account', ad_account_id: '111', access_token: 'x' } }];
  function gateway(scopes: string[], runEventSourceTool: jest.Mock) {
    const raw = {
      validateApiKey: jest.fn().mockResolvedValue({ userId: 'u1', keyId: 'k1', scopes }),
      validateOAuthToken: jest.fn(),
      listAccounts: jest.fn().mockResolvedValue(accounts),
      execute: jest.fn(),
      recordUsage: jest.fn().mockResolvedValue(undefined),
      recordWrite: jest.fn().mockResolvedValue(undefined),
      now: () => NOW,
      rateLimiter: { check: () => ({ allowed: true, remaining: 1, resetInMs: 0 }) },
      runEventSourceTool,
    };
    return { raw, deps: raw as unknown as MetaToolkitGatewayDeps };
  }
  const call = (deps: MetaToolkitGatewayDeps) => handleMetaToolkitCall({ authorization: 'Bearer aw_fixture', toolName: TOOL, args: BASE }, deps);

  it('a read-only key is rejected before the tool runs', async () => {
    const g = gateway(['tools:read'], jest.fn());
    await expect(call(g.deps)).rejects.toMatchObject({ status: 403 });
    expect(g.raw.runEventSourceTool).not.toHaveBeenCalled();
  });

  it('a foreign dataset surfaces as 403', async () => {
    const real = graph();
    const g = gateway(['tools:read', 'tools:execute'], jest.fn((n, u, a, args) => runMetaEventSourceTool(n, u, a, { ...args, pixel_id: '99' }, real.deps)));
    await expect(call(g.deps)).rejects.toMatchObject({ status: 403 });
    expect(real.writes).toEqual([]);
  });

  it('an executed send is recorded as one write', async () => {
    const g = gateway(['tools:read', 'tools:execute'], jest.fn().mockResolvedValue({ success: true, verification: 'CONFIRMED', id: '41' }));
    await call(g.deps);
    expect(g.raw.recordWrite).toHaveBeenCalledTimes(1);
    expect(g.raw.recordWrite).toHaveBeenCalledWith(expect.objectContaining({ entityType: 'DATASET_TEST_EVENT', action: 'CREATE', verification: 'CONFIRMED' }));
  });
});
