process.env.ZOMA_REQUIRE_PAYMENT_METHOD = 'true';
/**
 * ENG-2942 (slice A of ENG-2911): an MCP-created Meta ad set may optimise for a custom
 * conversion or a custom pixel event the account has configured — not only Lead — while an
 * unknown or archived event is still refused (ENG-2674 / ENG-1399 protection).
 */
jest.mock('../services/connectedAccountsDb', () => ({ getAccountsByUserIdIncludingOrgShared: jest.fn() }));
jest.mock('../mcp/zomaOnboarding', () => {
  const actual = jest.requireActual('../mcp/zomaOnboarding');
  return { ...actual, assertZomaWriteReady: jest.fn() };
});

import { executeMetaToolkitWrite, type MetaToolkitWriteDeps } from '../mcp/metaToolkitWrites';
import { MetaToolkitRefusal } from '../mcp/metaToolkitErrors';
import { eventNamesFromStats, type ConversionLookup } from '../mcp/metaToolkitConversionGate';

const account = { platform: 'meta', account_id: 'act_111', config: { account_type: 'ad_account', access_token: 'tok', ad_account_id: '111', granted_scopes: ['ads_read', 'ads_management'] } };

// Pixel 555 fires only a custom "QualifiedTrial" event (no Lead); conversion 777 is on it.
function lookup(over: Partial<ConversionLookup> = {}): ConversionLookup {
  return {
    listCustomConversions: jest.fn().mockResolvedValue([
      { id: '777', name: 'Qualified trial', is_archived: false, pixel: { id: '555' } },
      { id: '778', name: 'Old trial', is_archived: true, pixel: { id: '555' } },
    ]),
    listPixelEventNames: jest.fn().mockResolvedValue(['PageView', 'QualifiedTrial']),
    ...over,
  };
}

function makeDeps(l: ConversionLookup = lookup()) {
  const deps: MetaToolkitWriteDeps = {
    assertReady: jest.fn().mockResolvedValue(undefined),
    listAccounts: jest.fn().mockResolvedValue([account]),
    previewMoney: jest.fn(async (_u: string, _a: string, params: any) => ({ params, currency: 'USD', confirmation: '' })),
    preview: jest.fn(async (_u: string, entity: string, action: string, accountId: string, c?: string, as?: string, ad?: string, params?: any) => ({
      success: true, awaitingUserConfirmation: true, summary: `${action} ${entity} on ${accountId}`,
      metaWriteDispatch: { entity_type: entity, action, account_id: accountId, resolvedAccountId: accountId, campaign_id: c, ad_set_id: as, ad_id: ad, params },
    })),
    dispatch: jest.fn().mockResolvedValue({ result: { success: true, message: 'ok' }, createdId: '999' }),
    readBack: jest.fn(async (_u: string, _a: string, _e: string, _id: string) => ({ id: '999', status: 'PAUSED', effective_status: 'PAUSED' })),
    assertCreativeOwned: jest.fn().mockResolvedValue(undefined),
    conversionLookup: jest.fn().mockResolvedValue(l),
    spendCeilingPolicy: () => null,
    secret: () => 'test-secret',
    now: () => 1_800_000_000_000,
    consumedTokens: new Map(),
  };
  return deps as MetaToolkitWriteDeps & Record<string, jest.Mock>;
}

const adSet = (promoted_object: any) => ({
  entity_type: 'AD_SET', action: 'CREATE', account_id: '111', campaign_id: '321',
  params: { name: 'Trials', optimization_goal: 'OFFSITE_CONVERSIONS', billing_event: 'IMPRESSIONS', targeting: { geo_locations: { countries: ['US'] } }, promoted_object },
});

async function previewThenConfirm(deps: MetaToolkitWriteDeps, args: any) {
  const preview: any = await executeMetaToolkitWrite('u1', args, deps);
  expect(preview.status).toBe('PREVIEW');
  return executeMetaToolkitWrite('u1', { ...args, confirm: true, preview_token: preview.preview_token }, deps);
}

describe('ENG-2942 custom conversion optimisation events', () => {
  it('custom-conversion-only pixel: ad set is created and then enabled', async () => {
    const deps = makeDeps();
    const created: any = await previewThenConfirm(deps, adSet({ pixel_id: '555', custom_conversion_id: '777', custom_event_type: 'OTHER' }));
    expect(created.success).toBe(true);
    expect(deps.dispatch).toHaveBeenCalledTimes(1);
    expect((deps.dispatch as jest.Mock).mock.calls[0][1].params.promoted_object.custom_conversion_id).toBe('777');

    (deps.readBack as jest.Mock).mockResolvedValue({ id: '999', status: 'ACTIVE', effective_status: 'ACTIVE' });
    const enabled: any = await previewThenConfirm(deps, { entity_type: 'AD_SET', action: 'UPDATE', account_id: '111', ad_set_id: '999', params: { status: 'ACTIVE' } });
    expect(enabled.success).toBe(true);
    expect(deps.dispatch).toHaveBeenCalledTimes(2);
  });

  it('a configured custom pixel event (custom_event_str) is accepted', async () => {
    const deps = makeDeps();
    const res: any = await previewThenConfirm(deps, adSet({ pixel_id: '555', custom_event_type: 'OTHER', custom_event_str: 'QualifiedTrial' }));
    expect(res.success).toBe(true);
  });

  it('an unknown custom conversion is refused and nothing is dispatched', async () => {
    const deps = makeDeps();
    await expect(executeMetaToolkitWrite('u1', adSet({ pixel_id: '555', custom_conversion_id: '404' }), deps)).rejects.toThrow(/not configured in this ad account/);
    expect(deps.dispatch).not.toHaveBeenCalled();
  });

  it('an archived custom conversion is refused', async () => {
    const deps = makeDeps();
    await expect(executeMetaToolkitWrite('u1', adSet({ pixel_id: '555', custom_conversion_id: '778' }), deps)).rejects.toThrow(/archived/);
  });

  it('a conversion on a different pixel is refused', async () => {
    const deps = makeDeps();
    await expect(executeMetaToolkitWrite('u1', adSet({ pixel_id: '999', custom_conversion_id: '777' }), deps)).rejects.toThrow(/is on pixel 555/);
  });

  it('a custom pixel event the pixel never reported is refused', async () => {
    const deps = makeDeps();
    await expect(executeMetaToolkitWrite('u1', adSet({ pixel_id: '555', custom_event_type: 'OTHER', custom_event_str: 'Nope' }), deps)).rejects.toThrow(MetaToolkitRefusal);
  });

  it('a Meta lookup failure refuses with a retry message (not a verdict, not a pass)', async () => {
    const deps = makeDeps(lookup({ listCustomConversions: jest.fn().mockRejectedValue(new Error('timeout')) }));
    await expect(executeMetaToolkitWrite('u1', adSet({ pixel_id: '555', custom_conversion_id: '777' }), deps)).rejects.toThrow(/Could not check.*timeout/);
  });

  it('Lead path unchanged: a standard LEAD ad set needs no conversion lookup', async () => {
    const l = lookup();
    const deps = makeDeps(l);
    const res: any = await previewThenConfirm(deps, adSet({ pixel_id: '555', custom_event_type: 'LEAD' }));
    expect(res.success).toBe(true);
    expect(l.listCustomConversions).not.toHaveBeenCalled();
    expect(l.listPixelEventNames).not.toHaveBeenCalled();
  });

  it('eventNamesFromStats reads data[].data[].value', () => {
    expect(eventNamesFromStats({ data: [{ data: [{ value: 'Lead', count: 2 }, { value: 'QualifiedTrial', count: 1 }] }, { data: [{ value: 'Lead' }] }] }))
      .toEqual(['Lead', 'QualifiedTrial']);
  });
});
