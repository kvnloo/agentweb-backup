/**
 * ENG-1628: resolve_landing_page_by_url returns typed results for ordinary
 * outcomes (found / not_found / invalid_url) and a specifically-named error for
 * genuine faults — never a bare `Error`. Disposable fixtures only; no customer pages.
 */

jest.mock('../mcp/server/httpClient', () => ({
  mcpFetch: jest.fn(),
  generateSelfCallToken: jest.fn().mockReturnValue('mock-token'),
  clearUserCache: jest.fn(),
}));
jest.mock('../services/skillService', () => ({ skillService: { getPublishedSkills: jest.fn().mockResolvedValue([]) } }));
jest.mock('../services/subscriptionService', () => ({ getAllowedSkills: jest.fn().mockResolvedValue(['*']) }));
jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    installSkills: jest.fn().mockResolvedValue({ success: true }),
    getUnassociatedToolNames: jest.fn().mockReturnValue([]),
  },
}));
jest.mock('../services/db', () => ({ userDb: { getUserById: jest.fn() } }));

import { mcpFetch } from '../mcp/server/httpClient';
import { mcpToolRegistry } from '../mcp/server/registry';
import { LandingPageResolveError } from '../mcp/server/apiTools';

const mockMcpFetch = mcpFetch as jest.MockedFunction<typeof mcpFetch>;
const context = { userId: 'admin-fixture', agentUserId: 'admin-fixture' };
const run = (args: any) => mcpToolRegistry.execute('resolve_landing_page_by_url', args, context);
const body = (r: any) => JSON.parse(r.content[0].text);

describe('resolve_landing_page_by_url (ENG-1628)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns status=found for a published fixture URL', async () => {
    mockMcpFetch.mockResolvedValue({ matches: [{ page: { id: 'fixture-page' } }], scannedAll: true });
    const out = body(await run({ url: 'https://fixture.agentwebforms.com/demo' }));
    expect(out).toMatchObject({ status: 'found', scannedAll: true });
    expect(out.matches[0].page.id).toBe('fixture-page');
    expect(mockMcpFetch.mock.calls[0][0].path).toBe(
      '/api/admin/landing-pages/resolve?url=' + encodeURIComponent('https://fixture.agentwebforms.com/demo'),
    );
  });

  it('resolves a custom-domain hostname', async () => {
    mockMcpFetch.mockResolvedValue({ matches: [{ page: { id: 'fixture-custom' } }], scannedAll: true });
    const out = body(await run({ url: '  fixture-custom.example.test  ' }));
    expect(out.status).toBe('found');
    expect(mockMcpFetch.mock.calls[0][0].path).toContain(encodeURIComponent('fixture-custom.example.test'));
  });

  it('maps a route 404 to status=not_found instead of throwing', async () => {
    mockMcpFetch.mockRejectedValue(new Error('API error (404): {"matches":[],"scannedAll":true}'));
    const out = body(await run({ url: 'https://nope.example.test/x' }));
    expect(out).toMatchObject({ status: 'not_found', matches: [], scannedAll: true });
  });

  it('flags an inconclusive capped scan on 404', async () => {
    mockMcpFetch.mockRejectedValue(new Error('API error (404): {"matches":[],"scannedAll":false}'));
    const out = body(await run({ url: 'nope.example.test' }));
    expect(out).toMatchObject({ status: 'not_found', scannedAll: false });
    expect(out.message).toMatch(/inconclusive/);
  });

  it('maps a route 400 to status=invalid_url', async () => {
    mockMcpFetch.mockRejectedValue(new Error("API error (400): Query param 'url' is not a valid URL or hostname"));
    const out = body(await run({ url: 'not a url' }));
    expect(out.status).toBe('invalid_url');
  });

  it('returns invalid_url without a network call when url is missing or blank', async () => {
    expect(body(await run({})).status).toBe('invalid_url');
    expect(body(await run({ url: '   ' })).status).toBe('invalid_url');
    expect(mockMcpFetch).not.toHaveBeenCalled();
  });

  it('throws a specifically-named LandingPageResolveError for genuine faults', async () => {
    mockMcpFetch.mockRejectedValue(new Error('API error (500): Failed to resolve landing page by URL'));
    const err: any = await run({ url: 'fixture.agentwebforms.com' }).catch((e) => e);
    expect(err).toBeInstanceOf(LandingPageResolveError);
    expect(err.name).toBe('LandingPageResolveError');
    expect(err.httpStatus).toBe(500);
    expect(err.message).toMatch(/resolve_landing_page_by_url failed \(HTTP 500\)/);
  });

  it('wraps a network fault (no HTTP status) in LandingPageResolveError', async () => {
    mockMcpFetch.mockRejectedValue(new Error('fetch failed'));
    const err: any = await run({ url: 'fixture.agentwebforms.com' }).catch((e) => e);
    expect(err).toBeInstanceOf(LandingPageResolveError);
    expect(err.httpStatus).toBeUndefined();
  });
});
