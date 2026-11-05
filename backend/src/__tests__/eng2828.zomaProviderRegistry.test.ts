/**
 * ENG-2828 acceptance:
 *  1. Behavior-preserving: the registry-derived Zoma tools/list for Meta is identical to the
 *     Meta Toolkit manifest, with the Meta tools in META_TOOLKIT_V1_TOOL_NAMES order.
 *  2. A second provider's tools join the combined list, and setup status is per platform.
 */
jest.mock('../services/agentModeService', () => ({ agentModeService: {} }));
jest.mock('../utils/scheduledPublishConsentGuard', () => ({
  refuseUnauthorizedScheduledPublish: jest.fn().mockResolvedValue(null),
  attachPublishRevalidation: (_: unknown, context: unknown) => context,
}));
jest.mock('../services/evaluationPolicy', () => ({ enforceEvaluationTool: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../mcp/zomaOnboarding', () => ({ getZomaReadiness: jest.fn() }));
jest.mock('../mcp/metaToolkitGateway', () => ({ resolveMetaToolkitAdAccount: jest.fn() }));

import { getMetaToolkitManifest, META_TOOLKIT_V1_TOOL_NAMES } from '../mcp/metaToolkitManifest';
import { isGuardedWriteRequest } from '../mcp/metaToolkitWriteSurface';
import { ZOMA_TOOL_NAMES } from '../mcp/zomaToolDefinitions';
import { metaZomaProvider } from '../mcp/metaZomaProvider';
import { ZomaProviderRegistry, zomaProviderRegistry } from '../mcp/zomaProviderRegistry';
import type { ZomaProvider } from '../mcp/zomaProvider';
import { getZomaReadiness } from '../mcp/zomaOnboarding';
import { resolveMetaToolkitAdAccount } from '../mcp/metaToolkitGateway';

const fakeProvider: ZomaProvider = {
  platform: 'fakeads',
  toolNames: ['list_fakeads_campaigns', 'get_fakeads_metrics'],
  meteringPlatform: 'fakeads',
  listTools: () => [
    { name: 'list_fakeads_campaigns', description: 'fake', inputSchema: { type: 'object', properties: {} } },
    { name: 'get_fakeads_metrics', description: 'fake', inputSchema: { type: 'object', properties: {} } },
    // Shared toolkit tool also advertised by Meta: must appear once.
    { name: 'zoma_status', description: 'dup', inputSchema: { type: 'object', properties: {} } },
  ],
  resolveAccount: async () => 'fake-acct',
  getSetupStatus: async () => ({ platform: 'fakeads', connected: false, connectLink: 'https://fake/connect', writesEnabled: false }),
  guardedWrites: { entities: [], actions: [], isGuardedWrite: () => false },
};

describe('ENG-2828 ZomaProvider registry', () => {
  beforeEach(() => jest.clearAllMocks());

  it('registers Meta as the only provider', () => {
    expect(zomaProviderRegistry.list().map((p) => p.platform)).toEqual(['meta']);
    expect(zomaProviderRegistry.get('meta')).toBe(metaZomaProvider);
  });

  it('Meta tools/list through the registry is identical to the manifest, in META_TOOLKIT_V1_TOOL_NAMES order', () => {
    const tools = zomaProviderRegistry.listTools();
    expect(tools).toEqual(getMetaToolkitManifest());
    expect(tools.map((t) => t.name)).toEqual([...META_TOOLKIT_V1_TOOL_NAMES, ...ZOMA_TOOL_NAMES]);
    expect(metaZomaProvider.toolNames).toEqual(META_TOOLKIT_V1_TOOL_NAMES);
  });

  it('describes Meta metering tag and guarded-write surface from the existing modules', () => {
    expect(metaZomaProvider.meteringPlatform).toBe('meta');
    expect(metaZomaProvider.guardedWrites.entities).toEqual(['CAMPAIGN', 'AD_SET', 'AD']);
    expect(metaZomaProvider.guardedWrites.actions).toEqual(['CREATE', 'UPDATE']);
    expect(metaZomaProvider.guardedWrites.isGuardedWrite).toBe(isGuardedWriteRequest);
    expect(zomaProviderRegistry.providerForTool('call_meta_marketing_api')).toBe(metaZomaProvider);
    expect(zomaProviderRegistry.providerForTool('zoma_status')).toBeUndefined();
  });

  it('delegates Meta account lookup to the gateway resolver', async () => {
    (resolveMetaToolkitAdAccount as jest.Mock).mockResolvedValue('123');
    await expect(metaZomaProvider.resolveAccount('u1', 'act_123')).resolves.toBe('123');
    expect(resolveMetaToolkitAdAccount).toHaveBeenCalledWith('u1', 'act_123');
  });

  it('a second provider joins the combined list after Meta, shared tools once', () => {
    const registry = new ZomaProviderRegistry([metaZomaProvider, fakeProvider]);
    const names = registry.listTools().map((t) => t.name);
    expect(names).toEqual([...META_TOOLKIT_V1_TOOL_NAMES, ...ZOMA_TOOL_NAMES, 'list_fakeads_campaigns', 'get_fakeads_metrics']);
    expect(registry.providerForTool('get_fakeads_metrics')).toBe(fakeProvider);
  });

  it('reports setup status per platform', async () => {
    (getZomaReadiness as jest.Mock).mockResolvedValue({
      payment: { ready: true },
      meta: { ready: true, accounts: [{ account_id: '123', ads_management: 'granted' }] },
      writes_enabled: true,
      next_step: null,
    });
    const registry = new ZomaProviderRegistry([metaZomaProvider, fakeProvider]);
    await expect(registry.getSetupStatus('u1')).resolves.toEqual([
      { platform: 'meta', connected: true, connectLink: undefined, writesEnabled: true },
      { platform: 'fakeads', connected: false, connectLink: 'https://fake/connect', writesEnabled: false },
    ]);
    expect(getZomaReadiness).toHaveBeenCalledWith('u1');
  });

  it('refuses a duplicate platform registration', () => {
    expect(() => new ZomaProviderRegistry([metaZomaProvider, metaZomaProvider])).toThrow(/already registered/);
  });
});
