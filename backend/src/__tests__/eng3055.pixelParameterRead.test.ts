/**
 * ENG-3055 (child of ENG-2917) — ads_pixel_parameter_read.
 *
 * Acceptance contract (PM-drafted on the issue):
 *  1. Listed and callable on Zoma, read-only, read scope only, not metered as a write.
 *  2. A pixel outside the selected ad account is refused before any read of that pixel.
 *  3. A paged result returns cursors only, never a URL carrying the access token.
 *  4. The matrix row is `covered`.
 *
 * Meta documents the read as GET /{ads-pixel-id}/extractors (Ads Pixel Extractors reference,
 * checked 2026-11-16). Graph is mocked here; no live account was read.
 */
jest.mock('../services/agentApiKeyService', () => ({ agentApiKeyService: {} }));
jest.mock('../mcp/oauth/oauthService', () => ({ mcpOAuthService: {} }));
jest.mock('../services/connectedAccountsDb', () => ({ getAccountsByUserIdIncludingOrgShared: jest.fn() }));
jest.mock('../services/mcpUsageEventsService', () => ({ recordMcpToolUse: jest.fn(), recordMcpWriteExecuted: jest.fn() }));
jest.mock('../services/agentModeService', () => ({ agentModeService: { readToolkitMetaSignals: jest.fn().mockResolvedValue({ data: [] }) } }));
import { executeSignalsRead, isSignalsRead } from '../mcp/metaToolkitSignals';
import { getMetaToolkitManifest } from '../mcp/metaToolkitManifest';
import { handleMetaToolkitCall } from '../mcp/metaToolkitGateway';
import { READ_ONLY_TOOLKIT_TOOLS } from '../mcp/toolkitToolAnnotations';
import { ZOMA_META_PARITY_MATRIX } from '../mcp/zomaMetaParityMatrix';
import { agentModeService } from '../services/agentModeService';

const TOOL = 'ads_pixel_parameter_read';
const credentials = { accountId: '123', accessToken: 'secret' };
const owned = { data: { data: [{ id: '456' }] } };

describe('ENG-3055 ads_pixel_parameter_read', () => {
  beforeEach(() => jest.clearAllMocks());

  it('is advertised, read-only, and callable with only the read scope without a write record', async () => {
    expect(isSignalsRead(TOOL)).toBe(true);
    expect(getMetaToolkitManifest().some((d) => d.name === TOOL)).toBe(true);
    expect(READ_ONLY_TOOLKIT_TOOLS.has(TOOL)).toBe(true);
    const recordWrite = jest.fn();
    const recordUsage = jest.fn();
    const validateApiKey = jest.fn();
    validateApiKey.mockResolvedValue({ userId: 'u1', keyId: 'k1', scopes: ['tools:read'] });
    await handleMetaToolkitCall({ authorization: 'Bearer aw_fixture', toolName: TOOL, args: { pixel_id: '456' } } as any, {
      validateApiKey,
      listAccounts: jest.fn().mockResolvedValue([{ platform: 'meta', account_id: '123', config: { account_type: 'ad_account', ad_account_id: '123', access_token: 'x' } }]),
      recordUsage, recordWrite, now: () => 0,
      rateLimiter: { check: () => ({ allowed: true }) },
    } as any);
    expect(agentModeService.readToolkitMetaSignals).toHaveBeenCalledWith('u1', TOOL, { account_id: '123', pixel_id: '456' });
    expect(recordUsage).toHaveBeenCalledTimes(1);
    expect(recordWrite).not.toHaveBeenCalled();
  });

  it('reads the extractors edge of an owned pixel with the page arguments', async () => {
    const get = jest.fn().mockResolvedValue(owned);
    await executeSignalsRead(TOOL, { pixel_id: '456', limit: 5, after: 'c1' }, credentials, { get } as any);
    expect(get).toHaveBeenCalledTimes(2);
    expect(get.mock.calls[0][0]).toContain('/act_123/adspixels');
    expect(get.mock.calls[1][0]).toMatch(/\/456\/extractors$/);
    expect(get.mock.calls[1][1].params).toEqual({ access_token: 'secret', limit: 5, after: 'c1' });
  });

  it('refuses a pixel outside the selected ad account before reading that pixel', async () => {
    const get = jest.fn().mockResolvedValue({ data: { data: [{ id: '999' }] } });
    await expect(executeSignalsRead(TOOL, { pixel_id: '456' }, credentials, { get } as any)).rejects.toThrow('not in the selected');
    expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls[0][0]).not.toContain('456');
  });

  it('returns cursors only, never a paging URL that carries the access token', async () => {
    const page = { data: [{ id: '456' }], paging: { cursors: { before: 'b', after: 'a' }, next: 'https://graph.facebook.com/v25.0/456/extractors?access_token=secret&after=a' } };
    const out: any = await executeSignalsRead(TOOL, { pixel_id: '456' }, credentials, { get: jest.fn().mockResolvedValue({ data: page }) } as any);
    expect(JSON.stringify(out)).not.toContain('secret');
    expect(out.paging).toEqual({ cursors: { before: 'b', after: 'a' }, has_next: true, has_previous: false });
  });

  it.each([{}, { pixel_id: '../me' }, { pixel_id: '456', limit: 0 }, { pixel_id: '456', current_domain: 'example.com' }])('rejects invalid input %j before any Graph call', async (args) => {
    const get = jest.fn();
    await expect(executeSignalsRead(TOOL, args, credentials, { get } as any)).rejects.toThrow();
    expect(get).not.toHaveBeenCalled();
  });

  it('returns a Meta refusal as a result the caller can act on, without the token', async () => {
    const refusal = Object.assign(new Error('Request failed with status code 400'), {
      response: { status: 400, data: { error: { code: 100, message: 'Unsupported get request.' } } }, config: { url: 'https://graph.facebook.com/x?access_token=secret' },
    });
    const out = await executeSignalsRead(TOOL, { pixel_id: '456' }, credentials, { get: jest.fn().mockResolvedValueOnce(owned).mockRejectedValueOnce(refusal) } as any);
    expect(out).toMatchObject({ success: false, error: 'Unsupported get request.', metaErrorCode: 100 });
    expect(JSON.stringify(out)).not.toContain('secret');
  });

  it('is covered in the parity matrix by the tool of the same name', () => {
    const row = ZOMA_META_PARITY_MATRIX.find((r) => r.metaTool === TOOL)!;
    expect(row.status).toBe('covered');
    expect(row.zoma).toEqual({ tool: TOOL });
  });
});
