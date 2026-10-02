import {
  MetaWriteRateShaper, metaWriteRateShaper, META_BURST_THRESHOLD, META_BURST_WINDOW_MS, META_BUDGET_WINDOW_MS,
} from '../services/agentMode/metaWriteRateShaper';
import { AgentModeService } from '../services/agentModeService';
import { metaService } from '../services/metaService';

describe('ENG-2280 MetaWriteRateShaper', () => {
  let now = 0;
  const clock = () => now;
  beforeEach(() => { now = 1_000_000; });

  it('never sends a 5th budget edit to one object inside an hour, with a retry-after', () => {
    const shaper = new MetaWriteRateShaper(clock);
    for (let i = 1; i <= 4; i++) {
      expect(shaper.shapeWrite('act', 'AD_SET', 'UPDATE', 'as1', { daily_budget: 100 + i }).kind).toBe('send');
      now += 60_000;
    }
    const fifth: any = shaper.shapeWrite('act', 'AD_SET', 'UPDATE', 'as1', { daily_budget: 200 });
    expect(fifth.kind).toBe('throttled');
    expect(fifth.reason).toBe('budget_edit_limit');
    expect(fifth.retryAfterMs).toBe(META_BUDGET_WINDOW_MS - 4 * 60_000);
    expect(fifth.message).toContain('1487225');
    // Another object is unaffected; the first frees up once its oldest edit ages out.
    expect(shaper.shapeWrite('act', 'AD_SET', 'UPDATE', 'as2', { daily_budget: 200 }).kind).toBe('send');
    now += fifth.retryAfterMs;
    expect(shaper.shapeWrite('act', 'AD_SET', 'UPDATE', 'as1', { daily_budget: 200 }).kind).toBe('send');
  });

  it('coalesces a repeat of the last sent budget without consuming a slot', () => {
    const shaper = new MetaWriteRateShaper(clock);
    expect(shaper.shapeWrite('act', 'CAMPAIGN', 'UPDATE', 'c1', { budget_amount: 50 }).kind).toBe('send');
    for (let i = 0; i < 10; i++) expect(shaper.shapeWrite('act', 'CAMPAIGN', 'UPDATE', 'c1', { budget_amount: 50 }).kind).toBe('coalesced');
    for (let i = 0; i < 3; i++) expect(shaper.shapeWrite('act', 'CAMPAIGN', 'UPDATE', 'c1', { budget_amount: 60 + i }).kind).toBe('send');
  });

  it('non-budget updates are not budget-throttled', () => {
    const shaper = new MetaWriteRateShaper(clock);
    for (let i = 0; i < 8; i++) expect(shaper.shapeWrite('act', 'CAMPAIGN', 'UPDATE', 'c1', { name: `n${i}` }).kind).toBe('send');
  });

  it('releasing a failed edit returns its slot', () => {
    const shaper = new MetaWriteRateShaper(clock);
    for (let i = 0; i < 4; i++) shaper.shapeWrite('act', 'AD_SET', 'UPDATE', 'as1', { daily_budget: i + 1 });
    shaper.releaseBudgetEdit('AD_SET', 'as1');
    expect(shaper.shapeWrite('act', 'AD_SET', 'UPDATE', 'as1', { daily_budget: 9 }).kind).toBe('send');
  });

  it('burst score (read=1, write=3) refuses at threshold and recovers after the window (mocked clock)', () => {
    const shaper = new MetaWriteRateShaper(clock);
    for (let i = 0; i < 30; i++) shaper.recordRead('act');            // 30 pts
    for (let i = 0; i < 10; i++) {                                     // +30 pts = 60
      expect(shaper.shapeWrite('act', 'AD', 'CREATE', undefined, {}).kind).toBe('send');
    }
    const refused: any = shaper.shapeWrite('act', 'AD', 'CREATE', undefined, {});
    expect(refused.kind).toBe('throttled');
    expect(refused.reason).toBe('burst_limit');
    expect(refused.message).toContain(`${META_BURST_THRESHOLD}`);
    expect(shaper.shapeWrite('other', 'AD', 'CREATE', undefined, {}).kind).toBe('send');
    now += META_BURST_WINDOW_MS;
    expect(shaper.shapeWrite('act', 'AD', 'CREATE', undefined, {}).kind).toBe('send');
  });
});

describe('ENG-2280 wiring', () => {
  afterEach(() => jest.restoreAllMocks());

  it('Meta subcode 1487225 surfaces as a throttle message, not a generic failure', () => {
    const service = new AgentModeService();
    const msg = (service as any).enrichMetaError(
      { message: 'Invalid parameter', structuredError: { code: 17, error_subcode: 1487225 } }, 'update Meta ad set',
    );
    expect(msg).toContain('budget-edit limit');
    expect(msg).toContain('1487225');
    expect(msg).not.toBe('Invalid parameter');
  });

  it('the authorized dispatch path never sends the 5th budget edit', async () => {
    metaWriteRateShaper.reset();
    const service = new AgentModeService();
    jest.spyOn(service as any, 'getMetaCredentials').mockResolvedValue({ accountId: 'act_eng2280', accessToken: 'token' });
    jest.spyOn(metaService, 'getAdAccountCurrency').mockResolvedValue('USD');
    // ENG-2279 prior read: each edit is a <=2x change, so the anomaly gate passes.
    jest.spyOn(metaService, 'getAdSet').mockResolvedValue({ id: 'adset_eng2280', daily_budget: '5000' } as any);
    const write = jest.spyOn(service, 'updateMetaAdsAdSet').mockResolvedValue({ success: true } as any);
    const dispatch = (budget: number) => (service as any).dispatchAuthorizedMetaWrite(
      'user', 'AD_SET', 'UPDATE', 'act_eng2280', undefined, 'adset_eng2280', undefined, { daily_budget: budget }, false, undefined,
    );
    for (let i = 1; i <= 4; i++) expect((await dispatch(40 + i)).success).toBe(true);
    const fifth = await dispatch(60);
    expect(fifth.success).toBe(false);
    expect((fifth as any).throttled).toBe(true);
    expect((fifth as any).retryAfterMs).toBeGreaterThan(0);
    expect(write).toHaveBeenCalledTimes(4);
  });
});
