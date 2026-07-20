/**
 * Tests for invoice.payment_succeeded webhook handler.
 *
 * Covers: status update, subscription ID backfill, has_payment_method sync,
 * unknown customer handling, and missing subscription field.
 */

// Mock Stripe SDK before any imports
const mockSubscriptionsRetrieve = jest.fn();
const mockWebhooksConstructEvent = jest.fn();

jest.mock('stripe', () => {
  return jest.fn().mockImplementation(() => ({
    checkout: { sessions: { create: jest.fn(), retrieve: jest.fn() } },
    billingPortal: { sessions: { create: jest.fn() } },
    products: { list: jest.fn() },
    subscriptions: { retrieve: mockSubscriptionsRetrieve, list: jest.fn(), cancel: jest.fn() },
    webhooks: { constructEvent: mockWebhooksConstructEvent },
    paymentMethods: { list: jest.fn() },
    customers: { retrieve: jest.fn() },
  }));
});

// Mock db service
jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn(),
    getUserByEmail: jest.fn(),
    updateUser: jest.fn(),
    getAllUsers: jest.fn(),
    scanWithFilter: jest.fn(),
  },
}));

// Mock waitlistDb
jest.mock('../services/waitlistDb', () => ({
  waitlistDb: {
    getByEmail: jest.fn(),
    updateDetails: jest.fn(),
    add: jest.fn(),
  },
}));

// Mock settingsService
jest.mock('../services/settingsService', () => ({
  settingsService: {
    getSetting: jest.fn().mockImplementation((key: string) => {
      if (key === 'subscription_types') {
        return Promise.resolve({
          settingName: 'subscription_types',
          settingValue: JSON.stringify([
            { name: 'Free', allowedPages: ['/'], allowedSkills: [] },
            { name: 'Basic', allowedPages: ['/', '/agent-mode'], allowedSkills: ['*'] },
            { name: 'Super Premium', allowedPages: ['*'], allowedSkills: ['*'] },
          ]),
          updatedAt: new Date().toISOString(),
          updatedBy: 'test',
        });
      }
      return Promise.resolve(null);
    }),
  },
}));

// Set env vars
process.env.STRIPE_SECRET_KEY = 'sk_test_fake_key';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_fake_secret';

import { handleInvoicePaymentSucceeded } from '../services/stripeService';
import { userDb } from '../services/db';

describe('invoice.payment_succeeded handler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should update subscription_status to active for known user', async () => {
    const mockUser = {
      userId: 'user-1',
      stripe_customer_id: 'cus_abc',
      stripe_subscription_id: 'sub_existing',
      subscription_status: 'past_due',
    };
    (userDb.scanWithFilter as jest.Mock).mockResolvedValue([mockUser]);
    (userDb.updateUser as jest.Mock).mockResolvedValue(undefined);

    await handleInvoicePaymentSucceeded({
      customer: 'cus_abc',
      subscription: 'sub_existing',
    });

    expect(userDb.updateUser).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ subscription_status: 'active' })
    );
  });

  it('should backfill stripe_subscription_id when null', async () => {
    const mockUser = {
      userId: 'user-2',
      stripe_customer_id: 'cus_def',
      stripe_subscription_id: null,
      subscription_status: 'incomplete',
    };
    (userDb.scanWithFilter as jest.Mock).mockResolvedValue([mockUser]);
    (userDb.updateUser as jest.Mock).mockResolvedValue(undefined);

    await handleInvoicePaymentSucceeded({
      customer: 'cus_def',
      subscription: 'sub_new_123',
    });

    expect(userDb.updateUser).toHaveBeenCalledWith(
      'user-2',
      expect.objectContaining({
        subscription_status: 'active',
        stripe_subscription_id: 'sub_new_123',
        has_payment_method: true,
      })
    );
  });

  it('should set has_payment_method to true', async () => {
    const mockUser = {
      userId: 'user-3',
      stripe_customer_id: 'cus_ghi',
      stripe_subscription_id: 'sub_333',
      has_payment_method: false,
    };
    (userDb.scanWithFilter as jest.Mock).mockResolvedValue([mockUser]);
    (userDb.updateUser as jest.Mock).mockResolvedValue(undefined);

    await handleInvoicePaymentSucceeded({
      customer: 'cus_ghi',
      subscription: 'sub_333',
    });

    expect(userDb.updateUser).toHaveBeenCalledWith(
      'user-3',
      expect.objectContaining({ has_payment_method: true })
    );
  });

  it('should return without error for unknown customer (no retry)', async () => {
    (userDb.scanWithFilter as jest.Mock).mockResolvedValue([]);

    // Should NOT throw — returns gracefully
    await expect(
      handleInvoicePaymentSucceeded({
        customer: 'cus_unknown',
        subscription: 'sub_unknown',
      })
    ).resolves.toBeUndefined();

    expect(userDb.updateUser).not.toHaveBeenCalled();
  });

  it('should handle invoice with no subscription field gracefully', async () => {
    const mockUser = {
      userId: 'user-4',
      stripe_customer_id: 'cus_jkl',
      stripe_subscription_id: 'sub_existing_444',
    };
    (userDb.scanWithFilter as jest.Mock).mockResolvedValue([mockUser]);
    (userDb.updateUser as jest.Mock).mockResolvedValue(undefined);

    // Invoice with no subscription field (e.g., one-time invoice)
    await handleInvoicePaymentSucceeded({
      customer: 'cus_jkl',
      subscription: null,
    });

    expect(userDb.updateUser).toHaveBeenCalledWith(
      'user-4',
      expect.objectContaining({
        subscription_status: 'active',
        has_payment_method: true,
      })
    );
    // Should NOT overwrite existing stripe_subscription_id with null
    const updateCall = (userDb.updateUser as jest.Mock).mock.calls[0][1];
    expect(updateCall.stripe_subscription_id).toBeUndefined();
  });

  // ─── ENG-405: writes current_period_end from a Basil-shaped subscription ───
  it('writes current_period_end from a Basil-shaped subscription (item-level, absent root)', async () => {
    const mockUser = {
      userId: 'user-basil',
      stripe_customer_id: 'cus_basil',
      stripe_subscription_id: 'sub_basil',
      subscription_status: 'active',
    };
    (userDb.scanWithFilter as jest.Mock).mockResolvedValue([mockUser]);
    (userDb.updateUser as jest.Mock).mockResolvedValue(undefined);
    // Basil shape: period end on items.data[0], absent at the root.
    mockSubscriptionsRetrieve.mockResolvedValue({
      id: 'sub_basil',
      status: 'active',
      items: { data: [{ current_period_end: 1735689600, price: { id: 'price_x' } }] },
    });

    await handleInvoicePaymentSucceeded({
      customer: 'cus_basil',
      subscription: 'sub_basil',
    });

    expect(userDb.updateUser).toHaveBeenCalledWith(
      'user-basil',
      expect.objectContaining({
        current_period_end: new Date(1735689600 * 1000).toISOString(),
      })
    );
  });
});
