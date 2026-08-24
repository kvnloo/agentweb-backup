import { projectWorkPlanForCustomer } from '../services/workPlanCustomerProjection';

describe('customer work plan projection', () => {
  const plan = { planId: 'meta', title: 'Meta Ads', description: '<b>Build</b> a campaign', category: 'Paid Ads', visibility: 'public' as const, steps: [{ stepCount: 1, title: 'Create campaign', userInstructions: 'secret' }] };

  it('uses safe legacy fallbacks without leaking instructions', () => {
    const result = projectWorkPlanForCustomer({
      ...plan,
      userInstructions: 'top-level secret',
      secret: 'also secret',
    });
    expect(result).toEqual(expect.objectContaining({
      title: 'Meta Ads', summary: 'Build a campaign', categories: ['paid-ads'], steps: [{ position: 1, label: 'Create campaign' }], nextPlanIds: [],
    }));
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(JSON.stringify(result)).not.toContain('userInstructions');
  });

  it('uses display labels and author-approved next plans', () => {
    expect(projectWorkPlanForCustomer({ ...plan, display: { version: 1, title: 'Launch Meta', stepLabels: ['Build ads'], nextPlanIds: ['landing'] } }))
      .toEqual(expect.objectContaining({ title: 'Launch Meta', nextPlanIds: ['landing'], steps: [{ position: 1, label: 'Build ads' }] }));
  });

  it('keeps original step positions and display labels when malformed steps are omitted', () => {
    const result = projectWorkPlanForCustomer({
      ...plan,
      steps: [
        { stepCount: 1, title: null },
        { stepCount: 2, title: 'Create campaign' },
      ],
      display: { version: 1, stepLabels: ['Ignored', 'Build ads'] },
    });
    expect(result?.steps).toEqual([{ position: 2, label: 'Build ads' }]);
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

  // Regression: a malformed display block (e.g. written before this validator
  // existed, or corrupted by a cross-environment sync) must fall back
  // field-by-field, not pass a wrong-shaped value through to a customer
  // client that trusts categories/channel/suite/nextPlanIds to be well-formed.
  it('falls back to [] for a non-array categories value instead of re-exposing it', () => {
    const result = projectWorkPlanForCustomer({ ...plan, display: { version: 1, categories: 'paid-ads' as any } });
    expect(result?.categories).toEqual(['paid-ads']); // legacy `category` fallback, not the malformed value
  });

  it('drops an unknown category value from an otherwise-array categories field', () => {
    const result = projectWorkPlanForCustomer({ ...plan, display: { version: 1, categories: ['not-a-real-category'] as any } });
    expect(result?.categories).toEqual(['paid-ads']); // falls back to legacy `category`, never ['not-a-real-category']
  });

  it('omits channel when it is not one of the closed enum values', () => {
    const result = projectWorkPlanForCustomer({ ...plan, display: { version: 1, channel: 'carrier-pigeon' as any } });
    expect(result?.channel).toBeUndefined();
  });

  it('omits suite when its shape is malformed (missing/invalid fields)', () => {
    const result = projectWorkPlanForCustomer({ ...plan, display: { version: 1, suite: { id: 'INVALID ID!', name: 'X', position: 1 } as any } });
    expect(result?.suite).toBeUndefined();
  });

  it('omits suite when position is out of range', () => {
    const result = projectWorkPlanForCustomer({ ...plan, display: { version: 1, suite: { id: 'valid-id', name: 'X', position: 999 } as any } });
    expect(result?.suite).toBeUndefined();
  });

  it('falls back to [] for a non-array nextPlanIds value', () => {
    const result = projectWorkPlanForCustomer({ ...plan, display: { version: 1, nextPlanIds: 'not-an-array' as any } });
    expect(result?.nextPlanIds).toEqual([]);
  });

  it('drops non-string entries from nextPlanIds instead of passing them through', () => {
    const result = projectWorkPlanForCustomer({ ...plan, display: { version: 1, nextPlanIds: ['valid-id', 123, null] as any } });
    expect(result?.nextPlanIds).toEqual(['valid-id']);
  });

  it('includes thumbnail when the plan has a valid thumbnail_url', () => {
    const result = projectWorkPlanForCustomer({ ...plan, thumbnail_url: 'https://cdn.example.com/x.png', thumbnail_alt_text: 'A campaign icon' });
    expect(result?.thumbnail).toEqual({ url: 'https://cdn.example.com/x.png', alt: 'A campaign icon' });
  });

  it('omits thumbnail when the plan has no thumbnail_url', () => {
    expect(projectWorkPlanForCustomer(plan)?.thumbnail).toBeUndefined();
  });
});
