import { MetaService, normalizeMetaMoney } from '../services/metaService';
import { AdAccount } from 'facebook-nodejs-business-sdk';
jest.mock('facebook-nodejs-business-sdk', () => ({
  FacebookAdsApi: { init: jest.fn() },
  AdAccount: jest.fn(), Campaign: { Fields: {} }, AdSet: { Fields: {} },
  AdCreative: { Fields: {} }, Ad: { Fields: {}, Status: {} },
}));

describe('Meta currency offsets and currency-read boundary (ENG-2277)', () => {
  it.each('TWD JPY KRW CLP COP CRC HUF ISK IDR PYG VND'.split(' '))('%s uses offset 1', currency => {
    expect(normalizeMetaMoney(300, currency).minorUnits).toBe(300);
  });
  // Meta's currency offset table includes legacy codes and FBZ credits; BHD/JOD use 100, not ISO's 1000.
  it.each('BGN BHD FBZ HRK JOD LTL LVL RSD RUB SKK VEF VES'.split(' '))('%s accepts major and minor units with Meta offset 100', currency => {
    expect(normalizeMetaMoney(12.34, currency).minorUnits).toBe(1234);
    expect(normalizeMetaMoney(1234, currency, 'minor').minorUnits).toBe(1234);
    expect(normalizeMetaMoney(1234, currency, 'minor').description).toContain('12.34');
  });
  it.each(['USD', 'EUR', 'GBP', 'LKR'])('%s uses offset 100', currency => {
    expect(normalizeMetaMoney(3000, currency).minorUnits).toBe(300000);
  });
  it('does not double-convert API read-backs', () => {
    expect(normalizeMetaMoney(300000, 'USD', 'minor').description).toBe('300000 (= $3,000.00)');
  });
  it('preserves valid cents despite binary floating point', () => {
    expect(normalizeMetaMoney(0.29, 'USD').minorUnits).toBe(29);
  });
  it.each([null, '300', -1, NaN, Infinity, Number.MAX_SAFE_INTEGER])('rejects invalid or unsafe amount %s', amount => {
    expect(() => normalizeMetaMoney(amount, 'USD')).toThrow();
  });
  it('rejects precision unavailable in the account currency', () => {
    expect(() => normalizeMetaMoney(300.5, 'TWD')).toThrow(/minor units/);
    expect(() => normalizeMetaMoney(3.001, 'USD')).toThrow(/minor units/);
  });
  it.each([{}, null, { currency: [] }, { currency: 100 }, { currency: 'ZZZ' }])('rejects malformed currency data %j', data => {
    (AdAccount as unknown as jest.Mock).mockImplementation(() => ({ get: jest.fn().mockResolvedValue({ _data: data }) }));
    return expect(MetaService.getInstance().getAdAccountCurrency('123', 'token')).rejects.toThrow(/currency/);
  });
  it('reads currency from the selected account', async () => {
    const get = jest.fn().mockResolvedValue({ _data: { currency: 'TWD' } });
    (AdAccount as unknown as jest.Mock).mockImplementation(() => ({ get }));
    expect(await MetaService.getInstance().getAdAccountCurrency('act_123', 'token')).toBe('TWD');
    expect(AdAccount).toHaveBeenLastCalledWith('act_123');
    expect(get).toHaveBeenCalledWith(['currency']);
  });
  it('converts a direct CBO budget through the same helper', async () => {
    const createCampaign = jest.fn().mockResolvedValue({ _data: { id: 'campaign' } });
    (AdAccount as unknown as jest.Mock).mockImplementation(() => ({
      get: jest.fn().mockResolvedValue({ _data: { currency: 'TWD' } }), createCampaign,
    }));
    await MetaService.getInstance().createCampaign('123', 'token', {
      name: 'Daily', objective: 'OUTCOME_TRAFFIC', advantage_campaign_budget: true, budget_amount: 300,
    } as any);
    expect(createCampaign).toHaveBeenCalledWith(['id'], expect.objectContaining({ daily_budget: 300 }));
  });
});
