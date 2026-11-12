/**
 * ENG-2867: aw_-key MCP tools for own CRM lead-list export + export history.
 * Pins: runtime identity only (no client_id/user override), foreign-list
 * denial surfaces from the route, list_id is path-encoded, and scopes follow
 * apiKeyScopes.ts (export = tools:execute, history = tools:read).
 */
const mockMcpFetch = jest.fn();
jest.mock('../httpClient', () => ({ mcpFetch: (...args: any[]) => mockMcpFetch(...args) }));
jest.mock('../../../services/evaluationPolicy', () => ({ enforceEvaluationTool: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../../services/funding/runFunding', () => ({
  currentRunFunding: () => ({ source: 'test' }),
  resolveRunFunding: jest.fn(),
  withRunFunding: (_f: any, fn: () => any) => fn(),
}));

import { mcpToolRegistry } from '../registry';
import '../apiTools';
import { DEFAULT_API_KEY_SCOPES, findScopeDenial } from '../apiKeyScopes';

const lookup = (name: string) => mcpToolRegistry.getTool(name);
const call = (name: string) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } });
const API_KEY_CTX = { userId: 'owner-1', externalMcp: true, isInternal: false, authMethod: 'api_key', apiKeyId: 'k1' };

function run(name: string, args: any, context: any = API_KEY_CTX) {
  return mcpToolRegistry.getTool(name)!.execute(args, context);
}

beforeEach(() => jest.clearAllMocks());

describe('export_lead_list', () => {
  it('exports an own list via the existing export route with the caller identity', async () => {
    const exportEntry = { exportId: 'exp_1', recordCount: 3, filename: 'a.csv', fileUrl: 'https://s3/a.csv' };
    mockMcpFetch.mockResolvedValue({ success: true, export: exportEntry });
    const res: any = await run('export_lead_list', { list_id: 'list-1' });
    expect(mockMcpFetch).toHaveBeenCalledWith(expect.objectContaining({
      method: 'POST', path: '/api/crm/lists/list-1/leads/export',
      context: expect.objectContaining({ userId: 'owner-1' }),
    }));
    expect(JSON.parse(res.content[0].text).export).toEqual(exportEntry);
  });

  it('ignores client_id / user_id overrides and keeps the key owner identity', async () => {
    mockMcpFetch.mockResolvedValue({ success: true });
    await run('export_lead_list', { list_id: 'list-1', client_id: 'victim', user_id: 'victim' });
    const sent = mockMcpFetch.mock.calls[0][0];
    expect(sent.context.userId).toBe('owner-1');
    expect(JSON.stringify(sent)).not.toContain('victim');
  });

  it('denies a list owned by another account (route 403 propagates, no result)', async () => {
    mockMcpFetch.mockRejectedValue(new Error('API error (403): Editor access required'));
    await expect(run('export_lead_list', { list_id: 'foreign-list' })).rejects.toThrow('403');
  });

  it('path-encodes list_id so it cannot reach another route', async () => {
    mockMcpFetch.mockResolvedValue({});
    await run('export_lead_list', { list_id: '../../users/x' });
    expect(mockMcpFetch.mock.calls[0][0].path).toBe('/api/crm/lists/..%2F..%2Fusers%2Fx/leads/export');
  });

  it('rejects a missing list_id without calling the API', async () => {
    const res: any = await run('export_lead_list', {});
    expect(res.content[0].text).toContain('list_id is required');
    expect(mockMcpFetch).not.toHaveBeenCalled();
  });
});

describe('list_lead_list_exports', () => {
  it('returns history from the existing route (route-sanitized fileUrls pass through untouched)', async () => {
    const history = [{ exportId: 'exp_1', fileUrl: null, restricted: true }];
    mockMcpFetch.mockResolvedValue({ history });
    const res: any = await run('list_lead_list_exports', { list_id: 'list-1', client_id: 'victim' });
    const sent = mockMcpFetch.mock.calls[0][0];
    expect(sent).toMatchObject({ method: 'GET', path: '/api/crm/lists/list-1/export-history' });
    expect(sent.context.userId).toBe('owner-1');
    expect(JSON.parse(res.content[0].text).history).toEqual(history);
  });

  it('denies a foreign list', async () => {
    mockMcpFetch.mockRejectedValue(new Error('API error (403): sharing disabled'));
    await expect(run('list_lead_list_exports', { list_id: 'foreign' })).rejects.toThrow('403');
  });
});

describe('scopes', () => {
  it('both tools are callable with default aw_ scopes', () => {
    expect(findScopeDenial(call('export_lead_list'), DEFAULT_API_KEY_SCOPES, lookup)).toBeNull();
    expect(findScopeDenial(call('list_lead_list_exports'), DEFAULT_API_KEY_SCOPES, lookup)).toBeNull();
  });

  it('a tools:read-only key may read history but not export (export writes S3 + history)', () => {
    expect(findScopeDenial(call('list_lead_list_exports'), ['tools:read'], lookup)).toBeNull();
    expect(findScopeDenial(call('export_lead_list'), ['tools:read'], lookup)).toMatchObject({ requiredScope: 'tools:execute' });
  });
});
