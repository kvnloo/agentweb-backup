/**
 * Stripe Billing Cycle Anchor Tests
 *
 * Verifies that new checkout sessions anchor billing to the 1st of the month
 * and that upgrades preserve the existing billing cycle.
 */

// --- Mocks ---

const mockStripe = {
  checkout: {
    sessions: {
      create: jest.fn(),
    },
  },
  subscriptions: {
    retrieve: jest.fn(),
    update: jest.fn(),
    list: jest.fn(),
    cancel: jest.fn(),
  },
  webhooks: {
    constructEvent: jest.fn(),
  },
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
}));

jest.mock('../services/waitlistDb', () => ({
  waitlistDb: {
    getByEmail: jest.fn(),
    updateDetails: jest.fn(),
    add: jest.fn(),
  },
}));

jest.mock('../services/settingsService', () => ({
  settingsService: {
    getSetting: jest.fn().mockResolvedValue(null),
  },
}));

process.env.STRIPE_SECRET_KEY = 'sk_test_fake';

import { stripeService } from '../services/stripeService';

describe('Billing Cycle Anchor — 1st of Month', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockStripe.checkout.sessions.create.mockResolvedValue({ id: 'cs_test_123' });
  });

  it('should include billing_cycle_anchor set to the 1st of next month', async () => {
    await stripeService.createCheckoutSession(
      'user-1',
      'price_abc',
      'https://example.com/success',
      'https://example.com/cancel'
    );

    expect(mockStripe.checkout.sessions.create).toHaveBeenCalledTimes(1);
    const callArgs = mockStripe.checkout.sessions.create.mock.calls[0][0];

    // Must have subscription_data with billing_cycle_anchor
    expect(callArgs.subscription_data).toBeDefined();
    expect(callArgs.subscription_data.billing_cycle_anchor).toBeDefined();

    // The anchor should be a Unix timestamp for the 1st of some month at 00:00:00 UTC
    const anchorDate = new Date(callArgs.subscription_data.billing_cycle_anchor * 1000);
    expect(anchorDate.getUTCDate()).toBe(1);
    expect(anchorDate.getUTCHours()).toBe(0);
    expect(anchorDate.getUTCMinutes()).toBe(0);
    expect(anchorDate.getUTCSeconds()).toBe(0);
  });

  it('should set billing_cycle_anchor always in the future', async () => {
    await stripeService.createCheckoutSession(
      'user-2',
      'price_abc',
      'https://example.com/success',
      'https://example.com/cancel'
    );

    const callArgs = mockStripe.checkout.sessions.create.mock.calls[0][0];
    const anchorTimestamp = callArgs.subscription_data.billing_cycle_anchor;
    const nowTimestamp = Math.floor(Date.now() / 1000);

    // Anchor must always be in the future
    expect(anchorTimestamp).toBeGreaterThan(nowTimestamp);
  });

  it('should enable proration on new checkout sessions', async () => {
    await stripeService.createCheckoutSession(
      'user-3',
      'price_abc',
      'https://example.com/success',
      'https://example.com/cancel'
    );

    const callArgs = mockStripe.checkout.sessions.create.mock.calls[0][0];
    expect(callArgs.subscription_data.proration_behavior).toBe('create_prorations');
  });

  it('should preserve existing billing cycle on upgrade (no anchor override)', async () => {
    mockStripe.subscriptions.retrieve.mockResolvedValue({
      id: 'sub_123',
      items: { data: [{ id: 'si_abc', price: 'price_old' }] },
      billing_cycle_anchor: 1735689600,
    });
    mockStripe.subscriptions.update.mockResolvedValue({
      id: 'sub_123',
      items: { data: [{ id: 'si_abc', price: 'price_new' }] },
    });

    await stripeService.upgradeSubscription('sub_123', 'price_new');

    expect(mockStripe.subscriptions.update).toHaveBeenCalledTimes(1);
    const updateArgs = mockStripe.subscriptions.update.mock.calls[0][1];

    // Upgrade should NOT pass billing_cycle_anchor — Stripe preserves it automatically
    expect(updateArgs.billing_cycle_anchor).toBeUndefined();
    // Proration should be enabled
    expect(updateArgs.proration_behavior).toBe('create_prorations');
  });
});
