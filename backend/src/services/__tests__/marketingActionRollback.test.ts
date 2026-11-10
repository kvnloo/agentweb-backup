import { buildMarketingActionRollbackPlan } from '../marketingActionRollback';
import { classifyMarketingActionRisk } from '../marketingActionRisk';

const snap = (over: Record<string, unknown> = {}) => ({
  entityId: 'e1', objectLevel: 'adset', status: 'ACTIVE', dailyBudget: 5000, bidAmount: 120, ...over,
});

describe('buildMarketingActionRollbackPlan (ENG-2890)', () => {
  it.each([
    ['pause_adset', 'adset', 'status', 'ACTIVE'],
    ['kill_adset', 'adset', 'status', 'ACTIVE'],
    ['activate_adset', 'adset', 'status', 'ACTIVE'],
    ['pause_campaign', 'campaign', 'status', 'ACTIVE'],
    ['scale_budget', 'adset', 'dailyBudget', 5000],
    ['decrease_budget', 'campaign', 'dailyBudget', 5000],
    ['raise_bid', 'ad', 'bidAmount', 120],
    ['lower_bid', 'ad', 'bidAmount', 120],
  ])('%s on %s restores %s', (actionType, objectLevel, field, value) => {
    const plan = buildMarketingActionRollbackPlan(
      { actionType, objectLevel, owned: true, entityId: 'e1' },
      snap({ objectLevel }),
    );
    expect(plan).toMatchObject({ reversible: true, inverse: { objectLevel, entityId: 'e1', field, value } });
  });

  it.each([
    ['delete_ad', 'ad'], ['archive_campaign', 'campaign'], ['update_conversion', 'campaign'],
    ['expand_audience', 'adset'], ['update_targeting', 'adset'], ['refresh_creative', 'ad'],
    ['change_account_spend_limit', 'campaign'], ['pause_ad', 'account'], ['teleport', 'ad'], ['', 'ad'],
  ])('%s/%s is not reversible (fail closed)', (actionType, objectLevel) => {
    const plan = buildMarketingActionRollbackPlan(
      { actionType, objectLevel, owned: true, entityId: 'e1' }, snap({ objectLevel }),
    );
    expect(plan.reversible).toBe(false);
  });

  it('fails closed on missing or mismatched snapshot', () => {
    const input = { actionType: 'scale_budget', objectLevel: 'adset', owned: true, entityId: 'e1' };
    expect(buildMarketingActionRollbackPlan(input, null).reversible).toBe(false);
    expect(buildMarketingActionRollbackPlan(input, snap({ entityId: 'e2' })).reversible).toBe(false);
    expect(buildMarketingActionRollbackPlan(input, snap({ objectLevel: 'ad' })).reversible).toBe(false);
    expect(buildMarketingActionRollbackPlan(input, snap({ dailyBudget: undefined })).reversible).toBe(false);
    expect(buildMarketingActionRollbackPlan(input, snap({ dailyBudget: NaN })).reversible).toBe(false);
    expect(buildMarketingActionRollbackPlan({ ...input, entityId: '' }, snap()).reversible).toBe(false);
    expect(
      buildMarketingActionRollbackPlan({ ...input, actionType: 'pause_adset' }, snap({ status: '' })).reversible,
    ).toBe(false);
    expect(buildMarketingActionRollbackPlan(null, snap()).reversible).toBe(false);
  });

  it('rejects a level-qualified verb whose objectLevel disagrees', () => {
    const plan = buildMarketingActionRollbackPlan(
      { actionType: 'activate_campaign', objectLevel: 'adset', owned: true, entityId: 'e1' }, snap(),
    );
    expect(plan.reversible).toBe(false);
  });

  it('is pure and deterministic (inputs untouched, same output)', () => {
    const input = Object.freeze({ actionType: 'raise_bid', objectLevel: 'adset', owned: true, entityId: 'e1' });
    const s = Object.freeze(snap());
    const a = buildMarketingActionRollbackPlan(input, s);
    expect(buildMarketingActionRollbackPlan(input, s)).toEqual(a);
  });

  it('every classifier reversible_low action has a rollback plan given a valid snapshot', () => {
    const verbs = ['pause', 'pause_ad', 'pause_adset', 'pause_campaign', 'kill', 'kill_ad', 'kill_adset'];
    for (const actionType of verbs) for (const objectLevel of ['ad', 'adset', 'campaign']) for (const owned of [true, false]) {
      const cls = classifyMarketingActionRisk({ actionType, objectLevel, owned });
      if (cls.riskClass !== 'reversible_low') continue;
      const plan = buildMarketingActionRollbackPlan({ actionType, objectLevel, owned, entityId: 'e1' }, snap({ objectLevel }));
      expect(plan).toMatchObject({ reversible: true, riskClass: 'reversible_low' });
    }
  });
});
