/**
 * ENG-2282 acceptance contract:
 *  1. A single exported function returns only the v1 Meta tool definitions. No non-Meta tool leaks.
 *  2. ENG-2268: external v1 refuses all writes before dispatch; reads use shared handlers.
 *  3. No DB/persistence changes (this module imports no db).
 */
jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    listMetaAdsCampaignsNew: jest.fn().mockResolvedValue({ success: true, campaigns: [] }),
    getMetaAdsMetrics: jest.fn(),
    callMetaAdsInsightsApiWrapper: jest.fn(),
    callMetaMarketingApi: jest.fn().mockResolvedValue({ success: true, awaitingUserConfirmation: true }),
    launchTargetedAudienceCampaign: jest.fn(),
    launchRetargetingCampaign: jest.fn(),
  },
}));
jest.mock('../utils/scheduledPublishConsentGuard', () => ({
  refuseUnauthorizedScheduledPublish: jest.fn().mockResolvedValue(null),
  attachPublishRevalidation: (_: unknown, context: unknown) => context,
}));
jest.mock('../services/evaluationPolicy', () => ({ enforceEvaluationTool: jest.fn().mockResolvedValue(undefined) }));

import { agentModeService } from '../services/agentModeService';
import { emmaToolRegistry } from '../emma/registry';
import '../emma/tools';
import {
  META_TOOLKIT_V1_TOOL_NAMES,
  MetaToolkitRefusal,
  executeMetaToolkitCall,
  getMetaToolkitManifest,
} from '../mcp/metaToolkitManifest';
import { ZOMA_TOOL_NAMES } from '../mcp/zomaToolDefinitions';
import { META_HEALTH_TOOL_NAMES } from '../mcp/metaToolkitHealth';
import { META_CATALOG_TOOL_NAMES } from '../mcp/metaToolkitCatalogs';
import { META_CATALOG_WRITE_TOOL_NAMES } from '../mcp/metaToolkitCatalogWrites';
import { META_EVENT_SOURCE_TOOL_NAMES } from '../mcp/metaToolkitEventSources';
import { META_EXPERIMENT_WRITE_TOOL_NAMES } from '../mcp/metaToolkitExperimentWrites';
import { META_CATALOG_FEED_TOOL_NAMES } from '../mcp/metaToolkitCatalogFeeds';
import { META_PAGES_TOOL_NAMES } from '../mcp/metaToolkitPages';

// ENG-2303: the toolkit also advertises toolkit-local Zoma onboarding tools (not registry tools).
// ENG-2916: read-only account health + learning-phase tools sit between the Meta reads and Zoma onboarding.
const EXPECTED_TOOLKIT_NAMES = [...META_TOOLKIT_V1_TOOL_NAMES, 'ads_get_datasets', 'ads_get_dataset_details', 'ads_get_dataset_stats', 'ads_pixel_event_read', 'ads_pixel_parameter_read', 'ads_get_customconversions', 'ads_experiment_list_tests', 'ads_experiment_abtest_get_test', 'ads_experiment_lift_get_test', ...META_EXPERIMENT_WRITE_TOOL_NAMES, 'ads_get_help_article', 'ads_account_get_activity_logs', 'ads_get_errors', ...META_HEALTH_TOOL_NAMES, ...META_CATALOG_TOOL_NAMES, ...META_CATALOG_WRITE_TOOL_NAMES, ...META_EVENT_SOURCE_TOOL_NAMES, ...META_CATALOG_FEED_TOOL_NAMES, ...META_PAGES_TOOL_NAMES, 'ads_boost_ig_post', ...ZOMA_TOOL_NAMES, 'zoma_industry_benchmark', 'zoma_ads_report'];

const ctx = { userId: 'user-1', sessionId: 's-1' };

describe('ENG-2282 Meta Toolkit manifest', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns exactly the v1 Meta tools and nothing else from the Emma registry', () => {
    const manifest = getMetaToolkitManifest();
    expect(manifest.map((d: any) => d.name)).toEqual(EXPECTED_TOOLKIT_NAMES);
    expect(emmaToolRegistry.getToolNames().length).toBeGreaterThan(manifest.length + 10);
    for (const def of manifest.filter((d: any) => !d.name.startsWith('zoma_'))) {
      expect(def.name).toMatch(/meta|^ads_/);
      expect(typeof def.description).toBe('string');
      expect(def.inputSchema?.type).toBe('object');
    }
    const names = manifest.map((d: any) => d.name);
    expect(names).not.toContain('launch_targeted_audience_campaign');
    expect(names).not.toContain('launch_retargeting_campaign');
  });

  it('narrows the advertised schema: no client_id, no excluded actions, no tracking override', () => {
    const manifest = getMetaToolkitManifest();
    for (const def of manifest) expect(def.inputSchema.properties.client_id).toBeUndefined();
    const mkt = manifest.find((d: any) => d.name === 'call_meta_marketing_api');
    const actions: string[] = mkt.inputSchema.properties.action.enum;
    // UPLOAD_IMAGE / UPLOAD_VIDEO are advertised for AD_CREATIVE only (zoma creative upload); routing enforces the entity.
    for (const excluded of ['UPLOAD_USERS', 'COPY_AD', 'RETAG_UTM']) {
      expect(actions).not.toContain(excluded);
    }
    // ENG-2922 lifted the DELETE exclusion: ARCHIVE/DELETE/COPY are advertised and routed
    // to the guarded preview→confirm path (metaToolkitLifecycle.ts), never to this executor.
    expect(actions).toEqual(expect.arrayContaining(['ARCHIVE', 'DELETE', 'COPY']));
    // ENG-2303: guarded writes are advertised with the preview→confirm arguments.
    expect(actions).toEqual(expect.arrayContaining(['CREATE', 'UPDATE']));
    expect(mkt.inputSchema.properties.confirm.type).toBe('boolean');
    expect(mkt.inputSchema.properties.preview_token.type).toBe('string');
    expect(mkt.description).toMatch(/created PAUSED/);
    expect(mkt.inputSchema.properties.params.properties.override_tracking_check).toBeUndefined();
  });

  it('does not mutate the shared Emma registry definitions', () => {
    getMetaToolkitManifest();
    const original = emmaToolRegistry.getTool('call_meta_marketing_api')!.definition;
    expect(original.inputSchema.properties.action.enum).toContain('DELETE');
  });

  it.each(['CAMPAIGN', 'AD_SET', 'AD'].flatMap(entity =>
    ['CREATE', 'UPDATE'].map(action => [entity, action])))
  ('ENG-2268 refuses external %s %s before any handler runs', async (entity_type, action) => {
    await expect(executeMetaToolkitCall('call_meta_marketing_api',
      { entity_type, action, account_id: 'act_1' }, ctx)).rejects.toBeInstanceOf(MetaToolkitRefusal);
    expect(agentModeService.callMetaMarketingApi).not.toHaveBeenCalled();
  });

  it.each([
    ['DELETE', 'CAMPAIGN'],
    ['UPLOAD_USERS', 'CUSTOM_AUDIENCE'],
    ['CREATE', 'CUSTOM_AUDIENCE'],
    ['UPLOAD_IMAGE', 'AD_CREATIVE'],
    ['COPY_AD', 'AD'],
    ['RETAG_UTM', 'AD'],
  ])('refuses excluded action %s %s before any handler runs', async (action, entity) => {
    await expect(
      executeMetaToolkitCall('call_meta_marketing_api', { entity_type: entity, action, account_id: 'act_1' }, ctx),
    ).rejects.toBeInstanceOf(MetaToolkitRefusal);
    expect(agentModeService.callMetaMarketingApi).not.toHaveBeenCalled();
  });

  it('refuses override_tracking_check, client_id, non-toolkit tools and missing user', async () => {
    await expect(executeMetaToolkitCall('call_meta_marketing_api',
      { entity_type: 'CAMPAIGN', action: 'UPDATE', account_id: 'a', params: { status: 'ACTIVE', override_tracking_check: true } }, ctx))
      .rejects.toBeInstanceOf(MetaToolkitRefusal);
    await expect(executeMetaToolkitCall('list_meta_ads_campaigns', { client_id: 'other' }, ctx)).rejects.toBeInstanceOf(MetaToolkitRefusal);
    await expect(executeMetaToolkitCall('launch_retargeting_campaign', {}, ctx)).rejects.toBeInstanceOf(MetaToolkitRefusal);
    await expect(executeMetaToolkitCall('send_email', {}, ctx)).rejects.toBeInstanceOf(MetaToolkitRefusal);
    await expect(executeMetaToolkitCall('list_meta_ads_campaigns', {}, { userId: '' })).rejects.toBeInstanceOf(MetaToolkitRefusal);
    expect(agentModeService.callMetaMarketingApi).not.toHaveBeenCalled();
    expect(agentModeService.listMetaAdsCampaignsNew).not.toHaveBeenCalled();
    expect(agentModeService.launchRetargetingCampaign).not.toHaveBeenCalled();
  });

  it('sources the manifest + default dispatcher from the Meta-only module, never the full Emma registry', async () => {
    let isolated: any;
    let metaTools: any;
    let emmaRegistryModule: any;
    jest.isolateModules(() => {
      jest.doMock('../emma/tools', () => {
        throw new Error('ENG-2282: full Emma tool registry must not be imported');
      });
      isolated = require('../mcp/metaToolkitManifest');
      metaTools = require('../emma/metaTools');
      emmaRegistryModule = require('../emma/registry');
    });
    expect(emmaRegistryModule.emmaToolRegistry.getToolNames()).toEqual([]);
    expect(metaTools.metaToolRegistry.getToolNames()).toEqual([...META_TOOLKIT_V1_TOOL_NAMES]);
    expect(isolated.getMetaToolkitManifest().map((d: any) => d.name)).toEqual(EXPECTED_TOOLKIT_NAMES);

    const args = { entity_type: 'CAMPAIGN', action: 'LIST', account_id: 'act_1', params: { name: 'x' } };
    await isolated.executeMetaToolkitCall('call_meta_marketing_api', args, ctx);
    expect(agentModeService.callMetaMarketingApi).toHaveBeenCalledWith(
      'user-1', 'CAMPAIGN', 'LIST', 'act_1', undefined, undefined, undefined, { name: 'x' }, 's-1',
    );
  });

  it('Emma registers the same Meta handler objects (single source, no fork)', () => {
    const { metaToolRegistry } = require('../emma/metaTools');
    for (const name of META_TOOLKIT_V1_TOOL_NAMES) {
      expect(emmaToolRegistry.getTool(name)).toBe(metaToolRegistry.getTool(name));
    }
  });

  it.each(['LIST', 'GET', 'PREVIEW', 'SEARCH', 'GET_MATCH_QUALITY'])('allows marketing read %s', async action => {
    await executeMetaToolkitCall('call_meta_marketing_api', { entity_type: 'AD', action, account_id: 'act_1' }, ctx);
    expect(agentModeService.callMetaMarketingApi).toHaveBeenCalled();
  });

  it('allows reads', async () => {
    await executeMetaToolkitCall('list_meta_ads_campaigns', {}, ctx);
    expect(agentModeService.listMetaAdsCampaignsNew).toHaveBeenCalledWith('user-1');
  });
});
