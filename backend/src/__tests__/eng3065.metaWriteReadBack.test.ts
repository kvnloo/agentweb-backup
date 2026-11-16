/**
 * ENG-3065 (ENG-592 slice 3): Meta updates and deletes are read back before the tool reports
 * success, and every mutation-shaped MetaService method is listed as verified or exempt.
 * Stubbed service only; no live Meta call. Pattern: docs/ad-api-read-back-pattern.md.
 */
jest.mock('../mcp/client/mcpClientService', () => ({
  McpClientService: jest.fn().mockImplementation(() => ({ isReady: jest.fn().mockReturnValue(true) })),
}));

jest.mock('../services/metaService', () => {
  const actual = jest.requireActual('../services/metaService');
  return {
    ...actual,
    metaService: {
      updateCampaign: jest.fn(), deleteCampaign: jest.fn(), getCampaign: jest.fn(),
      updateAdSet: jest.fn(), deleteAdSet: jest.fn(), getAdSet: jest.fn(),
      updateAd: jest.fn(), deleteAd: jest.fn(), getAd: jest.fn(),
      getAdAccountCurrency: jest.fn().mockResolvedValue('USD'),
    },
  };
});

jest.mock('../services/db', () => ({ userDb: { getUserById: jest.fn() } }));
jest.mock('../utils/secretsManager', () => ({ getMetaAccessToken: jest.fn().mockResolvedValue('mock-access-token') }));

import { AgentModeService } from '../services/agentModeService';
import { MetaService, metaService } from '../services/metaService';
import { userDb } from '../services/db';
import { checkMetaDelete, checkMetaUpdate, isMetaObjectNotFound } from '../services/agentMode/metaWriteReadBack';

const MUTATION_PREFIX = /^(create|update|delete|remove|add|set|upload|replace|send|attach|pause|resume)/;

/** Verified by read-back in the AgentModeService handler that calls the method (checked below). */
const VERIFIED_AT_HANDLER: Record<string, string> = {
  updateCampaign: 'updateMetaAdsCampaign: checkMetaUpdate (name, status), verifyMetaBudget (budgets), verifyCampaignSpendCap (spend_cap)',
  deleteCampaign: 'deleteMetaAdsCampaign: checkMetaDelete',
  updateAdSet: 'updateMetaAdsAdSet: checkMetaUpdate (name, status, bid_strategy, bid_amount), verifyMetaBudget (budgets)',
  deleteAdSet: 'deleteMetaAdsAdSet: checkMetaDelete',
  updateAd: 'updateMetaAdsAd: checkMetaUpdate (name, status), verifyCreativeSwap (creative), image-swap and creative-field checks',
  deleteAd: 'deleteMetaAdsAd: checkMetaDelete',
};

/** Not read back, each with the reason. */
const EXEMPT: Record<string, string> = {
  createCampaign: 'create: the returned id is the evidence',
  createAdSet: 'create: the returned id is the evidence; createMetaAdsAdSet also reads the ad set back (ENG-838)',
  createAdCreative: 'create: the returned id is the evidence; the handler compares requested creative fields (findUnappliedCreativeFields)',
  createPlacementCustomizedCreative: 'private helper of createAdCreative',
  createAd: 'create: the returned id is the evidence',
  uploadImage: 'create: the returned image hash is the evidence',
  uploadVideo: 'create: the returned video id is the evidence',
  createCustomAudience: 'create: the returned id is the evidence',
  uploadCustomAudienceUsers: 'NOT VERIFIED: Meta returns num_received / num_invalid_entries and matches users asynchronously; there is no immediate read that proves the rows landed',
  deleteCustomAudienceUsers: 'NOT VERIFIED: same asynchronous user-list processing as uploadCustomAudienceUsers',
  replaceCustomAudienceUsers: 'NOT VERIFIED: same asynchronous user-list processing as uploadCustomAudienceUsers',
  setAppCredentials: 'not a Meta call: stores the app id and secret on the instance',
  sendCapiLeadEvent: 'not a config mutation: one Conversions API event; Meta answers events_received',
};

describe('ENG-3065 MetaService mutation surface', () => {
  it('every mutation-shaped method is verified or explicitly exempt', () => {
    const methods = Object.getOwnPropertyNames(MetaService.prototype)
      .filter(m => m !== 'constructor' && MUTATION_PREFIX.test(m));
    const uncovered = methods.filter(m => !(m in VERIFIED_AT_HANDLER) && !(m in EXEMPT));
    expect(uncovered).toEqual([]);
    for (const m of [...Object.keys(VERIFIED_AT_HANDLER), ...Object.keys(EXEMPT)]) {
      expect(methods).toContain(m);
    }
    expect(Object.keys(VERIFIED_AT_HANDLER).filter(m => m in EXEMPT)).toEqual([]);
  });
});

const fast = { attempts: 2, backoffMs: 0 };

describe('checkMetaUpdate', () => {
  it('passes when every checked field reads back as requested', async () => {
    const read = jest.fn().mockResolvedValue({ name: 'New', status: 'PAUSED' });
    await expect(checkMetaUpdate('campaign', 'c1', { name: 'New', status: 'PAUSED' }, read, fast)).resolves.toBeUndefined();
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('does not read when no checked field was requested', async () => {
    const read = jest.fn();
    await expect(checkMetaUpdate('campaign', 'c1', { targeting: { a: 1 }, daily_budget: 500 }, read, fast)).resolves.toBeUndefined();
    expect(read).not.toHaveBeenCalled();
  });

  it('reports only the fields that did not land', async () => {
    const read = jest.fn().mockResolvedValue({ name: 'New', status: 'ACTIVE' });
    const out = await checkMetaUpdate('ad', 'a1', { name: 'New', status: 'PAUSED' }, read, fast);
    expect(out).toMatchObject({ success: false, errorType: 'unsupported_field', fields: ['status'] });
    expect(out!.error).toContain('"PAUSED"');
    expect(out!.error).toContain('"ACTIVE"');
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('a field that lands on a later read passes', async () => {
    const read = jest.fn().mockResolvedValueOnce({ status: 'ACTIVE' }).mockResolvedValueOnce({ status: 'PAUSED' });
    await expect(checkMetaUpdate('ad', 'a1', { status: 'PAUSED' }, read, fast)).resolves.toBeUndefined();
  });

  it('a field missing from the read-back is not landed', async () => {
    const out = await checkMetaUpdate('adSet', 's1', { bid_strategy: 'COST_CAP' }, jest.fn().mockResolvedValue({}), fast);
    expect(out).toMatchObject({ errorType: 'unsupported_field', fields: ['bid_strategy'] });
  });

  it('bid_amount compares numerically (Meta returns a string)', async () => {
    const read = jest.fn().mockResolvedValue({ bid_amount: '500' });
    await expect(checkMetaUpdate('adSet', 's1', { bid_amount: 500 }, read, fast)).resolves.toBeUndefined();
    const out = await checkMetaUpdate('adSet', 's1', { bid_amount: 700 }, read, fast);
    expect(out).toMatchObject({ errorType: 'unsupported_field', fields: ['bid_amount'] });
  });

  it('a failing read is read_back_failed, never a pass', async () => {
    const out = await checkMetaUpdate('campaign', 'c1', { status: 'PAUSED' }, jest.fn().mockRejectedValue(new Error('boom')), fast);
    expect(out).toMatchObject({ success: false, errorType: 'read_back_failed', fields: ['status'] });
    expect(out!.error).toContain('boom');
  });
});

describe('checkMetaDelete', () => {
  const notFound = Object.assign(new Error('Unsupported get request. Object with ID does not exist'), {
    structuredError: { code: 100, error_subcode: 33 },
  });

  it.each(['DELETED', 'ARCHIVED'])('passes when the object reads back %s', async (status) => {
    await expect(checkMetaDelete('campaign', 'c1', jest.fn().mockResolvedValue({ status }), fast)).resolves.toBeUndefined();
  });

  it('passes when the object is not found', async () => {
    expect(isMetaObjectNotFound(notFound)).toBe(true);
    await expect(checkMetaDelete('ad', 'a1', jest.fn().mockRejectedValue(notFound), fast)).resolves.toBeUndefined();
  });

  it('fails when the object still reads back live', async () => {
    const out = await checkMetaDelete('adSet', 's1', jest.fn().mockResolvedValue({ status: 'ACTIVE' }), fast);
    expect(out).toMatchObject({ success: false, errorType: 'unsupported_field', fields: ['status'] });
  });

  it('a read error other than not-found is a failure, not a pass', async () => {
    expect(isMetaObjectNotFound(new Error('Meta rate limit exceeded'))).toBe(false);
    const out = await checkMetaDelete('ad', 'a1', jest.fn().mockRejectedValue(new Error('Meta rate limit exceeded')), fast);
    expect(out).toMatchObject({ success: false, errorType: 'read_back_failed' });
  });
});

describe('ENG-3065 at the tool boundary (AgentModeService handlers)', () => {
  let service: AgentModeService;
  const m = metaService as unknown as Record<string, jest.Mock>;
  const mockUser = {
    id: 'user123',
    connected_accounts: [{
      platform: 'meta', account_id: '123456789', account_name: 'Test Business',
      config: { account_type: 'ad_account', access_token: 'mock-access-token', ad_account_id: '123456789' },
    }],
  };

  beforeEach(() => {
    service = new AgentModeService();
    jest.clearAllMocks();
    jest.spyOn(service as any, 'sleep').mockResolvedValue(undefined);
    jest.spyOn(console, 'error').mockImplementation(() => {});
    (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
    m.getAdAccountCurrency.mockResolvedValue('USD');
    for (const k of ['updateCampaign', 'deleteCampaign', 'updateAdSet', 'deleteAdSet', 'updateAd', 'deleteAd']) {
      m[k].mockResolvedValue({ success: true });
    }
  });

  it('campaign update: status that did not land is unsupported_field with the field list', async () => {
    m.getCampaign.mockResolvedValue({ id: 'c1', name: 'Old', status: 'ACTIVE' });
    const r = await service.manageMetaAdsCampaigns('user123', 'UPDATE', '123456789', 'c1', { status: 'PAUSED' });
    expect(r).toMatchObject({ success: false, errorType: 'unsupported_field', fields: ['status'] });
    expect(m.updateCampaign).toHaveBeenCalledTimes(1);
    expect(m.getCampaign).toHaveBeenCalledTimes(4);
  });

  it('campaign update: landed status is success', async () => {
    m.getCampaign.mockResolvedValue({ id: 'c1', status: 'PAUSED' });
    const r = await service.manageMetaAdsCampaigns('user123', 'UPDATE', '123456789', 'c1', { status: 'PAUSED' });
    expect(r.success).toBe(true);
  });

  it('ad set update: bid_strategy that did not land is unsupported_field', async () => {
    m.getAdSet.mockResolvedValue({ id: 's1', name: 'N', bid_strategy: 'LOWEST_COST_WITHOUT_CAP' });
    const r = await service.manageMetaAdsAdSets('user123', 'UPDATE', '123456789', undefined, 's1', { name: 'N', bid_strategy: 'COST_CAP' });
    expect(r).toMatchObject({ success: false, errorType: 'unsupported_field', fields: ['bid_strategy'] });
    expect(m.getAdSet).toHaveBeenCalledWith('mock-access-token', 's1', '123456789');
  });

  it('ad set update: landed name is success', async () => {
    m.getAdSet.mockResolvedValue({ id: 's1', name: 'N' });
    const r = await service.manageMetaAdsAdSets('user123', 'UPDATE', '123456789', undefined, 's1', { name: 'N' });
    expect(r.success).toBe(true);
  });

  it('ad update: status that did not land is unsupported_field; landed is success', async () => {
    m.getAd.mockResolvedValue({ id: 'a1', status: 'ACTIVE' });
    const bad = await service.updateMetaAdsAd('user123', 'a1', { status: 'PAUSED' });
    expect(bad).toMatchObject({ success: false, errorType: 'unsupported_field', fields: ['status'] });
    m.getAd.mockResolvedValue({ id: 'a1', status: 'PAUSED' });
    const ok = await service.updateMetaAdsAd('user123', 'a1', { status: 'PAUSED' });
    expect(ok.success).toBe(true);
  });

  it('ad update: status sent with a direct creative_id is read back too', async () => {
    m.getAd.mockResolvedValue({ id: 'a1', status: 'ACTIVE', creative: { creative_id: 'cr2' } });
    const r = await service.updateMetaAdsAd('user123', 'a1', { creative_id: 'cr2', status: 'PAUSED' });
    expect(r).toMatchObject({ success: false, errorType: 'unsupported_field', fields: ['status'] });
  });

  it('ad update: a failing read-back is read_back_failed', async () => {
    m.getAd.mockRejectedValue(new Error('Meta rate limit exceeded'));
    const r = await service.updateMetaAdsAd('user123', 'a1', { name: 'X' });
    expect(r).toMatchObject({ success: false, errorType: 'read_back_failed', fields: ['name'] });
  });

  it.each([
    ['campaign', 'deleteMetaAdsCampaign', 'getCampaign'],
    ['ad set', 'deleteMetaAdsAdSet', 'getAdSet'],
    ['ad', 'deleteMetaAdsAd', 'getAd'],
  ])('%s delete: still live is a failure; DELETED or not found is success', async (_label, handler, getter) => {
    m[getter].mockResolvedValue({ status: 'ACTIVE' });
    const bad = await (service as any)[handler]('user123', 'x1');
    expect(bad).toMatchObject({ success: false, errorType: 'unsupported_field', fields: ['status'] });

    m[getter].mockResolvedValue({ status: 'DELETED' });
    expect((await (service as any)[handler]('user123', 'x1')).success).toBe(true);

    m[getter].mockRejectedValue(Object.assign(new Error('Object with ID does not exist'), { structuredError: { code: 100, error_subcode: 33 } }));
    expect((await (service as any)[handler]('user123', 'x1')).success).toBe(true);
  });
});
