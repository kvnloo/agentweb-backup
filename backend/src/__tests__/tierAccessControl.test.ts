/**
 * Tier-based Access Control Tests
 *
 * Tests:
 * 1. Registration creates user with subscriptionType='Free' and limited allowedPages
 * 2. Tier config returns correct allowedPages for each tier (Free, Basic, Super Premium)
 * 3. Stripe checkout webhook upgrades tier correctly (Starter→Basic, Pro→Super Premium)
 * 4. subscription.deleted webhook downgrades to Free
 */

// --- Mocks ---

jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn(),
    getUserByEmail: jest.fn(),
    createUser: jest.fn(),
    updateUser: jest.fn(),
    scanWithFilter: jest.fn(),
  },
}));

jest.mock('../services/waitlistDb', () => ({
  waitlistDb: {
    getByEmail: jest.fn(),
  },
}));

jest.mock('../services/settingsService', () => ({
  settingsService: {
    getSetting: jest.fn(),
  },
}));

jest.mock('../services/customerPortalPages', () => ({
  CUSTOMER_PORTAL_PAGES: [
    { path: '/brand-guidelines', label: 'Brand Guidelines' },
    { path: '/market-strategy', label: 'Market Strategy' },
    { path: '/gtm-plan', label: 'GTM Plan' },
    { path: '/seo', label: 'SEO' },
    { path: '/crm', label: 'CRM' },
    { path: '/tasks', label: 'Tasks' },
  ],
}));

jest.mock('../services/skillService', () => ({
  skillService: {
    getPublishedSkills: jest.fn(() => [
      { skillId: 'skill-1', name: 'Skill 1', toolNames: ['tool-1'] },
      { skillId: 'skill-2', name: 'Skill 2', toolNames: ['tool-2'] },
    ]),
  },
}));

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    getAvailableTools: () => [],
    getUnassociatedToolNames: () => [],
  },
}));

import { userDb } from '../services/db';
import { waitlistDb } from '../services/waitlistDb';
import { settingsService } from '../services/settingsService';
import {
  getTierConfig,
  DEFAULT_PAGES,
} from '../services/subscriptionService';
import {
  handleCheckoutSessionCompleted,
  handleSubscriptionDeleted,
} from '../services/stripeService';

const mockUserDb = userDb as jest.Mocked<typeof userDb>;
const mockWaitlistDb = waitlistDb as jest.Mocked<typeof waitlistDb>;
const mockSettingsService = settingsService as jest.Mocked<typeof settingsService>;

// DB-driven subscription types (simulates what admin portal stores in DynamoDB)
const DB_SUBSCRIPTION_TYPES = [
  {
    name: 'Free',
    allowedPages: ['/', '/agent-mode', '/settings', '/guide'],
    allowedSkills: [],
  },
  {
    name: 'Basic',
    allowedPages: [
      '/', '/agent-mode', '/settings', '/guide',
      '/brand-guidelines', '/market-strategy', '/tasks',
      '/knowledge-base', '/research-reports', '/email-templates',
    ],
    allowedSkills: ['*'],
  },
  {
    name: 'Super Premium',
    allowedPages: ['*'],
    allowedSkills: ['*'],
  },
];

/** Helper: configure the settings mock to return our DB tier configs */
function mockDbTierConfigs() {
  mockSettingsService.getSetting.mockImplementation(async (key: string) => {
    if (key === 'subscription_types') {
      return { settingValue: JSON.stringify(DB_SUBSCRIPTION_TYPES) } as any;
    }
    return null;
  });
}

// We need to mock bcrypt and jwt for register tests
jest.mock('bcryptjs', () => ({
  hash: jest.fn().mockResolvedValue('hashed-password'),
  compare: jest.fn(),
}));

jest.mock('jsonwebtoken', () => ({
  sign: jest.fn().mockReturnValue('mock-token'),
}));

jest.mock('uuid', () => ({
  v4: jest.fn().mockReturnValue('mock-uuid'),
}));

jest.mock('../services/emailService', () => ({
  emailService: { sendEmail: jest.fn(), sendTeamIntroductionEmail: jest.fn().mockResolvedValue(undefined) },
}));

describe('Tier-based Access Control', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDbTierConfigs();
  });

  // ─── 1. Tier Configuration ───────────────────────────────────────────

  describe('Tier Configuration (getTierConfig — DB-driven)', () => {
    it('returns Free tier config with DEFAULT_PAGES only', async () => {
      const config = await getTierConfig('Free');
      expect(config).not.toBeNull();
      expect(config!.name).toBe('Free');
      expect(config!.allowedPages).toEqual(['/', '/agent-mode', '/settings', '/guide']);
      // Free tier should NOT have wildcard skills
      expect(config!.allowedSkills).not.toContain('*');
    });

    it('returns Basic tier config with core feature pages', async () => {
      const config = await getTierConfig('Basic');
      expect(config).not.toBeNull();
      expect(config!.name).toBe('Basic');
      // Basic should have more pages than Free
      expect(config!.allowedPages.length).toBeGreaterThan(4);
      // Basic should include default pages
      expect(config!.allowedPages).toContain('/');
      expect(config!.allowedPages).toContain('/agent-mode');
      expect(config!.allowedPages).toContain('/settings');
      expect(config!.allowedPages).toContain('/guide');
      // Basic should include some feature pages
      expect(config!.allowedPages).toContain('/brand-guidelines');
      expect(config!.allowedPages).toContain('/tasks');
    });

    it('returns Super Premium tier config with wildcard access', async () => {
      const config = await getTierConfig('Super Premium');
      expect(config).not.toBeNull();
      expect(config!.name).toBe('Super Premium');
      expect(config!.allowedPages).toEqual(['*']);
      expect(config!.allowedSkills).toEqual(['*']);
    });

    it('returns null for unknown tier', async () => {
      const config = await getTierConfig('NonExistentTier');
      expect(config).toBeNull();
    });

    it('falls back to Free defaults when DB is unavailable', async () => {
      mockSettingsService.getSetting.mockResolvedValue(null);
      const config = await getTierConfig('Free');
      expect(config).not.toBeNull();
      expect(config!.allowedPages).toEqual(DEFAULT_PAGES);
      expect(config!.allowedSkills).toEqual([]);
    });
  });

  // ─── 2. Registration defaults to Free tier ───────────────────────────

  describe('Registration defaults to Free tier', () => {
    it('sets subscriptionType=Free and Free-tier allowedPages on new user', async () => {
      // Mock: no existing user
      mockUserDb.getUserByEmail.mockResolvedValue(undefined as any);
      mockWaitlistDb.getByEmail.mockResolvedValue(undefined as any);

      // Mock createUser to return the created user
      mockUserDb.createUser.mockResolvedValue({
        userId: 'mock-uuid',
        email: 'newuser@example.com',
        subscriptionType: 'Free',
      } as any);

      // Mock updateUser for the post-creation tier assignment
      mockUserDb.updateUser.mockResolvedValue(undefined as any);

      // Import register
      const { register } = await import('../controllers/auth');

      const req = {
        body: {
          email: 'newuser@example.com',
          password: 'TestPass123!',
        },
      } as any;

      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      } as any;

      await register(req, res);

      // Should have created the user
      expect(res.status).toHaveBeenCalledWith(201);

      // After creating user, should update with Free tier defaults
      expect(mockUserDb.updateUser).toHaveBeenCalledWith(
        'mock-uuid',
        expect.objectContaining({
          subscriptionType: 'Free',
          allowedPages: ['/', '/agent-mode', '/settings', '/guide'],
        })
      );
    });
  });

  // ─── 3. Stripe checkout upgrades tier ────────────────────────────────

  describe('Stripe checkout webhook upgrades tier', () => {
    beforeEach(() => {
      process.env.STRIPE_STARTER_PRICE_ID = 'price_starter_123';
      process.env.STRIPE_COMPLETE_PRICE_ID = 'price_pro_456';
    });

    it('upgrades to Basic tier for Starter plan checkout', async () => {
      mockUserDb.getUserById.mockResolvedValue({
        userId: 'user-1',
        email: 'test@example.com',
        subscriptionType: 'Free',
      } as any);
      mockUserDb.updateUser.mockResolvedValue(undefined as any);

      const session = {
        customer: 'cus_123',
        subscription: 'sub_123',
        metadata: { userId: 'user-1' },
        customer_details: { email: 'test@example.com' },
        line_items: {
          data: [{ price: { id: 'price_starter_123' } }],
        },
      };

      await handleCheckoutSessionCompleted(session);

      expect(mockUserDb.updateUser).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({
          subscriptionType: 'Basic',
          subscription_status: 'active',
          stripe_customer_id: 'cus_123',
          stripe_subscription_id: 'sub_123',
        })
      );

      // Verify allowedPages is set for Basic tier
      const updateCall = mockUserDb.updateUser.mock.calls[0];
      const updateData = updateCall[1] as any;
      expect(updateData.allowedPages).toBeDefined();
      expect(updateData.allowedPages.length).toBeGreaterThan(4);
    });

    it('upgrades to Super Premium tier for Pro plan checkout', async () => {
      mockUserDb.getUserById.mockResolvedValue({
        userId: 'user-2',
        email: 'pro@example.com',
        subscriptionType: 'Free',
      } as any);
      mockUserDb.updateUser.mockResolvedValue(undefined as any);

      const session = {
        customer: 'cus_456',
        subscription: 'sub_456',
        metadata: { userId: 'user-2' },
        customer_details: { email: 'pro@example.com' },
        line_items: {
          data: [{ price: { id: 'price_pro_456' } }],
        },
      };

      await handleCheckoutSessionCompleted(session);

      expect(mockUserDb.updateUser).toHaveBeenCalledWith(
        'user-2',
        expect.objectContaining({
          subscriptionType: 'Super Premium',
          subscription_status: 'active',
          allowedPages: ['*'],
          allowedSkills: ['*'],
        })
      );
    });

    it('defaults to Super Premium for unknown price IDs', async () => {
      mockUserDb.getUserById.mockResolvedValue({
        userId: 'user-3',
        email: 'unknown@example.com',
      } as any);
      mockUserDb.updateUser.mockResolvedValue(undefined as any);

      const session = {
        customer: 'cus_789',
        subscription: 'sub_789',
        metadata: { userId: 'user-3' },
        customer_details: { email: 'unknown@example.com' },
        line_items: {
          data: [{ price: { id: 'price_unknown' } }],
        },
      };

      await handleCheckoutSessionCompleted(session);

      expect(mockUserDb.updateUser).toHaveBeenCalledWith(
        'user-3',
        expect.objectContaining({
          subscriptionType: 'Super Premium',
          allowedPages: ['*'],
          allowedSkills: ['*'],
        })
      );
    });
  });

  // ─── 4. Subscription deleted downgrades to Free ──────────────────────

  describe('Subscription deleted webhook downgrades to Free', () => {
    it('downgrades to Free tier on subscription deletion', async () => {
      mockUserDb.scanWithFilter.mockResolvedValue([
        { userId: 'user-1', email: 'test@example.com', stripe_customer_id: 'cus_123' },
      ]);
      mockUserDb.updateUser.mockResolvedValue(undefined as any);

      const subscription = {
        customer: 'cus_123',
        id: 'sub_123',
      };

      await handleSubscriptionDeleted(subscription);

      expect(mockUserDb.updateUser).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({
          subscription_status: 'canceled',
          subscriptionType: 'Free',
          allowedPages: ['/', '/agent-mode', '/settings', '/guide'],
        })
      );
    });

    it('does nothing if no user found for the customer ID', async () => {
      mockUserDb.scanWithFilter.mockResolvedValue([]);

      const subscription = {
        customer: 'cus_unknown',
        id: 'sub_unknown',
      };

      await handleSubscriptionDeleted(subscription);

      expect(mockUserDb.updateUser).not.toHaveBeenCalled();
    });
  });
});
