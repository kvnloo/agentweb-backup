import request from 'supertest';
import express from 'express';
import adminRoutes from '../routes/admin';

// Mock the dependencies
jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn(),
    updateUser: jest.fn(),
    getAllUsers: jest.fn(),
  },
}));
jest.mock('../services/waitlistDb', () => ({}));
jest.mock('../services/emailService', () => ({}));
jest.mock('../services/workflowDb', () => ({}));
jest.mock('../services/chatbotService', () => ({}));
jest.mock('../services/resendService', () => ({
  resendService: {
    sendEmail: jest.fn(),
  },
}));
jest.mock('../services/settingsService', () => ({
  settingsService: {
    getSetting: jest.fn(),
    setSetting: jest.fn(),
    getSettingsByPrefix: jest.fn(),
  },
}));

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: 'admin-user-1', email: 'admin@example.com', isAdmin: true };
    next();
  },
}));

jest.mock('../middleware/admin', () => ({
  isAdmin: (_req: any, _res: any, next: any) => next(),
}));

// Mock AWS SDK
jest.mock('aws-sdk', () => ({
  default: {
    SecretsManager: jest.fn(() => ({
      getSecretValue: jest.fn().mockReturnValue({
        promise: jest.fn().mockResolvedValue({ SecretString: 'test-secret' }),
      }),
    })),
  },
  config: {
    update: jest.fn(),
  },
  DynamoDB: {
    DocumentClient: jest.fn(() => ({})),
  },
  SecretsManager: jest.fn(() => ({
    getSecretValue: jest.fn().mockReturnValue({
      promise: jest.fn().mockResolvedValue({ SecretString: 'test-secret' }),
    }),
  })),
}));

import { userDb } from '../services/db';

const mockUserDb = userDb as jest.Mocked<typeof userDb>;

const app = express();
app.use(express.json());
app.use('/api/admin', adminRoutes);

describe('PUT /api/admin/users/:userId/stripe-customer-id', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return 404 when user does not exist', async () => {
    mockUserDb.getUserById.mockResolvedValue(null as any);

    const res = await request(app)
      .put('/api/admin/users/nonexistent-user/stripe-customer-id')
      .set('Authorization', 'Bearer test-token')
      .send({ stripeCustomerId: 'cus_test123' });

    expect(res.status).toBe(404);
    expect(res.body.message).toBe('User not found');
  });

  it('should return 400 when stripeCustomerId is missing from body', async () => {
    mockUserDb.getUserById.mockResolvedValue({
      userId: 'user-1',
      email: 'user1@test.com',
    } as any);

    const res = await request(app)
      .put('/api/admin/users/user-1/stripe-customer-id')
      .set('Authorization', 'Bearer test-token')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('stripeCustomerId is required');
  });

  it('should return 400 when stripeCustomerId has invalid format', async () => {
    mockUserDb.getUserById.mockResolvedValue({
      userId: 'user-1',
      email: 'user1@test.com',
    } as any);

    const res = await request(app)
      .put('/api/admin/users/user-1/stripe-customer-id')
      .set('Authorization', 'Bearer test-token')
      .send({ stripeCustomerId: 'invalid_format' });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Invalid Stripe Customer ID format. Must start with "cus_"');
  });

  it('should successfully update stripe_customer_id for a valid user', async () => {
    const existingUser = {
      userId: 'user-1',
      email: 'user1@test.com',
      isAdmin: false,
      isActive: true,
    };
    const updatedUser = {
      ...existingUser,
      stripe_customer_id: 'cus_StgRhZXF8sVPvB',
    };

    mockUserDb.getUserById.mockResolvedValue(existingUser as any);
    mockUserDb.updateUser.mockResolvedValue(updatedUser as any);

    const res = await request(app)
      .put('/api/admin/users/user-1/stripe-customer-id')
      .set('Authorization', 'Bearer test-token')
      .send({ stripeCustomerId: 'cus_StgRhZXF8sVPvB' });

    expect(res.status).toBe(200);
    expect(mockUserDb.updateUser).toHaveBeenCalledWith('user-1', {
      stripe_customer_id: 'cus_StgRhZXF8sVPvB',
    });
    expect(res.body.stripe_customer_id).toBe('cus_StgRhZXF8sVPvB');
  });

  it('should allow clearing stripe_customer_id with empty string', async () => {
    const existingUser = {
      userId: 'user-1',
      email: 'user1@test.com',
      stripe_customer_id: 'cus_existing123',
    };
    const updatedUser = {
      ...existingUser,
      stripe_customer_id: '',
    };

    mockUserDb.getUserById.mockResolvedValue(existingUser as any);
    mockUserDb.updateUser.mockResolvedValue(updatedUser as any);

    const res = await request(app)
      .put('/api/admin/users/user-1/stripe-customer-id')
      .set('Authorization', 'Bearer test-token')
      .send({ stripeCustomerId: '' });

    expect(res.status).toBe(200);
    expect(mockUserDb.updateUser).toHaveBeenCalledWith('user-1', {
      stripe_customer_id: '',
    });
  });

  it('should return 500 when database update fails', async () => {
    mockUserDb.getUserById.mockResolvedValue({
      userId: 'user-1',
      email: 'user1@test.com',
    } as any);
    mockUserDb.updateUser.mockRejectedValue(new Error('DynamoDB error'));

    const res = await request(app)
      .put('/api/admin/users/user-1/stripe-customer-id')
      .set('Authorization', 'Bearer test-token')
      .send({ stripeCustomerId: 'cus_valid123' });

    expect(res.status).toBe(500);
    expect(res.body.message).toBe('Error updating Stripe Customer ID');
  });
});
