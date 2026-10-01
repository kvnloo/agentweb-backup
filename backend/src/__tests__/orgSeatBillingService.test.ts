// --- Mocks ---
// Follows the same jest.mock('stripe', ...) pattern as
// mrrCollectionGapService.test.ts: a plain mock object returned by the
// mocked SDK constructor, with STRIPE_SECRET_KEY set before import so the
// lazy client initializes against it.

const mockStripe = {
  subscriptions: { retrieve: jest.fn() },
  subscriptionItems: { create: jest.fn(), update: jest.fn(), del: jest.fn() },
};

jest.mock('stripe', () => {
  return jest.fn().mockImplementation(() => mockStripe);
});

process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
process.env.STRIPE_EXTRA_SEAT_PRODUCT_ID = 'prod_extra_seat';

const mockOrgDb = {
  getOrgById: jest.fn(),
  getOrgMemberCount: jest.fn(),
};
const mockUserDb = {
  getUserById: jest.fn(),
};
jest.mock('../services/db', () => ({
  orgDb: mockOrgDb,
  userDb: mockUserDb,
}));

const mockGetUserSubscriptionType = jest.fn();
const mockGetTierConfig = jest.fn();
jest.mock('../services/subscriptionService', () => ({
  getUserSubscriptionType: (...args: any[]) => mockGetUserSubscriptionType(...args),
  getTierConfig: (...args: any[]) => mockGetTierConfig(...args),
}));

import {
  setOrgSeatQuantity,
  purchaseExtraSeat,
  removeExtraSeat,
  findSeatLineItem,
} from '../services/orgSeatBillingService';

const ORG_ID = 'org-acme';
const OWNER_ID = 'u-owner';
const SUB_ID = 'sub_acme';
const PRODUCT_ID = 'prod_extra_seat';

const SEAT_PRICING = { priceCents: 5000, usageCreditMicroUsd: 3_000_000, baseSeats: 2 };

function makeOrg(overrides: Record<string, any> = {}) {
  return { orgId: ORG_ID, ownerUserId: OWNER_ID, name: 'Acme', ...overrides };
}

function makeOwner(overrides: Record<string, any> = {}) {
  return { userId: OWNER_ID, email: 'owner@acme.com', stripe_subscription_id: SUB_ID, ...overrides };
}

function makeSeatItem(overrides: Record<string, any> = {}) {
  return {
    id: 'si_seat',
    quantity: 1,
    price: { product: PRODUCT_ID },
    ...overrides,
  };
}

function makeSubscription(items: any[] = []) {
  return { id: SUB_ID, items: { data: items } };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockOrgDb.getOrgById.mockResolvedValue(makeOrg());
  mockOrgDb.getOrgMemberCount.mockResolvedValue(0);
  mockUserDb.getUserById.mockResolvedValue(makeOwner());
  mockGetUserSubscriptionType.mockResolvedValue('Starter');
  mockGetTierConfig.mockResolvedValue({ name: 'Starter', seatPricing: SEAT_PRICING });
});

describe('findSeatLineItem', () => {
  it('matches a bare string product id', () => {
    const sub = makeSubscription([makeSeatItem({ price: { product: PRODUCT_ID } })]);
    expect(findSeatLineItem(sub as any, PRODUCT_ID)?.id).toBe('si_seat');
  });

  it('matches an expanded Product object by id', () => {
    const sub = makeSubscription([makeSeatItem({ price: { product: { id: PRODUCT_ID } } })]);
    expect(findSeatLineItem(sub as any, PRODUCT_ID)?.id).toBe('si_seat');
  });

  it('returns undefined when no item matches', () => {
    const sub = makeSubscription([makeSeatItem({ price: { product: 'prod_other' } })]);
    expect(findSeatLineItem(sub as any, PRODUCT_ID)).toBeUndefined();
  });

  it('returns undefined for an empty item list', () => {
    expect(findSeatLineItem(makeSubscription([]) as any, PRODUCT_ID)).toBeUndefined();
  });
});

describe('setOrgSeatQuantity', () => {
  it('creates the seat line item with fresh price_data and explicit quantity when none exists', async () => {
    mockStripe.subscriptions.retrieve.mockResolvedValue(makeSubscription([]));

    await setOrgSeatQuantity(ORG_ID, 2);

    expect(mockStripe.subscriptionItems.create).toHaveBeenCalledWith({
      subscription: SUB_ID,
      price_data: {
        currency: 'usd',
        unit_amount: SEAT_PRICING.priceCents,
        product: PRODUCT_ID,
        recurring: { interval: 'month' },
      },
      quantity: 2,
    });
    expect(mockStripe.subscriptionItems.update).not.toHaveBeenCalled();
    expect(mockStripe.subscriptionItems.del).not.toHaveBeenCalled();
  });

  it('updates the existing seat line item with fresh price_data and the new quantity', async () => {
    mockStripe.subscriptions.retrieve.mockResolvedValue(makeSubscription([makeSeatItem({ quantity: 1 })]));

    await setOrgSeatQuantity(ORG_ID, 4);

    expect(mockStripe.subscriptionItems.update).toHaveBeenCalledWith('si_seat', {
      price_data: {
        currency: 'usd',
        unit_amount: SEAT_PRICING.priceCents,
        product: PRODUCT_ID,
        recurring: { interval: 'month' },
      },
      quantity: 4,
    });
    expect(mockStripe.subscriptionItems.create).not.toHaveBeenCalled();
    expect(mockStripe.subscriptionItems.del).not.toHaveBeenCalled();
  });

  // --- The gotcha, pinned directly ---
  //
  // Stripe's own type docs (SubscriptionItemUpdateParams.price) state: "When
  // changing a subscription item's price, `quantity` is set to 1 unless a
  // `quantity` parameter is provided." Every update call that sets
  // `price_data` here MUST also pass `quantity` explicitly, in the SAME
  // call, or a seat add/remove would silently collapse the item back to
  // quantity 1 the next time it reprices.
  //
  // Mutation-checked: commenting out the `quantity: totalExtraSeats` line in
  // orgSeatBillingService.ts's update branch makes this test fail (the call
  // arg would have no `quantity` key at all, so `toHaveBeenCalledWith`'s
  // exact-match fails) — confirmed while writing this test, then restored.
  it('always passes quantity explicitly in the same call that sets price_data (update)', async () => {
    mockStripe.subscriptions.retrieve.mockResolvedValue(makeSubscription([makeSeatItem({ quantity: 1 })]));

    await setOrgSeatQuantity(ORG_ID, 7);

    expect(mockStripe.subscriptionItems.update).toHaveBeenCalledTimes(1);
    const [, updateArgs] = mockStripe.subscriptionItems.update.mock.calls[0];
    expect(updateArgs).toHaveProperty('price_data');
    expect(updateArgs).toHaveProperty('quantity', 7);
  });

  it('always passes quantity explicitly in the same call that sets price_data (create)', async () => {
    mockStripe.subscriptions.retrieve.mockResolvedValue(makeSubscription([]));

    await setOrgSeatQuantity(ORG_ID, 5);

    expect(mockStripe.subscriptionItems.create).toHaveBeenCalledTimes(1);
    const [createArgs] = mockStripe.subscriptionItems.create.mock.calls[0];
    expect(createArgs).toHaveProperty('price_data');
    expect(createArgs).toHaveProperty('quantity', 5);
  });

  it('removes the seat line item entirely when totalExtraSeats is 0 and an item exists', async () => {
    mockStripe.subscriptions.retrieve.mockResolvedValue(makeSubscription([makeSeatItem()]));

    await setOrgSeatQuantity(ORG_ID, 0);

    expect(mockStripe.subscriptionItems.del).toHaveBeenCalledWith('si_seat');
    expect(mockStripe.subscriptionItems.create).not.toHaveBeenCalled();
    expect(mockStripe.subscriptionItems.update).not.toHaveBeenCalled();
    // 0 seats never needs pricing — must not even look it up.
    expect(mockGetTierConfig).not.toHaveBeenCalled();
  });

  it('is a no-op when totalExtraSeats is 0 and no item exists', async () => {
    mockStripe.subscriptions.retrieve.mockResolvedValue(makeSubscription([]));

    await setOrgSeatQuantity(ORG_ID, 0);

    expect(mockStripe.subscriptionItems.del).not.toHaveBeenCalled();
    expect(mockStripe.subscriptionItems.create).not.toHaveBeenCalled();
    expect(mockStripe.subscriptionItems.update).not.toHaveBeenCalled();
  });

  it('rejects a negative or non-integer totalExtraSeats before touching Stripe', async () => {
    await expect(setOrgSeatQuantity(ORG_ID, -1)).rejects.toThrow(/non-negative integer/);
    await expect(setOrgSeatQuantity(ORG_ID, 1.5)).rejects.toThrow(/non-negative integer/);
    expect(mockStripe.subscriptions.retrieve).not.toHaveBeenCalled();
  });

  it('throws when the org has no owner Stripe subscription', async () => {
    mockUserDb.getUserById.mockResolvedValue(makeOwner({ stripe_subscription_id: undefined }));

    await expect(setOrgSeatQuantity(ORG_ID, 1)).rejects.toThrow(/no Stripe subscription/);
    expect(mockStripe.subscriptions.retrieve).not.toHaveBeenCalled();
  });

  it("throws when the owner's tier has no seatPricing configured", async () => {
    mockStripe.subscriptions.retrieve.mockResolvedValue(makeSubscription([]));
    mockGetTierConfig.mockResolvedValue({ name: 'Managed' });

    await expect(setOrgSeatQuantity(ORG_ID, 1)).rejects.toThrow(/no seatPricing configured/);
    expect(mockStripe.subscriptionItems.create).not.toHaveBeenCalled();
  });

  it('throws when the organization does not exist', async () => {
    mockOrgDb.getOrgById.mockResolvedValue(null);
    await expect(setOrgSeatQuantity('missing-org', 1)).rejects.toThrow(/not found/);
  });
});

describe('purchaseExtraSeat', () => {
  it('reads the live Stripe quantity (not a DB mirror) and adds one', async () => {
    mockStripe.subscriptions.retrieve.mockResolvedValue(makeSubscription([makeSeatItem({ quantity: 2 })]));

    const result = await purchaseExtraSeat(ORG_ID);

    expect(result).toEqual({ newTotalSeats: 3 });
    expect(mockStripe.subscriptionItems.update).toHaveBeenCalledWith(
      'si_seat',
      expect.objectContaining({ quantity: 3 })
    );
    // Never touches the DB mirror directly.
    expect(mockOrgDb.getOrgById).not.toHaveBeenCalledWith(ORG_ID, expect.arrayContaining(['purchasedExtraSeats']));
  });

  it('goes from 0 to 1 when there is no existing seat item', async () => {
    mockStripe.subscriptions.retrieve.mockResolvedValue(makeSubscription([]));

    const result = await purchaseExtraSeat(ORG_ID);

    expect(result).toEqual({ newTotalSeats: 1 });
    expect(mockStripe.subscriptionItems.create).toHaveBeenCalledWith(
      expect.objectContaining({ quantity: 1 })
    );
  });
});

describe('removeExtraSeat', () => {
  it('subtracts one from the live Stripe quantity when the org has slack to spare', async () => {
    mockStripe.subscriptions.retrieve.mockResolvedValue(makeSubscription([makeSeatItem({ quantity: 3 })]));
    mockOrgDb.getOrgMemberCount.mockResolvedValue(2); // Starter base is 2 -> 0 currently needed

    const result = await removeExtraSeat(ORG_ID);

    expect(result).toEqual({ newTotalSeats: 2 });
    expect(mockStripe.subscriptionItems.update).toHaveBeenCalledWith(
      'si_seat',
      expect.objectContaining({ quantity: 2 })
    );
  });

  it('floors at 0 rather than going negative', async () => {
    mockStripe.subscriptions.retrieve.mockResolvedValue(makeSubscription([]));
    mockOrgDb.getOrgMemberCount.mockResolvedValue(1); // under base, 0 currently needed

    const result = await removeExtraSeat(ORG_ID);

    expect(result).toEqual({ newTotalSeats: 0 });
    // Already 0, item already absent -> no Stripe mutation at all.
    expect(mockStripe.subscriptionItems.create).not.toHaveBeenCalled();
    expect(mockStripe.subscriptionItems.update).not.toHaveBeenCalled();
    expect(mockStripe.subscriptionItems.del).not.toHaveBeenCalled();
  });

  it('refuses when the removal would drop below the seats the org actually occupies', async () => {
    // Starter base = 2. 5 members need 3 extra seats. Org has only 1
    // purchased; removing it would drop to 0, below the 3 it needs.
    mockStripe.subscriptions.retrieve.mockResolvedValue(makeSubscription([makeSeatItem({ quantity: 1 })]));
    mockOrgDb.getOrgMemberCount.mockResolvedValue(5);

    await expect(removeExtraSeat(ORG_ID)).rejects.toThrow(/Cannot remove extra seat/);

    expect(mockStripe.subscriptionItems.update).not.toHaveBeenCalled();
    expect(mockStripe.subscriptionItems.del).not.toHaveBeenCalled();
    expect(mockStripe.subscriptionItems.create).not.toHaveBeenCalled();
  });

  it('allows removal down to exactly the occupied-seat floor', async () => {
    // Starter base = 2. 4 members need 2 extra seats. Org has 3 purchased;
    // removing one leaves exactly 2, which is allowed (not below the floor).
    mockStripe.subscriptions.retrieve.mockResolvedValue(makeSubscription([makeSeatItem({ quantity: 3 })]));
    mockOrgDb.getOrgMemberCount.mockResolvedValue(4);

    const result = await removeExtraSeat(ORG_ID);

    expect(result).toEqual({ newTotalSeats: 2 });
  });

  it('never refuses on a tier with no seat cap (baseSeatsForTier returns null)', async () => {
    mockGetUserSubscriptionType.mockResolvedValue('Managed');
    mockStripe.subscriptions.retrieve.mockResolvedValue(makeSubscription([makeSeatItem({ quantity: 1 })]));
    mockOrgDb.getOrgMemberCount.mockResolvedValue(500); // would look alarming under a base-2 assumption

    const result = await removeExtraSeat(ORG_ID);

    expect(result).toEqual({ newTotalSeats: 0 });
  });
});
