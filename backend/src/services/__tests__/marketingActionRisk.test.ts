import { classifyMarketingActionRisk } from '../marketingActionRisk';

describe('classifyMarketingActionRisk (ENG-2775)', () => {
  it.each([
    ['pause_ad', 'ad', true, 'reversible_low', false],
    ['kill_adset', 'adset', true, 'reversible_low', false],
    ['PAUSE', ' AdSet ', true, 'reversible_low', false],
    ['pause_campaign', 'campaign', true, 'reversible_low', true],
    ['pause_ad', 'ad', false, 'reversible_low', true],
    ['pause_ad', 'ad', undefined, 'reversible_low', true],
    ['pause_ad', undefined, true, 'unknown', true],
    ['pause_ad', 'account', true, 'account_wide', true],
    ['scale_budget', 'adset', true, 'spend_increase', true],
    ['raise_bid', 'ad', true, 'spend_increase', true],
    ['decrease_budget', 'adset', true, 'spend_decrease', true],
    ['update_conversion', 'campaign', true, 'conversion_definition', true],
    ['expand_audience', 'adset', true, 'targeting', true],
    ['activate_ad', 'ad', true, 'activation', true],
    ['resume', 'adset', true, 'activation', true],
    ['delete_campaign', 'campaign', true, 'destructive', true],
    ['change_account_spend_limit', 'campaign', true, 'account_wide', true],
    ['refresh_creative', 'ad', true, 'creative_change', true],
    ['teleport_budget', 'ad', true, 'unknown', true],
    ['constructor', 'ad', true, 'unknown', true],
    ['', 'ad', true, 'unknown', true],
  ])('%s/%s owned=%s -> %s approval=%s', (actionType, objectLevel, owned, riskClass, requiresApproval) => {
    const r = classifyMarketingActionRisk({ actionType, objectLevel, owned } as never);
    expect(r.riskClass).toBe(riskClass);
    expect(r.requiresApproval).toBe(requiresApproval);
    expect(r.reason).toEqual(expect.any(String));
  });

  it('fails closed on null/garbage input', () => {
    expect(classifyMarketingActionRisk(null).requiresApproval).toBe(true);
    expect(classifyMarketingActionRisk({ actionType: 42 } as never).riskClass).toBe('unknown');
  });

  it('is deterministic and tenant-agnostic (extra fields ignored, same output)', () => {
    const a = classifyMarketingActionRisk({ actionType: 'pause_ad', objectLevel: 'ad', owned: true });
    const b = classifyMarketingActionRisk({
      actionType: 'pause_ad', objectLevel: 'ad', owned: true, orgId: 'other-tenant', accountId: 'x',
    } as never);
    expect(b).toEqual(a);
    expect(classifyMarketingActionRisk({ actionType: 'pause_ad', objectLevel: 'ad', owned: true })).toEqual(a);
  });

  it('never auto-approves anything but an owned ad/adset pause or kill', () => {
    const verbs = ['scale_budget', 'increase_budget', 'raise_bid', 'update_targeting', 'activate', 'delete', 'update_conversion'];
    for (const actionType of verbs) for (const objectLevel of ['ad', 'adset', 'campaign', 'account']) {
      expect(classifyMarketingActionRisk({ actionType, objectLevel, owned: true }).requiresApproval).toBe(true);
    }
  });

  it('rejects a level-qualified verb whose objectLevel disagrees (no auto)', () => {
    for (const [actionType, objectLevel] of [
      ['pause_campaign', 'ad'], ['pause_campaign', 'adset'], ['pause_ad', 'adset'],
      ['pause_adset', 'ad'], ['kill_ad', 'adset'], ['kill_adset', 'ad'],
    ]) {
      expect(classifyMarketingActionRisk({ actionType, objectLevel, owned: true })).toMatchObject({
        riskClass: 'unknown', requiresApproval: true,
      });
    }
    expect(classifyMarketingActionRisk({ actionType: 'pause_adset', objectLevel: 'adset', owned: true }).requiresApproval).toBe(false);
  });
});
