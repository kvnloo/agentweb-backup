/**
 * ENG-3030 acceptance (ENG-2916 slice 2):
 *  1. ads_get_opportunity_score is advertised, read-only, tools:read only, no write metering.
 *  2. Arguments are allow-listed; unknown / malformed arguments are refused before any Graph read.
 *  3. Mocked Graph success returns the documented fields; a Graph error is the toolkit's
 *     structured refusal (HTTP 400 { error }), never a raw exception or the access token.
 *  4. ads_get_ad_entities is served by call_meta_marketing_api LIST on CAMPAIGN / AD_SET / AD.
 *  5. Both matrix rows leave `gap`.
 * Mocked Graph only: no live Meta call.
 */
jest.mock('../services/agentApiKeyService', () => ({ agentApiKeyService: { validateKey: jest.fn() } }));
jest.mock('../mcp/oauth/oauthService', () => ({ mcpOAuthService: { validateAccessToken: jest.fn() } }));
jest.mock('../services/connectedAccountsDb', () => ({ getAccountsByUserIdIncludingOrgShared: jest.fn() }));
jest.mock('../services/mcpUsageEventsService', () => ({ recordMcpToolUse: jest.fn(), recordMcpWriteExecuted: jest.fn() }));
jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    listMetaAdsCampaignsNew: jest.fn(),
    getMetaAdsMetrics: jest.fn(),
    callMetaAdsInsightsApiWrapper: jest.fn(),
    callMetaMarketingApi: jest.fn(),
    launchTargetedAudienceCampaign: jest.fn(),
    launchRetargetingCampaign: jest.fn(),
  },
}));
jest.mock('../utils/scheduledPublishConsentGuard', () => ({
  refuseUnauthorizedScheduledPublish: jest.fn().mockResolvedValue(null),
  attachPublishRevalidation: (_: unknown, context: unknown) => context,
}));
jest.mock('../services/evaluationPolicy', () => ({ enforceEvaluationTool: jest.fn().mockResolvedValue(undefined) }));

import {
  runMetaHealthTool,
  summarizeOpportunityScore,
  parseOpportunityScoreArgs,
  isMetaHealthTool,
} from '../mcp/metaToolkitHealth';
import { MetaToolkitRefusal } from '../mcp/metaToolkitErrors';
import { getMetaToolkitManifest, assertMetaToolkitV1Call } from '../mcp/metaToolkitManifest';
import { getToolkitToolAnnotations } from '../mcp/toolkitToolAnnotations';
import { handleMetaToolkitCall, MetaToolkitGatewayDeps } from '../mcp/metaToolkitGateway';
import { ZOMA_META_PARITY_MATRIX } from '../mcp/zomaMetaParityMatrix';
import { sendMetaToolkitError } from '../routes/metaToolkit';

const TOOL = 'ads_get_opportunity_score';

// Shape of Meta's documented "Example ad account response": rows grouped under `recommendations`,
// opportunity_score_lift inside recommendation_content.
const RECS = {
  data: [
    {
      recommendations: [
        {
          recommendation_signature: 'SIG-should-not-be-returned',
          recommendation_stage: 'mid_flight_recommendation',
          recommendation_time: '2026-04-02T23:12:34+0000',
          type: 'ADVANTAGE_PLUS_AUDIENCE',
          object_ids: [111, '222'],
          recommendation_content: { lift_estimate: 'Up to 9% lower cost per result', body: 'Turn on Advantage+ audience.', opportunity_score_lift: '7' },
          url: 'https://adsmanager.facebook.com/x',
        },
        { type: 'CREATIVE_FATIGUE', object_ids: ['333'] },
      ],
    },
  ],
};

describe('ENG-3030 ads_get_opportunity_score', () => {
  it('returns the score and the documented recommendation fields, without the apply signature', async () => {
    const readAccountGraph = jest.fn()
      .mockResolvedValueOnce({ id: 'act_9', opportunity_score: 62 })
      .mockResolvedValueOnce(RECS);
    const r: any = await runMetaHealthTool(TOOL, 'u', '9', { account_id: '9' }, { readAccountGraph });
    expect(readAccountGraph).toHaveBeenNthCalledWith(1, 'u', '9', '', { fields: 'opportunity_score' });
    // The edge is documented with no fields / limit parameter; none is sent.
    expect(readAccountGraph).toHaveBeenNthCalledWith(2, 'u', '9', 'recommendations', {});
    expect(r).toEqual({
      account_id: '9',
      opportunity_score: 62,
      recommendations: [
        {
          type: 'ADVANTAGE_PLUS_AUDIENCE', object_ids: ['111', '222'], opportunity_score_lift: 7,
          lift_estimate: 'Up to 9% lower cost per result', body: 'Turn on Advantage+ audience.', url: 'https://adsmanager.facebook.com/x',
        },
        { type: 'CREATIVE_FATIGUE', object_ids: ['333'], opportunity_score_lift: null },
      ],
      summary: { returned: 2 },
    });
    expect(JSON.stringify(r)).not.toMatch(/SIG-should-not-be-returned/);
  });

  it('reports a missing score as null with a note, never as 0', () => {
    const r = summarizeOpportunityScore('9', { id: 'act_9' }, { data: [] }, 50);
    expect(r.opportunity_score).toBeNull();
    expect(r.note).toMatch(/no opportunity score/);
    expect(r.recommendations).toEqual([]);
  });

  it('applies limit itself, marks a truncated list, and reads a top-level lift and a flat list too', () => {
    const grouped = { data: [{ opportunity_score: 40, recommendations: [{ type: 'A', opportunity_score_lift: '26' }, { type: 'B' }, { type: 'C' }] }] };
    const r = summarizeOpportunityScore('9', {}, grouped, 2);
    expect(r.opportunity_score).toBe(40);
    expect(r.recommendations.map((x) => x.type)).toEqual(['A', 'B']);
    expect(r.recommendations[0].opportunity_score_lift).toBe(26);
    expect(r.truncated).toBe(true);
    const flat = summarizeOpportunityScore('9', {}, { data: [{ type: 'A' }], paging: { next: 'https://x?access_token=T' } }, 50);
    expect(flat.recommendations.map((x) => x.type)).toEqual(['A']);
    expect(flat.truncated).toBe(true);
    expect(JSON.stringify(flat)).not.toMatch(/access_token/);
  });

  it('tolerates malformed rows from Meta instead of throwing', () => {
    const r = summarizeOpportunityScore('9', { opportunity_score: 'n/a' }, { data: [null, 'x', { type: 5, object_ids: 'no', recommendation_content: 'no' }] }, 50);
    expect(r.opportunity_score).toBeNull();
    expect(r.recommendations).toEqual([{ type: 'UNKNOWN', object_ids: [], opportunity_score_lift: null }]);
  });

  it.each([
    ['unknown argument', { fields: 'access_token' }, /Unknown argument\(s\): fields/],
    ['limit 0', { limit: 0 }, /limit must be an integer/],
    ['limit above the bound', { limit: 101 }, /limit must be an integer/],
    ['non-integer limit', { limit: 2.5 }, /limit must be an integer/],
    ['string limit', { limit: '10' }, /limit must be an integer/],
    ['array arguments', [1], /must be an object/],
  ])('refuses %s before any Graph read', async (_l, args, message) => {
    const readAccountGraph = jest.fn();
    await expect(runMetaHealthTool(TOOL, 'u', '9', args, { readAccountGraph })).rejects.toThrow(message);
    await expect(runMetaHealthTool(TOOL, 'u', '9', args, { readAccountGraph })).rejects.toBeInstanceOf(MetaToolkitRefusal);
    expect(readAccountGraph).not.toHaveBeenCalled();
  });

  it('passes a valid limit through', () => {
    expect(parseOpportunityScoreArgs({ account_id: '9', limit: 100 })).toBe(100);
    expect(parseOpportunityScoreArgs(undefined)).toBe(50);
  });

  it("a Graph error is the toolkit's structured 400 with Meta's message only, never the token", async () => {
    const err: any = Object.assign(new Error('Request failed with status code 400'), {
      config: { params: { access_token: 'SECRET' } }, metaError: { code: 100, message: '(#100) Tried accessing nonexisting field (opportunity_score)' },
    });
    const readAccountGraph = jest.fn().mockRejectedValue(err);
    const failure = await runMetaHealthTool(TOOL, 'u', '9', {}, { readAccountGraph }).catch((e) => e);
    expect(failure).toBeInstanceOf(MetaToolkitRefusal);
    const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn(), setHeader: jest.fn() };
    sendMetaToolkitError(res, failure);
    expect(res.status).toHaveBeenCalledWith(400);
    const body = res.json.mock.calls[0][0];
    expect(body.error).toMatch(/nonexisting field/);
    expect(JSON.stringify(body)).not.toMatch(/SECRET/);
  });
});

describe('ENG-3030 manifest, scope and metering', () => {
  const NOW = Date.parse('2026-11-15T00:00:00Z');
  const acct = (id: string) => ({ platform: 'meta', account_id: id, config: { account_type: 'ad_account', ad_account_id: id, access_token: 'tok', token_expires_at: NOW + 86_400_000 } });
  function makeDeps(scopes: string[]) {
    const raw = {
      validateApiKey: jest.fn().mockResolvedValue({ userId: 'user-1', keyId: 'k', scopes }),
      validateOAuthToken: jest.fn().mockResolvedValue(null),
      listAccounts: jest.fn().mockResolvedValue([acct('111')]),
      execute: jest.fn(),
      recordUsage: jest.fn().mockResolvedValue(true),
      recordWrite: jest.fn().mockResolvedValue(undefined),
      now: () => NOW,
      rateLimiter: { check: () => ({ allowed: true, remaining: 1, resetInMs: 0 }) },
      runHealthTool: jest.fn().mockResolvedValue({ opportunity_score: 62, access_token: 'leak' }),
    };
    return { raw, deps: raw as unknown as MetaToolkitGatewayDeps };
  }

  it('is advertised with a closed schema and annotated read-only', () => {
    const def: any = getMetaToolkitManifest().find((d: any) => d.name === TOOL);
    expect(def).toBeDefined();
    expect(def.inputSchema.additionalProperties).toBe(false);
    expect(Object.keys(def.inputSchema.properties).sort()).toEqual(['account_id', 'limit']);
    expect(isMetaHealthTool(TOOL)).toBe(true);
    expect(() => assertMetaToolkitV1Call(TOOL, {})).not.toThrow();
    expect(getToolkitToolAnnotations(TOOL)).toMatchObject({ readOnlyHint: true, destructiveHint: false });
  });

  it('a tools:read key runs it on the resolved account, metered once as a read, credentials stripped', async () => {
    const { raw, deps } = makeDeps(['tools:read']);
    const res = await handleMetaToolkitCall({ authorization: 'Bearer aw_x', toolName: TOOL, args: {} }, deps);
    expect(res).toEqual({ opportunity_score: 62 });
    expect(raw.runHealthTool).toHaveBeenCalledWith(TOOL, 'user-1', '111', expect.any(Object));
    expect(raw.recordUsage).toHaveBeenCalledTimes(1);
    expect(raw.recordWrite).not.toHaveBeenCalled();
    expect(raw.execute).not.toHaveBeenCalled();
  });

  it('a foreign ad account is 403 before any Graph read and is not metered', async () => {
    const { raw, deps } = makeDeps(['tools:read']);
    await expect(handleMetaToolkitCall({ authorization: 'Bearer aw_x', toolName: TOOL, args: { account_id: '999' } }, deps))
      .rejects.toMatchObject({ status: 403 });
    expect(raw.runHealthTool).not.toHaveBeenCalled();
    expect(raw.recordUsage).not.toHaveBeenCalled();
  });

  it('a key with neither tools scope is 403', async () => {
    const { raw, deps } = makeDeps(['email:read']);
    await expect(handleMetaToolkitCall({ authorization: 'Bearer aw_x', toolName: TOOL, args: {} }, deps))
      .rejects.toMatchObject({ status: 403, message: expect.stringContaining('tools:read') });
    expect(raw.runHealthTool).not.toHaveBeenCalled();
  });
});

describe('ENG-3030 parity rows', () => {
  const row = (name: string) => ZOMA_META_PARITY_MATRIX.find((r) => r.metaTool === name)!;

  it('both rows leave gap', () => {
    expect(row(TOOL)).toMatchObject({ status: 'covered', zoma: { tool: TOOL } });
    expect(row('ads_get_ad_entities')).toMatchObject({ status: 'covered', zoma: { tool: 'call_meta_marketing_api', action: 'LIST' } });
  });

  it('ads_get_ad_entities: LIST is advertised and allowed for CAMPAIGN, AD_SET and AD as a read', () => {
    const def: any = getMetaToolkitManifest().find((d: any) => d.name === 'call_meta_marketing_api');
    expect(def.inputSchema.properties.action.enum).toContain('LIST');
    for (const entity of ['CAMPAIGN', 'AD_SET', 'AD']) {
      expect(def.inputSchema.properties.entity_type.enum).toContain(entity);
      expect(() => assertMetaToolkitV1Call('call_meta_marketing_api', { entity_type: entity, action: 'LIST' })).not.toThrow();
    }
  });
});
