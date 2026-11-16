/**
 * ENG-2030 — portal campaign/ad-set tables expose budget, bid strategy, optimization
 * event and learning phase when Meta returns them, and explicit null ("—") when absent.
 */
import { extractDeliveryConfig, ADSET_DELIVERY_FIELDS, CAMPAIGN_DELIVERY_FIELDS } from '../utils/metaDeliveryConfig';

describe('ENG-2030 extractDeliveryConfig', () => {
  it('maps present Graph fields, converting minor-unit budgets to major units', () => {
    expect(extractDeliveryConfig({
      daily_budget: '2500', lifetime_budget: '100000', bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
      optimization_goal: 'OFFSITE_CONVERSIONS', learning_stage_info: { status: 'LEARNING' },
    })).toEqual({ dailyBudget: 25, lifetimeBudget: 1000, bidStrategy: 'LOWEST_COST_WITHOUT_CAP', optimizationGoal: 'OFFSITE_CONVERSIONS', learningPhase: 'LEARNING' });
  });

  it('returns null for every absent field (no fabricated zero budgets)', () => {
    expect(extractDeliveryConfig({ id: '1', name: 'x' })).toEqual({ dailyBudget: null, lifetimeBudget: null, bidStrategy: null, optimizationGoal: null, learningPhase: null });
    expect(extractDeliveryConfig(undefined).dailyBudget).toBeNull();
  });

  it('treats Graph "0" / empty / non-numeric budgets as absent', () => {
    const c = extractDeliveryConfig({ daily_budget: '0', lifetime_budget: 'abc', bid_strategy: '', learning_stage_info: {} });
    expect(c).toEqual({ dailyBudget: null, lifetimeBudget: null, bidStrategy: null, optimizationGoal: null, learningPhase: null });
  });

  it('requests the delivery fields from Graph at both levels', () => {
    expect(CAMPAIGN_DELIVERY_FIELDS.split(',')).toEqual(expect.arrayContaining(['daily_budget', 'lifetime_budget', 'bid_strategy']));
    expect(ADSET_DELIVERY_FIELDS.split(',')).toEqual(expect.arrayContaining(['optimization_goal', 'learning_stage_info']));
  });
});
