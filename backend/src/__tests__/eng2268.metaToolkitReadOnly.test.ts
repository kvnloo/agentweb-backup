import request from 'supertest';
import express from 'express';

jest.mock('../services/agentApiKeyService', () => ({
  agentApiKeyService: { validateKey: jest.fn().mockResolvedValue({ userId: 'fixture-user', keyId: 'fixture-key' }) },
}));
jest.mock('../mcp/oauth/oauthService', () => ({ mcpOAuthService: { validateAccessToken: jest.fn() } }));
jest.mock('../services/connectedAccountsDb', () => ({
  getAccountsByUserIdIncludingOrgShared: jest.fn().mockResolvedValue([
    { platform: 'meta', account_id: '123', config: { account_type: 'ad_account', ad_account_id: '123', access_token: 'fixture-meta-token' } },
  ]),
}));
jest.mock('../services/mcpUsageEventsService', () => ({ recordMcpToolUse: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    listMetaAdsCampaignsNew: jest.fn().mockResolvedValue({ campaigns: [] }),
    getMetaAdsMetrics: jest.fn(),
    callMetaAdsInsightsApiWrapper: jest.fn(),
    callMetaMarketingApi: jest.fn().mockResolvedValue({ success: true, rows: [] }),
  },
}));
jest.mock('../utils/scheduledPublishConsentGuard', () => ({
  refuseUnauthorizedScheduledPublish: jest.fn().mockResolvedValue(null),
  attachPublishRevalidation: (_: unknown, context: unknown) => context,
}));
jest.mock('../services/evaluationPolicy', () => ({ enforceEvaluationTool: jest.fn().mockResolvedValue(undefined) }));

import router from '../routes/metaToolkit';
import { handleMetaToolkitCall } from '../mcp/metaToolkitGateway';
import { MetaToolkitRefusal } from '../mcp/metaToolkitManifest';
import { agentModeService } from '../services/agentModeService';
import { recordMcpToolUse } from '../services/mcpUsageEventsService';

const app = express();
app.use(express.json());
app.use('/api/meta-toolkit', router);
const authorization = 'Bearer aw_fixture';
const toolName = 'call_meta_marketing_api';
const argsFor = (action: string, entity_type = 'CAMPAIGN') => ({ entity_type, action, account_id: '123' });
// ENG-2303 (Harsha, 2026-10-12) superseded D2 for CAMPAIGN/AD_SET/AD CREATE + status/budget
// UPDATE behind the guarded preview→confirm path (eng2303.metaToolkitWrites.test.ts). Every
// other write stays refused at the boundary, exactly as D2 required.
const STILL_EXCLUDED: Array<[string, string]> = [['DELETE', 'CAMPAIGN'], ['CREATE', 'CUSTOM_AUDIENCE'], ['COPY_AD', 'AD'], ['CREATE', 'AD_CREATIVE']];

// Real transport -> gateway -> v1 assertion -> shared registry. Only external dependencies mocked.
describe('ENG-2268 external write boundary across public entrypoints (non-guarded writes)', () => {
  beforeEach(() => jest.clearAllMocks());

  it.each(STILL_EXCLUDED)('gateway refuses %s %s without provider dispatch or metering', async (action, entity) => {
    await expect(handleMetaToolkitCall({ authorization, toolName, args: argsFor(action, entity) }))
      .rejects.toBeInstanceOf(MetaToolkitRefusal);
    expect(agentModeService.callMetaMarketingApi).not.toHaveBeenCalled();
    expect(recordMcpToolUse).not.toHaveBeenCalled();
  });

  it.each(STILL_EXCLUDED)('REST refuses %s %s without provider dispatch or metering', async (action, entity) => {
    const res = await request(app).post(`/api/meta-toolkit/tools/${toolName}/call`)
      .set('Authorization', authorization).send({ args: argsFor(action, entity) }).expect(400);
    expect(res.body.error).toMatch(/not part of the Meta Toolkit v1 surface/);
    expect(agentModeService.callMetaMarketingApi).not.toHaveBeenCalled();
    expect(recordMcpToolUse).not.toHaveBeenCalled();
  });

  it.each(STILL_EXCLUDED)('MCP refuses %s %s without provider dispatch or metering', async (action, entity) => {
    const res = await request(app).post('/api/meta-toolkit/mcp').set('Authorization', authorization)
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: toolName, arguments: argsFor(action, entity) } }).expect(200);
    expect(res.body.result.isError).toBe(true);
    expect(res.body.result.content[0].text).toMatch(/not part of the Meta Toolkit v1 surface/);
    expect(agentModeService.callMetaMarketingApi).not.toHaveBeenCalled();
    expect(recordMcpToolUse).not.toHaveBeenCalled();
  });

  it.each(['gateway', 'REST', 'MCP'])('%s allows a read through shared dispatch and meters once', async surface => {
    if (surface === 'gateway') {
      await expect(handleMetaToolkitCall({ authorization, toolName, args: argsFor('LIST') }))
        .resolves.toMatchObject({ success: true });
    } else if (surface === 'REST') {
      const res = await request(app).post(`/api/meta-toolkit/tools/${toolName}/call`)
        .set('Authorization', authorization).send({ args: argsFor('LIST') }).expect(200);
      expect(res.body.result.success).toBe(true);
    } else {
      const res = await request(app).post('/api/meta-toolkit/mcp').set('Authorization', authorization)
        .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: toolName, arguments: argsFor('LIST') } }).expect(200);
      expect(res.body.result.isError).toBe(false);
      expect(JSON.parse(res.body.result.content[0].text).success).toBe(true);
    }
    expect(agentModeService.callMetaMarketingApi).toHaveBeenCalledTimes(1);
    expect(recordMcpToolUse).toHaveBeenCalledTimes(1);
  });
});
