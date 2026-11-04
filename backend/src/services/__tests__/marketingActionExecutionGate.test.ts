import { classifyMarketingActionRisk } from '../marketingActionRisk';
import {
  authorizeExecution,
  buildRollback,
  hashMarketingMutation,
  ProposedMarketingMutation,
} from '../marketingActionExecutionGate';

const mut = (over: Partial<ProposedMarketingMutation> = {}): ProposedMarketingMutation => ({
  actionType: 'pause_ad',
  objectLevel: 'ad',
  objectId: 'ad_1',
  owned: true,
  changes: { status: 'PAUSED' },
  ...over,
});

const gate = (m: ProposedMarketingMutation, approve?: 'exact' | ProposedMarketingMutation) =>
  authorizeExecution(
    m,
    classifyMarketingActionRisk(m),
    approve ? { payloadHash: hashMarketingMutation(approve === 'exact' ? m : approve) } : undefined,
  );

describe('authorizeExecution (ENG-2797)', () => {
  it('allows owned ad pause under standing authorization', () => {
    expect(gate(mut()).allowed).toBe(true);
  });

  it.each([
    ['scale_budget', 'adset', { daily_budget: 200 }],
    ['update_targeting', 'adset', { targeting: { age_min: 30 } }],
    ['activate_ad', 'ad', { status: 'ACTIVE' }],
    ['delete_ad', 'ad', { status: 'DELETED' }],
    ['update_conversion', 'campaign', { promoted_object: 'x' }],
    ['update_account_settings', 'account', { spend_cap: 1 }],
  ])('%s is refused without explicit approval', (actionType, objectLevel, changes) => {
    expect(gate(mut({ actionType, objectLevel, changes })).allowed).toBe(false);
  });

  it.each([
    ['scale_budget', 'adset', { daily_budget: 200 }],
    ['update_targeting', 'adset', { targeting: { age_min: 30 } }],
    ['activate_ad', 'ad', { status: 'ACTIVE' }],
  ])('%s is allowed with an exact-payload approval', (actionType, objectLevel, changes) => {
    expect(gate(mut({ actionType, objectLevel, changes }), 'exact').allowed).toBe(true);
  });

  it.each([
    ['delete_ad', 'ad', { status: 'DELETED' }],
    ['update_conversion', 'campaign', { promoted_object: 'x' }],
    ['update_account_settings', 'account', { spend_cap: 1 }],
    ['made_up_verb', 'ad', { x: 1 }],
  ])('irreversible %s is refused even with exact approval', (actionType, objectLevel, changes) => {
    expect(gate(mut({ actionType, objectLevel, changes }), 'exact').allowed).toBe(false);
  });

  it.each<[string, Partial<ProposedMarketingMutation>]>([
    ['changes value', { changes: { daily_budget: 201 } }],
    ['objectId', { objectId: 'adset_2' }],
    ['actionType', { actionType: 'increase_budget' }],
    ['owned', { owned: false }],
    ['extra field', { changes: { daily_budget: 200, bid: 1 } }],
  ])('approval differing by %s is refused', (_label, diff) => {
    const proposed = mut({ actionType: 'scale_budget', objectLevel: 'adset', changes: { daily_budget: 200 } });
    const approved = { ...proposed, ...diff };
    expect(gate(proposed, approved).allowed).toBe(false);
  });

  it('hash is key-order independent', () => {
    const a = mut({ changes: { a: 1, b: { c: 2, d: 3 } } });
    const b = { changes: { b: { d: 3, c: 2 }, a: 1 }, owned: true, objectId: 'ad_1', objectLevel: 'ad', actionType: 'pause_ad' };
    expect(hashMarketingMutation(a)).toBe(hashMarketingMutation(b));
  });

  it('fails closed on missing inputs', () => {
    expect(authorizeExecution(null, classifyMarketingActionRisk(mut())).allowed).toBe(false);
    expect(authorizeExecution(mut(), null).allowed).toBe(false);
  });
});

describe('buildRollback (ENG-2797)', () => {
  const prior = { status: 'ACTIVE', daily_budget: 100, bid: 5, creative_id: 'c1', targeting: { age_min: 18 }, placements: ['feed'] };
  const apply = (state: Record<string, unknown>, m: ProposedMarketingMutation) => ({ ...state, ...m.changes });

  it.each<[string, string, Record<string, unknown>]>([
    ['pause_ad', 'ad', { status: 'PAUSED' }],
    ['pause_adset', 'adset', { status: 'PAUSED' }],
    ['pause_campaign', 'campaign', { status: 'PAUSED' }],
    ['kill_ad', 'ad', { status: 'PAUSED' }],
    ['activate_ad', 'ad', { status: 'ACTIVE' }],
    ['resume', 'adset', { status: 'ACTIVE' }],
    ['launch_campaign', 'campaign', { status: 'ACTIVE' }],
    ['scale_budget', 'adset', { daily_budget: 200 }],
    ['increase_budget', 'adset', { daily_budget: 150 }],
    ['decrease_budget', 'adset', { daily_budget: 50 }],
    ['raise_bid', 'ad', { bid: 7 }],
    ['increase_bid', 'ad', { bid: 8 }],
    ['lower_bid', 'ad', { bid: 3 }],
    ['refresh_creative', 'ad', { creative_id: 'c2' }],
    ['swap_creative', 'ad', { creative_id: 'c3' }],
    ['update_creative', 'ad', { creative_id: 'c4' }],
    ['update_targeting', 'adset', { targeting: { age_min: 30 } }],
    ['expand_audience', 'adset', { targeting: { age_min: 13 } }],
    ['narrow_audience', 'adset', { targeting: { age_min: 40 } }],
    ['change_placements', 'adset', { placements: ['stories'] }],
  ])('round-trips %s back to prior state', (actionType, objectLevel, changes) => {
    const m = mut({ actionType, objectLevel, changes });
    const rollback = buildRollback(m, prior);
    expect(rollback).not.toBeNull();
    expect(rollback!.objectId).toBe(m.objectId);
    expect(apply(apply(prior, m), rollback!)).toEqual(prior);
  });

  it.each<[string, string]>([
    ['delete_ad', 'ad'],
    ['archive_campaign', 'campaign'],
    ['update_conversion', 'campaign'],
    ['change_optimization_goal', 'campaign'],
    ['change_account_spend_limit', 'account'],
    ['pause_ad', 'account'],
    ['unknown_verb', 'ad'],
  ])('%s at %s is irreversible (null)', (actionType, objectLevel) => {
    expect(buildRollback(mut({ actionType, objectLevel, changes: { status: 'X' } }), prior)).toBeNull();
  });

  it('returns null when prior state is missing or lacks a changed field', () => {
    expect(buildRollback(mut(), null)).toBeNull();
    expect(buildRollback(mut({ changes: { status: 'PAUSED', other: 1 } }), prior)).toBeNull();
    expect(buildRollback(mut({ changes: {} }), prior)).toBeNull();
  });
});

describe('ENG-2797 CodeRabbit hardening', () => {
  it('refuses a classification computed for a different mutation', () => {
    const safe = { actionType: 'pause_ad', objectLevel: 'ad', objectId: 'a1', owned: true, changes: { status: 'PAUSED' } };
    const other = { actionType: 'delete_campaign', objectLevel: 'campaign', objectId: 'c1', owned: true, changes: { status: 'DELETED' } };
    expect(authorizeExecution(safe, classifyMarketingActionRisk(safe)).allowed).toBe(true);
    const r = authorizeExecution(other, classifyMarketingActionRisk(safe));
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/does not match/);
  });

  it('hashes an own __proto__ field so it cannot be dropped from the approved payload', () => {
    const base = { actionType: 'scale_budget', objectLevel: 'ad', objectId: 'a1', owned: true, changes: { daily_budget: 10 } };
    const withProto = { ...base, changes: JSON.parse('{"daily_budget":10,"__proto__":{"x":1}}') };
    expect(hashMarketingMutation(withProto)).not.toBe(hashMarketingMutation(base));
  });

  it('preserves an own __proto__ field in the rollback inverse', () => {
    const m = { actionType: 'update_targeting', objectLevel: 'ad', objectId: 'a1', owned: true, changes: JSON.parse('{"__proto__":{"a":1}}') };
    const prior = JSON.parse('{"__proto__":{"a":0}}');
    const rb = buildRollback(m, prior);
    expect(rb).not.toBeNull();
    expect(Object.prototype.hasOwnProperty.call(rb!.changes, '__proto__')).toBe(true);
  });
});

