/**
 * getMonthlyAmount tests (ENG-2257).
 *
 * Seat billing (ENG-2243..2246) put a second item — the extra-seat line
 * item — on the same subscription as the plan item. `getMonthlyAmount` was
 * written back when a subscription could only ever have one item and picked
 * it via `items.data[0]`. These tests pin that MRR is always priced off the
 * PLAN item regardless of which item Stripe happens to return first in
 * `items.data` — mirroring the seat-ordering regression guard already
 * established for `routes/stripe.ts` in stripeUpgrade.test.ts /
 * stripeDowngrade.test.ts.
 */

const mockStripe = {
  subscriptions: { list: jest.fn() },
};

jest.mock('stripe', () => {
  return jest.fn().mockImplementation(() => mockStripe);
});

jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn(),
    getUserByEmail: jest.fn(),
    updateUser: jest.fn(),
    getAllUsers: jest.fn(),
    scanWithFilter: jest.fn(),
  },
  orgDb: {
    getOrgById: jest.fn(),
    updateOrg: jest.fn(),
  },
  User: {},
}));

jest.mock('../services/waitlistDb', () => ({
  waitlistDb: { getByEmail: jest.fn(), updateDetails: jest.fn(), add: jest.fn() },
  WaitlistEntry: {},
}));

process.env.STRIPE_SECRET_KEY = 'sk_test_fake';

import { getMonthlyAmount } from '../services/revenueService';

const PLAN_ITEM = {
  id: 'si_plan',
  price: { id: 'price_starter_123', product: 'prod_plan', unit_amount: 2900, recurring: { interval: 'month' } },
};

const SEAT_ITEM = {
  id: 'si_seat',
  quantity: 3,
  price: { id: 'price_seat_dynamic_1', product: 'prod_extra_seat', unit_amount: 5000, recurring: { interval: 'month' } },
};

function makeSub(items: any[]): any {
  return {
    id: 'sub_test',
    items: { data: items },
    discounts: [],
  };
}

describe('getMonthlyAmount', () => {
  const ORIGINAL_SEAT_PRODUCT_ID = process.env.STRIPE_EXTRA_SEAT_PRODUCT_ID;

  afterEach(() => {
    if (ORIGINAL_SEAT_PRODUCT_ID === undefined) {
      delete process.env.STRIPE_EXTRA_SEAT_PRODUCT_ID;
    } else {
      process.env.STRIPE_EXTRA_SEAT_PRODUCT_ID = ORIGINAL_SEAT_PRODUCT_ID;
    }
  });

  it('prices a single-item (pre-seat-billing) subscription off that item, unaffected', () => {
    const sub = makeSub([PLAN_ITEM]);
    expect(getMonthlyAmount(sub)).toBe(2900);
  });

  it('prices MRR off the PLAN item when the plan item sorts first in items.data', () => {
    process.env.STRIPE_EXTRA_SEAT_PRODUCT_ID = 'prod_extra_seat';
    const sub = makeSub([PLAN_ITEM, SEAT_ITEM]);
    expect(getMonthlyAmount(sub)).toBe(2900);
  });

  it('prices MRR off the PLAN item (not the seat item) when the seat item sorts FIRST in items.data', () => {
    process.env.STRIPE_EXTRA_SEAT_PRODUCT_ID = 'prod_extra_seat';
    const sub = makeSub([SEAT_ITEM, PLAN_ITEM]);
    // Before the ENG-2257 fix, `items.data[0]` would read the seat item's
    // $50 price instead of the plan's $29 price.
    expect(getMonthlyAmount(sub)).toBe(2900);
  });

  it('falls back to items.data[0] when STRIPE_EXTRA_SEAT_PRODUCT_ID is not configured', () => {
    delete process.env.STRIPE_EXTRA_SEAT_PRODUCT_ID;
    const sub = makeSub([SEAT_ITEM, PLAN_ITEM]);
    expect(getMonthlyAmount(sub)).toBe(5000);
  });

  it('converts a yearly PLAN price to its monthly equivalent even with a seat item present', () => {
    process.env.STRIPE_EXTRA_SEAT_PRODUCT_ID = 'prod_extra_seat';
    const yearlyPlan = {
      id: 'si_plan_yearly',
      price: { id: 'price_pro_yearly', product: 'prod_plan', unit_amount: 118800, recurring: { interval: 'year' } },
    };
    const sub = makeSub([SEAT_ITEM, yearlyPlan]);
    expect(getMonthlyAmount(sub)).toBe(9900);
  });

  it('applies a percent-off discount to the PLAN item amount, not the seat item', () => {
    process.env.STRIPE_EXTRA_SEAT_PRODUCT_ID = 'prod_extra_seat';
    const sub = makeSub([SEAT_ITEM, PLAN_ITEM]);
    sub.discounts = [{ coupon: { percent_off: 50 } }];
    expect(getMonthlyAmount(sub)).toBe(1450);
  });

  it('returns 0 when the subscription has no items', () => {
    const sub = makeSub([]);
    expect(getMonthlyAmount(sub)).toBe(0);
  });
});
