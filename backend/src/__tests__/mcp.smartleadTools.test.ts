/**
 * Smartlead tools for outside agents over MCP (mcp/server/smartleadTools.ts). Contract:
 *  - each tool calls the portal's own route with the arguments it was given, checked first;
 *  - a preview never hands the agent the signed token or fingerprint that /start accepts, and points to where a person approves;
 *  - start, resume and release are not on MCP at all;
 *  - only an aw_ key holding the scope may call them: default keys, OAuth (marketplace clients included) and anonymous callers are refused;
 *  - tools/list shows them only to a key holding the scope.
 */
const mockFetch = jest.fn();
jest.mock('../mcp/server/httpClient', () => ({ mcpFetch: (...a: any[]) => mockFetch(...a) }));
jest.mock('../services/evaluationPolicy', () => ({ enforceEvaluationTool: jest.fn(async () => undefined) }));
jest.mock('../services/funding/runFunding', () => ({
  currentRunFunding: () => ({ source: 'test' }),
  resolveRunFunding: jest.fn(),
  withRunFunding: (_f: unknown, fn: () => unknown) => fn(),
}));
jest.mock('../utils/scheduledPublishConsentGuard', () => ({
  refuseUnauthorizedScheduledPublish: jest.fn(async () => null),
  attachPublishRevalidation: (_n: string, c: unknown) => c,
}));

import { mcpToolRegistry } from '../mcp/server/registry';
import { SMARTLEAD_TOOLS_NOT_ON_MCP, listPushLink } from '../mcp/server/smartleadTools';
import { findScopeDenial, findApiKeyOnlyToolCall, DEFAULT_API_KEY_SCOPES } from '../mcp/server/apiKeyScopes';
import { getListedToolDefinitions } from '../mcp/server/toolDiscovery';

const KEY = { userId: 'u-1', externalMcp: true, authMethod: 'api_key', apiKeyId: 'k-1' };
const call = (name: string, args: unknown, context: any = KEY) => mcpToolRegistry.execute(name, args, context);
const parsed = (r: any) => JSON.parse(r.content[0].text);
const toolsCall = (name: string) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } });
const lookup = (name: string) => mcpToolRegistry.getTool(name);
const RUN = 'abcdefghij1234567890';

const READ_TOOLS = ['list_smartlead_campaigns', 'get_smartlead_campaign_stats', 'preview_smartlead_push', 'get_smartlead_push_status'];
const CONTROL_TOOLS = ['pause_smartlead_push', 'cancel_smartlead_push'];

beforeEach(() => {
  mockFetch.mockReset();
  jest.spyOn(console, 'info').mockImplementation(() => {});
});

describe('which tools exist on MCP', () => {
  it('registers the read and stop tools', () => {
    for (const n of [...READ_TOOLS, ...CONTROL_TOOLS]) expect(lookup(n)).toBeDefined();
  });

  it('never registers start, resume or release', () => {
    for (const n of SMARTLEAD_TOOLS_NOT_ON_MCP) expect(lookup(n)).toBeUndefined();
    expect(mcpToolRegistry.getToolNames().filter((n) => n.includes('smartlead')).sort()).toEqual([...READ_TOOLS, ...CONTROL_TOOLS].sort());
  });

  it('read tools are read-only with smartlead:read; pause and cancel need smartlead:control; all are API-key only', () => {
    for (const n of READ_TOOLS) expect(lookup(n)).toMatchObject({ readOnly: true, requiredScope: 'smartlead:read', apiKeyOnly: true, requiresUserAccount: true });
    for (const n of CONTROL_TOOLS) expect(lookup(n)).toMatchObject({ readOnly: false, requiredScope: 'smartlead:control', apiKeyOnly: true, requiresUserAccount: true });
  });
});

describe('who may call them', () => {
  it('a default key (tools:read + tools:execute) is refused every Smartlead tool at the HTTP layer', () => {
    for (const n of [...READ_TOOLS, ...CONTROL_TOOLS]) {
      expect(findScopeDenial(toolsCall(n), [...DEFAULT_API_KEY_SCOPES], lookup)).toEqual({ tool: n, requiredScope: lookup(n)!.requiredScope });
    }
  });

  it('smartlead:read allows the reads but not pause or cancel; smartlead:control the reverse', () => {
    for (const n of READ_TOOLS) expect(findScopeDenial(toolsCall(n), ['smartlead:read'], lookup)).toBeNull();
    for (const n of CONTROL_TOOLS) expect(findScopeDenial(toolsCall(n), ['smartlead:read'], lookup)).not.toBeNull();
    for (const n of CONTROL_TOOLS) expect(findScopeDenial(toolsCall(n), ['smartlead:control'], lookup)).toBeNull();
    for (const n of READ_TOOLS) expect(findScopeDenial(toolsCall(n), ['smartlead:control'], lookup)).not.toBeNull();
  });

  it('anonymous callers are refused at the HTTP layer', () => {
    expect(findApiKeyOnlyToolCall(toolsCall('pause_smartlead_push'), lookup)).toEqual({ tool: 'pause_smartlead_push', requiredScope: 'smartlead:control' });
  });

  it('a signed-in OAuth client (e.g. a marketplace client) is refused before anything is fetched', async () => {
    for (const n of [...READ_TOOLS, ...CONTROL_TOOLS]) {
      await expect(call(n, { runId: RUN }, { userId: 'u-1', externalMcp: true, authMethod: 'oauth' })).rejects.toThrow(/API key/);
    }
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('an anonymous session gets the account refusal, not a fetch', async () => {
    const r = await call('list_smartlead_campaigns', {}, { userId: 'anon_123', externalMcp: true, authMethod: 'api_key' });
    expect(JSON.stringify(r)).toMatch(/account|sign/i);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('Emma in-process calls (no externalMcp) are not affected by the API-key gate', async () => {
    mockFetch.mockResolvedValue({ connection: { id: 'c' }, campaigns: [] });
    await expect(call('list_smartlead_campaigns', {}, { userId: 'u-1' })).resolves.toBeDefined();
  });
});

describe('tools/list', () => {
  const names = (scopes?: string[]) => getListedToolDefinitions(scopes).map((d: any) => d.name);
  it('lists nothing Smartlead for a default key or OAuth', () => {
    expect(names([...DEFAULT_API_KEY_SCOPES]).filter((n) => n.includes('smartlead'))).toEqual([]);
    expect(names(['email:read']).filter((n) => n.includes('smartlead'))).toEqual([]);
  });
  it('lists the reads (and list_lead_lists for the listId) for smartlead:read, and the stops for smartlead:control', () => {
    expect(names(['smartlead:read'])).toEqual(expect.arrayContaining([...READ_TOOLS, 'list_lead_lists'].filter((n) => lookup(n))));
    expect(names(['smartlead:read'])).not.toContain('pause_smartlead_push');
    expect(names(['smartlead:control'])).toEqual(expect.arrayContaining([...CONTROL_TOOLS, 'get_smartlead_push_status']));
  });
});

describe('what each tool does', () => {
  it('list_smartlead_campaigns reads the campaigns route', async () => {
    mockFetch.mockResolvedValue({ connection: { accountId: 'a' }, campaigns: [{ id: 1, name: 'C', status: 'ACTIVE', pushable: true }] });
    const out = parsed(await call('list_smartlead_campaigns', { accountId: 'acc-1' }));
    expect(mockFetch).toHaveBeenCalledWith(expect.objectContaining({ method: 'GET', path: '/api/crm/smartlead-push/campaigns', queryParams: { accountId: 'acc-1' } }));
    expect(out).toEqual({ smartleadAccount: { accountId: 'a' }, campaigns: [{ id: 1, name: 'C', status: 'ACTIVE', pushable: true }] });
  });

  it('get_smartlead_campaign_stats reads the stats route and reports Smartlead counts only', async () => {
    mockFetch.mockResolvedValue({ connection: {}, stats: { campaignId: 7, name: 'C', status: 'ACTIVE', contactsEmailed: 3, emailsSent: 5, replies: 1, bounces: 0, unsubscribes: 0, opens: 99 } });
    const out = parsed(await call('get_smartlead_campaign_stats', { campaignId: '7' }));
    expect(mockFetch).toHaveBeenCalledWith(expect.objectContaining({ method: 'GET', path: '/api/crm/smartlead-push/campaigns/7/stats' }));
    expect(out.stats).toEqual({ contactsEmailed: 3, emailsSent: 5, replies: 1, bounces: 0, unsubscribes: 0 });
    expect(out.campaign).toEqual({ id: 7, name: 'C', status: 'ACTIVE' });
  });

  it('preview_smartlead_push never returns the token or fingerprint, and says where a person approves', async () => {
    mockFetch.mockResolvedValue({
      preview: {
        token: 'SIGNED-TOKEN', fingerprint: 'FP', campaign: { id: 7 }, connection: { accountId: 'a' }, sequence: { stepCount: 2 },
        list: { listId: 'L1', total: 10 }, cohort: { size: 5 },
        preflight: { blocks: [], warnings: [], tagsToMap: [] }, canStart: true, requiresActiveConfirmation: false, requiresUnsubscribeAcknowledgement: true,
      },
    });
    const r = await call('preview_smartlead_push', { listId: 'L1', campaignId: 7, cohort: 5 });
    const text = r.content[0].text;
    expect(text).not.toContain('SIGNED-TOKEN');
    expect(text).not.toContain('FP');
    expect(text).not.toMatch(/"token"|"fingerprint"/);
    const out = JSON.parse(text);
    expect(out.approveIn).toBe(listPushLink('L1'));
    expect(out.nextStep).toMatch(/Nothing was pushed/);
    expect(out.preview).toMatchObject({ canStart: true, sendingWithNoUnsubscribeLink: true, emailStepsInCampaignSequence: 2 });
    expect(mockFetch).toHaveBeenCalledWith(expect.objectContaining({
      method: 'POST', path: '/api/crm/smartlead-push/preview',
      body: { listId: 'L1', campaignId: 7, includeUnverified: false, mapping: {}, acknowledgedTags: [], cohort: 5 },
    }));
  });

  it('get_smartlead_push_status reads one run or a list history', async () => {
    mockFetch.mockResolvedValue({ run: { runId: RUN } });
    await call('get_smartlead_push_status', { runId: RUN });
    expect(mockFetch).toHaveBeenLastCalledWith(expect.objectContaining({ method: 'GET', path: `/api/crm/smartlead-push/runs/${RUN}` }));
    await call('get_smartlead_push_status', { listId: 'L1' });
    expect(mockFetch).toHaveBeenLastCalledWith(expect.objectContaining({ method: 'GET', path: '/api/crm/smartlead-push/lists/L1/runs' }));
    await expect(call('get_smartlead_push_status', {})).rejects.toThrow(/runId or a listId/);
  });

  it.each(['pause', 'cancel'])('%s_smartlead_push posts to the run', async (action) => {
    mockFetch.mockResolvedValue({ run: { runId: RUN, status: action } });
    await call(`${action}_smartlead_push`, { runId: RUN });
    expect(mockFetch).toHaveBeenCalledWith(expect.objectContaining({ method: 'POST', path: `/api/crm/smartlead-push/runs/${RUN}/${action}` }));
  });

  it('refuses bad arguments before any request', async () => {
    await expect(call('pause_smartlead_push', { runId: '../../start' })).rejects.toThrow(/runId/);
    await expect(call('get_smartlead_push_status', { listId: 'a/b' })).rejects.toThrow(/listId/);
    await expect(call('get_smartlead_campaign_stats', { campaignId: -1 })).rejects.toThrow(/campaignId/);
    await expect(call('preview_smartlead_push', { listId: 'L1', campaignId: 7, token: 'x' })).rejects.toThrow(/Invalid/);
    await expect(call('list_smartlead_campaigns', { userId: 'someone-else' })).rejects.toThrow(/Invalid/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('passes a route refusal through as the tool error', async () => {
    mockFetch.mockRejectedValue(new Error('API error (503): Pushing to Smartlead is turned off.'));
    await expect(call('list_smartlead_campaigns', {})).rejects.toThrow(/turned off/);
  });
});
