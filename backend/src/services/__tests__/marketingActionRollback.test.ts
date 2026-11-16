import { classifyMarketingActionRisk } from '../marketingActionRisk';
import { buildRollbackPlan } from '../marketingActionRollback';

const snap = { entityId: 'e1', status: 'ACTIVE', dailyBudget: 5000, bidAmount: 120 };

describe('buildRollbackPlan (ENG-2890)', () => {
  it.each([
    ['pause_ad', 'ad', 'set_status', 'status', 'ACTIVE'],
    ['kill_adset', 'adset', 'set_status', 'status', 'ACTIVE'],
    ['pause_campaign', 'campaign', 'set_status', 'status', 'ACTIVE'],
    ['activate_ad', 'ad', 'set_status', 'status', 'ACTIVE'],
    ['resume', 'adset', 'set_status', 'status', 'ACTIVE'],
    ['scale_budget', 'adset', 'set_daily_budget', 'dailyBudget', 5000],
    ['decrease_budget', 'campaign', 'set_daily_budget', 'dailyBudget', 5000],
    ['raise_bid', 'ad', 'set_bid_amount', 'bidAmount', 120],
    ['lower_bid', 'adset', 'set_bid_amount', 'bidAmount', 120],
  ])('%s/%s -> exact inverse %s', (actionType, objectLevel, inv, field, value) => {
    const plan = buildRollbackPlan({ actionType, objectLevel, owned: true, entityId: 'e1' }, snap);
    expect(plan).toEqual({
      reversible: true,
      inverse: { actionType: inv, objectLevel, entityId: 'e1', field, value },
      reason: expect.any(String),
    });
  });

  it.each([
    'delete_ad', 'delete_campaign', 'archive_campaign', 'update_conversion', 'change_optimization_goal',
    'update_targeting', 'expand_audience', 'refresh_creative', 'change_account_spend_limit',
    'launch_campaign', 'teleport_budget', 'constructor', '',
  ])('%s fails closed', (actionType) => {
    expect(buildRollbackPlan({ actionType, objectLevel: 'adset', owned: true, entityId: 'e1' }, snap))
      .toMatchObject({ reversible: false, reason: expect.any(String) });
  });

  it('fails closed on account level, unowned, verb/level mismatch, missing level or entity id', () => {
    for (const a of [
      { actionType: 'pause_ad', objectLevel: 'account', owned: true, entityId: 'e1' },
      { actionType: 'pause_ad', objectLevel: 'ad', owned: false, entityId: 'e1' },
      { actionType: 'pause_ad', objectLevel: 'ad', entityId: 'e1' },
      { actionType: 'pause_campaign', objectLevel: 'ad', owned: true, entityId: 'e1' },
      { actionType: 'scale_budget', owned: true, entityId: 'e1' },
      { actionType: 'pause_ad', objectLevel: 'ad', owned: true },
    ]) expect(buildRollbackPlan(a, snap).reversible).toBe(false);
  });

  it('never guesses from a missing or mismatched snapshot', () => {
    const a = { actionType: 'scale_budget', objectLevel: 'adset', owned: true, entityId: 'e1' };
    expect(buildRollbackPlan(a, null).reversible).toBe(false);
    expect(buildRollbackPlan(a, { ...snap, entityId: 'e2' }).reversible).toBe(false);
    expect(buildRollbackPlan(a, { entityId: 'e1', status: 'ACTIVE' }).reversible).toBe(false);
    expect(buildRollbackPlan(a, { entityId: 'e1', dailyBudget: NaN }).reversible).toBe(false);
    expect(buildRollbackPlan({ ...a, actionType: 'pause_adset' }, { entityId: 'e1', status: ' ' }).reversible).toBe(false);
    expect(buildRollbackPlan(null, snap).reversible).toBe(false);
  });

  it('is pure: deterministic and does not mutate inputs', () => {
    const a = Object.freeze({ actionType: 'raise_bid', objectLevel: 'ad', owned: true, entityId: 'e1' });
    const s = Object.freeze({ ...snap });
    expect(buildRollbackPlan(a, s)).toEqual(buildRollbackPlan({ ...a }, { ...s }));
  });

  it('is consistent with ENG-2775: every owned reversible-low action has a plan', () => {
    const verbs = ['pause', 'pause_ad', 'pause_adset', 'pause_campaign', 'kill', 'kill_ad', 'kill_adset'];
    for (const actionType of verbs) for (const objectLevel of ['ad', 'adset', 'campaign', 'account']) {
      const input = { actionType, objectLevel, owned: true, entityId: 'e1' };
      const c = classifyMarketingActionRisk(input);
      const plan = buildRollbackPlan(input, snap);
      if (c.riskClass === 'reversible_low') expect(plan.reversible).toBe(true);
      if (!c.requiresApproval) expect(plan.reversible).toBe(true);
    }
  });
});
