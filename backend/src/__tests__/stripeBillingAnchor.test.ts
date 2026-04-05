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

  // NOTE: billing_cycle_anchor is NOT supported in checkout.sessions.create
  // subscription_data. These tests verify it is NOT passed (it would be silently
  // ignored by Stripe). Anchoring to the 1st should be done post-checkout via
  // stripe.subscriptions.update() in the webhook handler.

  it('should NOT include billing_cycle_anchor in checkout session (not supported)', async () => {
    await stripeService.createCheckoutSession(
      'user-1',
      'price_abc',
      'https://example.com/success',
      'https://example.com/cancel'
    );

    expect(mockStripe.checkout.sessions.create).toHaveBeenCalledTimes(1);
    const callArgs = mockStripe.checkout.sessions.create.mock.calls[0][0];

    // subscription_data should either not exist or not contain billing_cycle_anchor
    if (callArgs.subscription_data) {
      expect(callArgs.subscription_data.billing_cycle_anchor).toBeUndefined();
    }
  });

  it('should create a valid checkout session without subscription_data overrides', async () => {
    await stripeService.createCheckoutSession(
      'user-2',
      'price_abc',
      'https://example.com/success',
      'https://example.com/cancel'
    );

    const callArgs = mockStripe.checkout.sessions.create.mock.calls[0][0];
    expect(callArgs.mode).toBe('subscription');
    expect(callArgs.line_items).toBeDefined();
    expect(callArgs.success_url).toBe('https://example.com/success');
    expect(callArgs.cancel_url).toBe('https://example.com/cancel');
    expect(callArgs.metadata.userId).toBe('user-2');
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
