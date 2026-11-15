/**
 * ENG-2917 slice 2 acceptance: Zoma tells an agent when a Meta ad set is optimizing for an
 * event that is not arriving, or arriving too rarely to exit learning. Read-only, judged from
 * the ad set's own 7-day insights, on the caller's resolved account.
 */
import {
  runMetaHealthTool,
  summarizeOptimizationEvents,
  META_HEALTH_TOOL_NAMES,
  LEARNING_EVENTS_PER_WEEK,
} from '../mcp/metaToolkitHealth';
import { MetaToolkitRefusal } from '../mcp/metaToolkitErrors';
import { READ_ONLY_TOOLKIT_TOOLS } from '../mcp/toolkitToolAnnotations';

const TOOL = 'meta_optimization_event_check';
const pixel = (event: string, extra: Record<string, unknown> = {}) => ({ pixel_id: '456', custom_event_type: event, ...extra });
const insights = (spend: string, actions: Array<{ action_type: string; value: string }> = []) => ({ data: [{ spend, actions }] });

describe('ENG-2917 summarizeOptimizationEvents', () => {
  it('warns when the ad set spent and got none of its optimization event', () => {
    const r = summarizeOptimizationEvents([
      { id: '1', name: 'Reg', promoted_object: pixel('COMPLETE_REGISTRATION'), insights: insights('84.10', [{ action_type: 'lead', value: '9' }]) },
    ]);
    expect(r.ad_sets[0]).toMatchObject({ ad_set_id: '1', optimization_event: 'CompleteRegistration', pixel_id: '456', verdict: 'no_events', events_7d: 0, spend_7d: 84.1 });
    expect(r.ad_sets[0].note).toMatch(/no CompleteRegistration/);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/Reg/);
  });

  it(`warns on fewer than ${LEARNING_EVENTS_PER_WEEK} events in 7 days and passes at the threshold`, () => {
    const r = summarizeOptimizationEvents([
      { id: '1', promoted_object: pixel('LEAD'), insights: insights('10', [{ action_type: 'lead', value: '49' }]) },
      { id: '2', promoted_object: pixel('LEAD'), insights: insights('10', [{ action_type: 'lead', value: '50' }]) },
    ]);
    expect(r.ad_sets.map((a) => a.verdict)).toEqual(['low_volume', 'ok']);
    expect(r.ad_sets[0].events_7d).toBe(49);
    expect(r.summary).toEqual({ total: 2, ok: 1, low_volume: 1, no_events: 0, not_judged: 0 });
    expect(r.warnings).toHaveLength(1);
  });

  it('counts one conversion once when Meta reports it under several action types', () => {
    const r = summarizeOptimizationEvents([
      {
        id: '1', promoted_object: pixel('LEAD'),
        insights: insights('10', [
          { action_type: 'lead', value: '30' },
          { action_type: 'offsite_conversion.fb_pixel_lead', value: '30' },
          { action_type: 'onsite_web_lead', value: '30' },
        ]),
      },
    ]);
    expect(r.ad_sets[0]).toMatchObject({ events_7d: 30, verdict: 'low_volume' });
  });

  it('never reports zero for an ad set it cannot judge', () => {
    const r = summarizeOptimizationEvents([
      { id: 'traffic', optimization_goal: 'LINK_CLICKS', insights: insights('10') },
      { id: 'no-delivery', promoted_object: pixel('LEAD') },
      { id: 'zero-spend', promoted_object: pixel('LEAD'), insights: insights('0') },
      { id: 'custom', promoted_object: pixel('OTHER', { custom_event_str: 'QualifiedTrial' }), insights: insights('10') },
      { id: 'conversion', promoted_object: pixel('OTHER', { custom_conversion_id: '77' }), insights: insights('10') },
      { id: 'new-type', promoted_object: pixel('SOMETHING_NEW'), insights: insights('10') },
      { id: 'no-family', promoted_object: pixel('SEARCH'), insights: insights('10') },
    ]);
    for (const row of r.ad_sets) {
      expect(row.verdict).toBe('not_judged');
      expect(row).not.toHaveProperty('events_7d');
      expect(row.note).toBeTruthy();
    }
    expect(r.ad_sets.find((a) => a.ad_set_id === 'custom')).toMatchObject({ optimization_event: 'QualifiedTrial' });
    expect(r.summary).toEqual({ total: 7, ok: 0, low_volume: 0, no_events: 0, not_judged: 7 });
    expect(r.warnings).toEqual([]);
  });

  it('tolerates a malformed ad set list', () => {
    expect(summarizeOptimizationEvents(undefined as any).summary.total).toBe(0);
    expect(summarizeOptimizationEvents([null, { id: '1', promoted_object: 'x', insights: { data: 'nope' } }] as any).ad_sets[0].verdict).toBe('not_judged');
  });
});

describe('ENG-2917 runMetaHealthTool meta_optimization_event_check', () => {
  it('makes one read of the resolved account adsets edge with 7-day ad-set insights', async () => {
    const readAccountGraph = jest.fn().mockResolvedValue({
      data: [{ id: '1', promoted_object: pixel('PURCHASE'), insights: insights('20', [{ action_type: 'purchase', value: '60' }]) }],
      paging: { next: 'https://graph.facebook.com/x?access_token=SECRET' },
    });
    const r: any = await runMetaHealthTool(TOOL as any, 'u', '9', { campaign_id: '123' }, { readAccountGraph });
    expect(readAccountGraph).toHaveBeenCalledTimes(1);
    const [userId, accountId, edge, params] = readAccountGraph.mock.calls[0];
    expect([userId, accountId, edge]).toEqual(['u', '9', 'adsets']);
    expect(params.fields).toContain('promoted_object');
    expect(params.fields).toContain('insights.date_preset(last_7d){spend,actions}');
    expect(JSON.parse(params.filtering)).toEqual([
      { field: 'campaign.id', operator: 'IN', value: ['123'] },
      { field: 'effective_status', operator: 'IN', value: ['ACTIVE'] },
    ]);
    expect(r).toMatchObject({ account_id: '9', window: 'last_7d', truncated: true, summary: { ok: 1 } });
    expect(JSON.stringify(r)).not.toContain('SECRET');
  });

  it('include_inactive drops the delivering-only filter', async () => {
    const readAccountGraph = jest.fn().mockResolvedValue({ data: [] });
    await runMetaHealthTool(TOOL as any, 'u', '9', { include_inactive: true }, { readAccountGraph });
    expect(readAccountGraph.mock.calls[0][3].filtering).toBeUndefined();
  });

  it('rejects a non-numeric campaign_id before any read', async () => {
    const readAccountGraph = jest.fn();
    await expect(runMetaHealthTool(TOOL as any, 'u', '9', { campaign_id: '1&access_token=x' }, { readAccountGraph })).rejects.toThrow(MetaToolkitRefusal);
    expect(readAccountGraph).not.toHaveBeenCalled();
  });

  it('a Graph error becomes a refusal with Meta\'s message only, never the token', async () => {
    const err: any = Object.assign(new Error('Request failed'), {
      config: { params: { access_token: 'SECRET' } }, metaError: { code: 190, message: 'Invalid OAuth access token.' },
    });
    const readAccountGraph = jest.fn().mockRejectedValue(err);
    const p = runMetaHealthTool(TOOL as any, 'u', '9', {}, { readAccountGraph });
    await expect(p).rejects.toBeInstanceOf(MetaToolkitRefusal);
    await expect(p).rejects.toThrow(/Invalid OAuth access token/);
    await expect(p).rejects.not.toThrow(/SECRET/);
  });
});

describe('ENG-2917 meta_optimization_event_check wiring', () => {
  it('is a health tool, advertised in the manifest, allowed past the v1 guard and annotated read-only', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getMetaToolkitManifest, assertMetaToolkitV1Call } = require('../mcp/metaToolkitManifest');
    const fakeRegistry = { getTool: (name: string) => ({ definition: { name, inputSchema: { type: 'object', properties: {} } } }) };
    const def = getMetaToolkitManifest(fakeRegistry).find((d: any) => d.name === TOOL);
    expect(META_HEALTH_TOOL_NAMES).toContain(TOOL);
    expect(def).toBeDefined();
    expect(def.inputSchema.additionalProperties).toBe(false);
    expect(() => assertMetaToolkitV1Call(TOOL, {})).not.toThrow();
    expect(READ_ONLY_TOOLKIT_TOOLS.has(TOOL)).toBe(true);
  });

  it('runs on the resolved account, meters once, and refuses a foreign account', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { handleMetaToolkitCall } = require('../mcp/metaToolkitGateway');
    const NOW = Date.parse('2026-11-15T00:00:00Z');
    const acct = (id: string) => ({ platform: 'meta', account_id: id, config: { account_type: 'ad_account', ad_account_id: id, access_token: 'tok', token_expires_at: NOW + 86_400_000 } });
    const runHealthTool = jest.fn().mockResolvedValue({ ok: true });
    const deps: any = {
      validateApiKey: jest.fn().mockResolvedValue({ userId: 'user-1', keyId: 'k' }),
      validateOAuthToken: jest.fn().mockResolvedValue(null),
      listAccounts: jest.fn().mockResolvedValue([acct('111')]),
      execute: jest.fn(),
      recordUsage: jest.fn().mockResolvedValue(true),
      now: () => NOW,
      rateLimiter: { check: () => ({ allowed: true, resetInMs: 0 }) },
      runHealthTool,
    };
    await expect(handleMetaToolkitCall({ authorization: 'Bearer aw_x', toolName: TOOL, args: {} }, deps)).resolves.toEqual({ ok: true });
    expect(runHealthTool).toHaveBeenCalledWith(TOOL, 'user-1', '111', expect.any(Object));
    expect(deps.recordUsage).toHaveBeenCalledTimes(1);
    expect(deps.execute).not.toHaveBeenCalled();

    await expect(handleMetaToolkitCall({ authorization: 'Bearer aw_x', toolName: TOOL, args: { account_id: '999' } }, deps)).rejects.toMatchObject({ status: 403 });
    expect(runHealthTool).toHaveBeenCalledTimes(1);
  });
});
