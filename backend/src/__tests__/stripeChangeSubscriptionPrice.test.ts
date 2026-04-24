/**
 * changeSubscriptionPrice tests.
 *
 * Verifies the upgrade vs downgrade routing:
 *   - Upgrade (new price > current)  -> immediate `subscriptions.update` w/ proration
 *   - Downgrade (new price < current) -> `subscriptionSchedules.create` + `.update`
 *     (no immediate `subscriptions.update`), returns kind=downgrade_scheduled
 *     with effectiveAt = ISO of current_period_end.
 */

const mockStripe = {
  subscriptions: {
    retrieve: jest.fn(),
    update: jest.fn(),
    list: jest.fn(),
    cancel: jest.fn(),
  },
  prices: {
    retrieve: jest.fn(),
  },
  subscriptionSchedules: {
    create: jest.fn(),
    update: jest.fn(),
  },
  webhooks: { constructEvent: jest.fn() },
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
  User: {},
}));

jest.mock('../services/waitlistDb', () => ({
  waitlistDb: { getByEmail: jest.fn(), updateDetails: jest.fn(), add: jest.fn() },
  WaitlistEntry: {},
}));

jest.mock('../services/settingsService', () => ({
  settingsService: {
    getSetting: jest.fn().mockResolvedValue(null),
  },
}));

process.env.STRIPE_SECRET_KEY = 'sk_test_fake';

import { changeSubscriptionPrice } from '../services/stripeService';

const PERIOD_END_UNIX = 1_800_000_000; // some future timestamp
const PERIOD_END_ISO = new Date(PERIOD_END_UNIX * 1000).toISOString();

describe('changeSubscriptionPrice', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('routes UPGRADE (cheaper -> pricier) via immediate subscriptions.update with proration', async () => {
    mockStripe.subscriptions.retrieve.mockResolvedValue({
      id: 'sub_up',
      current_period_end: PERIOD_END_UNIX,
      items: {
        data: [{
          id: 'si_1',
          price: { id: 'price_starter', unit_amount: 2900 },
          current_period_end: PERIOD_END_UNIX,
        }],
      },
    });
    mockStripe.prices.retrieve.mockResolvedValue({ id: 'price_pro', unit_amount: 9900 });
    mockStripe.subscriptions.update.mockResolvedValue({
      id: 'sub_up',
      status: 'active',
      current_period_end: PERIOD_END_UNIX,
      items: { data: [{ id: 'si_1', price: { id: 'price_pro' } }] },
    });

    const result = await changeSubscriptionPrice('sub_up', 'price_pro');

    expect(result.kind).toBe('upgrade_immediate');
    expect(mockStripe.subscriptions.update).toHaveBeenCalledTimes(1);
    expect(mockStripe.subscriptions.update).toHaveBeenCalledWith('sub_up', {
      items: [{ id: 'si_1', price: 'price_pro' }],
      proration_behavior: 'create_prorations',
    });
    // Downgrade path MUST NOT be touched
    expect(mockStripe.subscriptionSchedules.create).not.toHaveBeenCalled();
    expect(mockStripe.subscriptionSchedules.update).not.toHaveBeenCalled();
  });

  it('routes DOWNGRADE (pricier -> cheaper) via subscriptionSchedules (no immediate update), returns kind+effectiveAt', async () => {
    mockStripe.subscriptions.retrieve.mockResolvedValue({
      id: 'sub_dn',
      current_period_end: PERIOD_END_UNIX,
      items: {
        data: [{
          id: 'si_1',
          price: { id: 'price_pro', unit_amount: 9900 },
          current_period_end: PERIOD_END_UNIX,
        }],
      },
    });
    mockStripe.prices.retrieve.mockResolvedValue({ id: 'price_starter', unit_amount: 2900 });
    mockStripe.subscriptionSchedules.create.mockResolvedValue({
      id: 'sub_sched_abc',
      phases: [{
        start_date: 1_700_000_000,
        end_date: PERIOD_END_UNIX,
        items: [{ price: 'price_pro', quantity: 1 }],
      }],
    });
    mockStripe.subscriptionSchedules.update.mockResolvedValue({
      id: 'sub_sched_abc',
      phases: [
        { items: [{ price: 'price_pro', quantity: 1 }] },
        { items: [{ price: 'price_starter', quantity: 1 }] },
      ],
    });

    const result = await changeSubscriptionPrice('sub_dn', 'price_starter');

    expect(result.kind).toBe('downgrade_scheduled');
    expect(result.effectiveAt).toBe(PERIOD_END_ISO);
    // Schedule is created FROM the current subscription
    expect(mockStripe.subscriptionSchedules.create).toHaveBeenCalledWith({
      from_subscription: 'sub_dn',
    });
    // Schedule is updated with 2 phases + end_behavior: release
    expect(mockStripe.subscriptionSchedules.update).toHaveBeenCalledTimes(1);
    const updateArgs = mockStripe.subscriptionSchedules.update.mock.calls[0];
    expect(updateArgs[0]).toBe('sub_sched_abc');
    expect(updateArgs[1].phases).toHaveLength(2);
    expect(updateArgs[1].phases[1].items[0].price).toBe('price_starter');
    expect(updateArgs[1].end_behavior).toBe('release');
    // CRITICAL: the plain subscriptions.update MUST NOT be called on downgrade
    // (that's what generates the prorated-credit UX mess).
    expect(mockStripe.subscriptions.update).not.toHaveBeenCalled();
  });

  it('returns kind=same_price when new price matches current, with no Stripe writes', async () => {
    mockStripe.subscriptions.retrieve.mockResolvedValue({
      id: 'sub_same',
      items: {
        data: [{
          id: 'si_1',
          price: { id: 'price_pro', unit_amount: 9900 },
          current_period_end: PERIOD_END_UNIX,
        }],
      },
    });

    const result = await changeSubscriptionPrice('sub_same', 'price_pro');

    expect(result.kind).toBe('same_price');
    expect(mockStripe.prices.retrieve).not.toHaveBeenCalled();
    expect(mockStripe.subscriptions.update).not.toHaveBeenCalled();
    expect(mockStripe.subscriptionSchedules.create).not.toHaveBeenCalled();
  });
});
