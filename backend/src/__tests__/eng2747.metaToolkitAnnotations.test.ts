/**
 * ENG-2747 — every tool the Meta Toolkit (Zoma) advertises carries MCP annotations, and the
 * labels never understate what a call can do. Marketplaces and gateways (Databricks Unity
 * Gateway, ChatGPT apps, the Claude directory) use the hints to decide what needs approval.
 */
jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    listMetaAdsCampaignsNew: jest.fn(),
    getMetaAdsMetrics: jest.fn(),
    callMetaAdsInsightsApiWrapper: jest.fn(),
    callMetaMarketingApi: jest.fn(),
  },
}));
jest.mock('../utils/scheduledPublishConsentGuard', () => ({
  refuseUnauthorizedScheduledPublish: jest.fn().mockResolvedValue(null),
  attachPublishRevalidation: (_: unknown, context: unknown) => context,
}));
jest.mock('../services/evaluationPolicy', () => ({ enforceEvaluationTool: jest.fn().mockResolvedValue(undefined) }));

import { META_TOOLKIT_V1_TOOL_NAMES, getMetaToolkitManifest } from '../mcp/metaToolkitManifest';
import { ZOMA_TOOL_NAMES, getToolkitToolAnnotations, type ToolkitToolAnnotations } from '../mcp/zomaToolDefinitions';

type AdvertisedTool = { name: string; annotations: ToolkitToolAnnotations };

const ALL_TOOLKIT_TOOLS: string[] = [...META_TOOLKIT_V1_TOOL_NAMES, ...ZOMA_TOOL_NAMES];

// The exact classification. A change here is a product decision, so it is spelled out by name.
const READ_ONLY = ['list_meta_ads_campaigns', 'get_meta_ads_metrics', 'call_meta_ads_insights_api', 'zoma_usage'];
const NOT_READ_ONLY = ['call_meta_marketing_api', 'zoma_status', 'zoma_prepare_upload'];

function advertised(): AdvertisedTool[] {
  return getMetaToolkitManifest() as AdvertisedTool[];
}

function advertisedTool(name: string): AdvertisedTool {
  const tool = advertised().find((d) => d.name === name);
  if (!tool) throw new Error(`${name} is not advertised`);
  return tool;
}

describe('ENG-2747 Meta Toolkit tool annotations', () => {
  it('annotates every advertised tool with the four boolean hints', () => {
    const manifest = advertised();
    expect(manifest.map((d) => d.name)).toEqual(ALL_TOOLKIT_TOOLS);
    for (const def of manifest) {
      expect({ name: def.name, keys: Object.keys(def.annotations ?? {}).sort() }).toEqual({
        name: def.name,
        keys: ['destructiveHint', 'idempotentHint', 'openWorldHint', 'readOnlyHint'],
      });
      for (const v of Object.values(def.annotations)) expect(typeof v).toBe('boolean');
    }
  });

  it('classifies each tool exactly', () => {
    expect([...READ_ONLY, ...NOT_READ_ONLY].sort()).toEqual([...ALL_TOOLKIT_TOOLS].sort());
    for (const name of READ_ONLY) {
      const { readOnlyHint, destructiveHint } = advertisedTool(name).annotations;
      expect({ name, readOnlyHint, destructiveHint }).toEqual({ name, readOnlyHint: true, destructiveHint: false });
    }
    for (const name of NOT_READ_ONLY) {
      expect({ name, readOnlyHint: advertisedTool(name).annotations.readOnlyHint }).toEqual({ name, readOnlyHint: false });
    }
  });

  it('labels the mixed read/write tool a destructive write, never read-only', () => {
    expect(advertisedTool('call_meta_marketing_api').annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    });
  });

  it('keeps a read-only tool free of any write-capable annotation', () => {
    for (const def of advertised()) {
      if (def.annotations.readOnlyHint) {
        expect({ name: def.name, destructiveHint: def.annotations.destructiveHint }).toEqual({ name: def.name, destructiveHint: false });
      }
    }
  });

  it('returns a fresh copy each call, so a caller cannot weaken the labels', () => {
    advertisedTool('call_meta_marketing_api').annotations.readOnlyHint = true;
    expect(advertisedTool('call_meta_marketing_api').annotations.readOnlyHint).toBe(false);
    expect(getToolkitToolAnnotations('call_meta_marketing_api')?.readOnlyHint).toBe(false);
  });

  it('does not resolve inherited object keys as tools', () => {
    expect(getToolkitToolAnnotations('toString')).toBeUndefined();
    expect(getToolkitToolAnnotations('__proto__')).toBeUndefined();
    expect(getToolkitToolAnnotations('not_a_tool')).toBeUndefined();
  });

  it('fails loudly when an advertised tool has no annotation entry', async () => {
    await jest.isolateModulesAsync(async () => {
      jest.doMock('../mcp/zomaToolDefinitions', () => {
        const actual = jest.requireActual('../mcp/zomaToolDefinitions');
        return {
          ...actual,
          ZOMA_TOOL_DEFINITIONS: [
            ...actual.ZOMA_TOOL_DEFINITIONS,
            { name: 'zoma_unlabelled', description: 'x', inputSchema: { type: 'object', properties: {} } },
          ],
        };
      });
      const isolated = await import('../mcp/metaToolkitManifest');
      expect(() => isolated.getMetaToolkitManifest()).toThrow(/zoma_unlabelled has no annotation entry/);
    });
  });
});
