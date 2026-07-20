/**
 * ENG-405: getSubscriptionPeriodEndIso reads the Basil item-level
 * current_period_end, falling back to the legacy root field.
 */
jest.mock('../services/db', () => ({ userDb: {} }));

import { getSubscriptionPeriodEndIso } from '../services/stripeService';

describe('getSubscriptionPeriodEndIso (ENG-405 Basil period-end read)', () => {
  const iso = (epoch: number) => new Date(epoch * 1000).toISOString();

  it('reads the item-level current_period_end (Basil API shape)', () => {
    const sub = { items: { data: [{ current_period_end: 1735689600 }] } };
    expect(getSubscriptionPeriodEndIso(sub)).toBe(iso(1735689600));
  });

  it('falls back to the root current_period_end (legacy / webhook shape)', () => {
    const sub = { current_period_end: 1700000000, items: { data: [{}] } };
    expect(getSubscriptionPeriodEndIso(sub)).toBe(iso(1700000000));
  });

  it('prefers the item-level value when both are present', () => {
    const sub = {
      current_period_end: 1700000000,
      items: { data: [{ current_period_end: 1735689600 }] },
    };
    expect(getSubscriptionPeriodEndIso(sub)).toBe(iso(1735689600));
  });

  it('returns undefined when neither field is present', () => {
    expect(getSubscriptionPeriodEndIso({ items: { data: [{}] } })).toBeUndefined();
    expect(getSubscriptionPeriodEndIso({})).toBeUndefined();
    expect(getSubscriptionPeriodEndIso(null)).toBeUndefined();
  });
});
