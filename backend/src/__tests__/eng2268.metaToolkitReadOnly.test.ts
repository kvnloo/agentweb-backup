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
const argsFor = (action: string) => ({ entity_type: 'CAMPAIGN', action, account_id: '123' });

// Real transport -> gateway -> v1 assertion -> shared registry. Only external dependencies mocked.
describe('ENG-2268 external reads-only boundary across public entrypoints', () => {
  beforeEach(() => jest.clearAllMocks());

  it.each(['CREATE', 'UPDATE'])('gateway refuses %s without provider dispatch or metering', async action => {
    await expect(handleMetaToolkitCall({ authorization, toolName, args: argsFor(action) }))
      .rejects.toBeInstanceOf(MetaToolkitRefusal);
    expect(agentModeService.callMetaMarketingApi).not.toHaveBeenCalled();
    expect(recordMcpToolUse).not.toHaveBeenCalled();
  });

  it.each(['CREATE', 'UPDATE'])('REST refuses %s without provider dispatch or metering', async action => {
    const res = await request(app).post(`/api/meta-toolkit/tools/${toolName}/call`)
      .set('Authorization', authorization).send({ args: argsFor(action) }).expect(400);
    expect(res.body.error).toMatch(/not part of the Meta Toolkit v1 surface/);
    expect(agentModeService.callMetaMarketingApi).not.toHaveBeenCalled();
    expect(recordMcpToolUse).not.toHaveBeenCalled();
  });

  it.each(['CREATE', 'UPDATE'])('MCP refuses %s without provider dispatch or metering', async action => {
    const res = await request(app).post('/api/meta-toolkit/mcp').set('Authorization', authorization)
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: toolName, arguments: argsFor(action) } }).expect(200);
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
