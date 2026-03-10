import express from 'express';
import request from 'supertest';

// --- Mocks ---

const mockGetAllUsers = jest.fn();
const mockGetUserById = jest.fn();
const mockGetUserByEmail = jest.fn();
const mockUpdateUser = jest.fn();

jest.mock('../services/db', () => ({
  userDb: {
    getAllUsers: mockGetAllUsers,
    getUserById: mockGetUserById,
    getUserByEmail: mockGetUserByEmail,
    updateUser: mockUpdateUser,
  },
  taskDb: {},
  subscriberDb: {},
  crmDb: {},
}));

jest.mock('../services/settingsService', () => ({
  settingsService: {
    getSetting: jest.fn().mockResolvedValue(null),
  },
}));

jest.mock('../services/waitlistDb', () => ({ waitlistDb: {} }));
jest.mock('../services/emailService', () => ({ emailService: {} }));
jest.mock('../services/resendService', () => ({ resendService: {} }));
jest.mock('../services/gtmPlanNotificationService', () => ({
  sendGTMPlanUpdateNotifications: jest.fn(),
  sendPhaseStatusReport: jest.fn(),
  sendPlanStatusReport: jest.fn(),
}));
jest.mock('../services/chatbotService', () => ({ chatbotDb: {}, ChatSession: {} }));
jest.mock('../services/workflowDb', () => ({ workflowDb: {} }));
jest.mock('../utils/crypto', () => ({ encryptPassword: jest.fn() }));

// Mock bcrypt
const mockBcryptCompare = jest.fn();
jest.mock('bcryptjs', () => ({
  compare: (...args: any[]) => mockBcryptCompare(...args),
  hash: jest.fn().mockResolvedValue('$2b$10$hashed'),
  genSalt: jest.fn().mockResolvedValue('$2b$10$salt'),
}));

// Mock JWT
jest.mock('jsonwebtoken', () => ({
  sign: jest.fn().mockReturnValue('mock-jwt-token'),
  verify: jest.fn().mockReturnValue({ userId: 'admin-1', email: 'admin@test.com', isAdmin: true }),
}));

// Mock admin middleware
jest.mock('../middleware/admin', () => ({
  isAdmin: jest.fn((req: any, _res: any, next: any) => next()),
}));

jest.mock('../middleware/auth', () => ({
  authenticateToken: jest.fn((req: any, _res: any, next: any) => {
    req.user = { userId: 'admin-1', email: 'admin@test.com', isAdmin: true };
    next();
  }),
  requireAdmin: jest.fn((req: any, _res: any, next: any) => next()),
}));

// We need to import the actual route files after mocks are set up
// Admin routes have many dependencies - let's test the sanitization function directly

describe('API Security Fixes', () => {
  // --- PASSWORD HASH EXPOSURE ---

  describe('Password hash stripping from admin responses', () => {
    const mockUserWithPassword = {
      userId: 'user-1',
      email: 'test@example.com',
      password: '$2b$10$hashofpasswordthatneedstobestripped',
      isAdmin: false,
      isActive: true,
      createdAt: '2024-01-01',
      secrets: { apiKey: 'encrypted-value' },
    };

    it('GET /api/admin/users should NOT include password field', async () => {
      mockGetAllUsers.mockResolvedValue([mockUserWithPassword]);

      // Import admin router after mocks
      const adminRouter = require('../routes/admin').default;
      const app = express();
      app.use(express.json());
      app.use('/api/admin', adminRouter);

      const res = await request(app)
        .get('/api/admin/users')
        .set('Authorization', 'Bearer mock-token');

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body[0]).not.toHaveProperty('password');
      // Should still have other fields
      expect(res.body[0]).toHaveProperty('email', 'test@example.com');
      expect(res.body[0]).toHaveProperty('userId', 'user-1');
    });

    it('GET /api/admin/users/:userId should NOT include password field', async () => {
      mockGetUserById.mockResolvedValue(mockUserWithPassword);

      const adminRouter = require('../routes/admin').default;
      const app = express();
      app.use(express.json());
      app.use('/api/admin', adminRouter);

      const res = await request(app)
        .get('/api/admin/users/user-1')
        .set('Authorization', 'Bearer mock-token');

      expect(res.status).toBe(200);
      expect(res.body).not.toHaveProperty('password');
      expect(res.body).toHaveProperty('email', 'test@example.com');
    });
  });

  // --- USER ENUMERATION ---

  describe('Login user enumeration prevention', () => {
    it('should return same status and generic message for non-existent email', async () => {
      mockGetUserByEmail.mockResolvedValue(null);

      const { login } = require('../controllers/auth');
      const app = express();
      app.use(express.json());
      app.post('/api/auth/login', login);

      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: 'nonexistent@example.com', password: 'WrongPass123!' });

      expect(res.status).toBe(401);
      expect(res.body.message).not.toMatch(/not found/i);
      expect(res.body.code).toBe('invalid_credentials');
    });

    it('should return same status and generic message for wrong password', async () => {
      mockGetUserByEmail.mockResolvedValue({
        userId: 'user-1',
        email: 'test@example.com',
        password: '$2b$10$somehash',
        isActive: true,
      });
      mockBcryptCompare.mockResolvedValue(false);

      const { login } = require('../controllers/auth');
      const app = express();
      app.use(express.json());
      app.post('/api/auth/login', login);

      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: 'test@example.com', password: 'WrongPass123!' });

      expect(res.status).toBe(401);
      expect(res.body.message).not.toMatch(/not found/i);
      expect(res.body.code).toBe('invalid_credentials');
    });

    it('should use identical error responses for both cases', async () => {
      // Test non-existent user
      mockGetUserByEmail.mockResolvedValue(null);

      const { login } = require('../controllers/auth');
      const app = express();
      app.use(express.json());
      app.post('/api/auth/login', login);

      const res1 = await request(app)
        .post('/api/auth/login')
        .send({ email: 'missing@example.com', password: 'pass' });

      // Test wrong password
      mockGetUserByEmail.mockResolvedValue({
        userId: 'user-1',
        email: 'test@example.com',
        password: '$2b$10$hash',
        isActive: true,
      });
      mockBcryptCompare.mockResolvedValue(false);

      const res2 = await request(app)
        .post('/api/auth/login')
        .send({ email: 'test@example.com', password: 'wrongpass' });

      // Both should have identical status and message structure
      expect(res1.status).toBe(res2.status);
      expect(res1.body.code).toBe(res2.body.code);
      expect(res1.body.message).toBe(res2.body.message);
    });
  });
});
