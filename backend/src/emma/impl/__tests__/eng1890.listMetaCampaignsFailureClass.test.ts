/**
 * ENG-1890 — list_meta_ads_campaigns failure classes. Mocked Graph responses only.
 */
jest.mock('../../../services/metaService', () => ({
  metaService: { listCampaigns: jest.fn(), classifyAdsRefusalTier: jest.fn().mockResolvedValue('unknown') },
  MetaService: class {},
}));

import { listMetaAdsCampaignsNew } from '../adsApis';
import { metaService } from '../../../services/metaService';
import { classifyMetaReadFailure } from '../../../utils/metaReadErrorClass';
import { classifyToolErrorClass } from '../../../utils/toolErrorClassifier';
import { toolResultError } from '../../../utils/toolResultError';

const listCampaigns = metaService.listCampaigns as jest.Mock;
const deps = {
  getMetaCredentials: jest.fn().mockResolvedValue({ accountId: '123', accessToken: 'tok' }),
  retryBackoffMs: 0,
};
const run = () => listMetaAdsCampaignsNew('user-1', undefined, {}, undefined, deps as any);

const graphError = (code: number, message = `(#${code}) graph error`, extra: Record<string, any> = {}) => {
  const e: any = new Error(message);
  e.structuredError = { code, message, ...extra };
  return e;
};

beforeEach(() => {
  listCampaigns.mockReset();
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('list_meta_ads_campaigns failure classes (ENG-1890)', () => {
  it('happy path lists campaigns', async () => {
    listCampaigns.mockResolvedValue({ campaigns: [{ id: '1', name: 'A' }], truncated: false });
    const r = await run();
    expect(r.success).not.toBe(false);
    expect(r.campaigns).toHaveLength(1);
  });

  it.each([190, 200, 10, 272])('auth/permission code %s is a typed credential result with reconnect guidance', async code => {
    listCampaigns.mockRejectedValue(graphError(code));
    const r = await run();
    expect(r.success).toBe(false);
    expect(r.errorClass).toBe('auth');
    expect(r.errorType).toBe('configuration');
    expect(r.message).toMatch(code === 190 ? /reconnect Meta/i : /permission/i);
    if (code !== 190) expect(r.message).not.toMatch(/reconnect Meta/i);
    expect(listCampaigns).toHaveBeenCalledTimes(1); // never retried
  });

  it.each([1, 2, 4, 17, 341])('transient code %s is retried (bounded) then typed transient', async code => {
    listCampaigns.mockRejectedValue(graphError(code));
    const r = await run();
    expect(listCampaigns).toHaveBeenCalledTimes(3);
    expect(r.success).toBe(false);
    expect(r.errorType).toBe('transient');
    expect(['rate_limit', 'upstream_5xx']).toContain(r.errorClass);
  });

  it('transient failure that recovers on retry returns campaigns', async () => {
    listCampaigns.mockRejectedValueOnce(graphError(2)).mockResolvedValue({ campaigns: [{ id: '9' }] });
    const r = await run();
    expect(listCampaigns).toHaveBeenCalledTimes(2);
    expect(r.campaigns).toHaveLength(1);
  });

  it('OAuthException is not token evidence by type alone (code 100 / 80004)', () => {
    const throttled: any = new Error('User request limit reached');
    throttled.structuredError = { type: 'OAuthException', code: 80004 };
    expect(classifyMetaReadFailure(throttled)).toEqual({ kind: 'transient', errorClass: 'rate_limit' });
    const badField: any = new Error('(#100) Tried accessing nonexisting field');
    badField.structuredError = { type: 'OAuthException', code: 100 };
    expect(classifyMetaReadFailure(badField).tokenInvalid).toBeUndefined();
    expect(classifyMetaReadFailure(badField).kind).toBe('handler');
    const expired: any = new Error('Error validating access token');
    expired.structuredError = { type: 'OAuthException', code: 190 };
    expect(classifyMetaReadFailure(expired).tokenInvalid).toBe(true);
  });

  it('HTTP 5xx and read timeouts are transient', async () => {
    const e5xx: any = new Error('Meta API Error: boom'); e5xx.status = 503;
    expect(classifyMetaReadFailure(e5xx)).toEqual({ kind: 'transient', errorClass: 'upstream_5xx' });
    const t = new Error('Meta campaign list did not respond within 30000ms');
    expect(classifyMetaReadFailure(t)).toEqual({ kind: 'transient', errorClass: 'timeout' });
    listCampaigns.mockRejectedValue(t);
    const r = await run();
    expect(listCampaigns).toHaveBeenCalledTimes(3);
    expect(r.errorClass).toBe('timeout');
  });

  it.each([
    ['missing campaigns array', { data: [] }],
    ['null response', null],
    ['array response', [{ id: '1' }]],
  ])('unexpected shape (%s) is a typed handler error, not a throw', async (_label, shape) => {
    listCampaigns.mockResolvedValue(shape);
    const r = await run();
    expect(r.success).toBe(false);
    expect(r.errorClass).toBe('invalid_output');
    expect(r.errorType).toBe('handler');
    expect(JSON.stringify(r)).not.toContain('tok');
  });

  it('paging cursor errors are typed handler errors', async () => {
    listCampaigns.mockRejectedValue(new Error('Invalid paging cursor'));
    const r = await run();
    expect(r.errorClass).toBe('invalid_output');
    expect(listCampaigns).toHaveBeenCalledTimes(1);
  });

  it('telemetry: the returned errorClass survives into classifyToolErrorClass', async () => {
    const cases: Array<[any, string]> = [
      [graphError(190), 'auth'],
      [graphError(17), 'rate_limit'],
      [graphError(1), 'upstream_5xx'],
    ];
    for (const [err, expected] of cases) {
      listCampaigns.mockReset().mockRejectedValue(err);
      const r = await run();
      const asError = toolResultError(r);
      expect(asError).toBeInstanceOf(Error);
      expect(classifyToolErrorClass(asError)).toBe(expected);
    }
  });

  it('thrown Meta auth errors carry toolErrorClass=auth', async () => {
    const e: any = new Error('reconsent'); e.isMetaAuthError = true;
    listCampaigns.mockRejectedValue(e);
    await expect(run()).rejects.toMatchObject({ toolErrorClass: 'auth' });
    expect(classifyToolErrorClass(e)).toBe('auth');
  });
});
