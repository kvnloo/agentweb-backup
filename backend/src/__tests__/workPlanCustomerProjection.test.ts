import { projectWorkPlanForCustomer } from '../services/workPlanCustomerProjection';

describe('customer work plan projection', () => {
  const plan = { planId: 'meta', title: 'Meta Ads', description: '<b>Build</b> a campaign', category: 'Paid Ads', visibility: 'public' as const, steps: [{ stepCount: 1, title: 'Create campaign', userInstructions: 'secret' }] };

  it('uses safe legacy fallbacks without leaking instructions', () => {
    expect(projectWorkPlanForCustomer(plan)).toEqual(expect.objectContaining({
      title: 'Meta Ads', summary: 'Build a campaign', categories: ['paid-ads'], steps: [{ position: 1, label: 'Create campaign' }], nextPlanIds: [],
    }));
  });

  it('uses display labels and author-approved next plans', () => {
    expect(projectWorkPlanForCustomer({ ...plan, display: { version: 1, title: 'Launch Meta', stepLabels: ['Build ads'], nextPlanIds: ['landing'] } }))
      .toEqual(expect.objectContaining({ title: 'Launch Meta', nextPlanIds: ['landing'], steps: [{ position: 1, label: 'Build ads' }] }));
  });

  it.each([null, {}, { ...plan, steps: 'wrong' }])('fails closed for malformed records %#', (value) => {
    expect(projectWorkPlanForCustomer(value)).toBeNull();
  });

  it('passes through a next-plan id even when the target no longer exists', () => {
    // No catalog lookup happens in the projection — a deleted/missing target is
    // the runtime recommender's concern (it revalidates before showing one),
    // not something this shallow projection resolves or filters.
    const result = projectWorkPlanForCustomer({
      ...plan,
      display: { version: 1, nextPlanIds: ['deleted-plan-id'] },
    });
    expect(result?.nextPlanIds).toEqual(['deleted-plan-id']);
  });

  it('passes through next-plan ids regardless of the target category or suite', () => {
    const result = projectWorkPlanForCustomer({
      ...plan,
      category: 'Paid Ads',
      display: { version: 1, categories: ['paid-ads'], nextPlanIds: ['content-plan-in-a-different-category'] },
    });
    expect(result?.categories).toEqual(['paid-ads']);
    expect(result?.nextPlanIds).toEqual(['content-plan-in-a-different-category']);
  });

  it('falls back to no recommendations for a legacy record with no display block', () => {
    expect(projectWorkPlanForCustomer(plan)?.nextPlanIds).toEqual([]);
  });
});
