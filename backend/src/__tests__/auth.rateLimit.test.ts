/**
 * Tests for rate limiting on login and register endpoints.
 * Brute-force protection: after N failed attempts from same IP, return 429.
 */
import request from 'supertest';
import express from 'express';

// Mock dependencies
const mockGetUserByEmail = jest.fn();
const mockCreateUser = jest.fn();
const mockUpdateUser = jest.fn();
const mockGetByEmail = jest.fn();

jest.mock('../services/db', () => ({
  userDb: {
    getUserByEmail: (...args: any[]) => mockGetUserByEmail(...args),
    createUser: (...args: any[]) => mockCreateUser(...args),
    updateUser: (...args: any[]) => mockUpdateUser(...args),
  },
  taskDb: {},
  subscriberDb: {},
}));

jest.mock('../services/waitlistDb', () => ({
  waitlistDb: {
    getByEmail: (...args: any[]) => mockGetByEmail(...args),
  },
}));

jest.mock('../services/emailService', () => ({
  emailService: { sendEmail: jest.fn() },
}));

jest.mock('aws-sdk', () => ({
  config: { update: jest.fn() },
  SecretsManager: jest.fn(() => ({
    getSecretValue: jest.fn().mockReturnValue({
      promise: jest.fn().mockResolvedValue({ SecretString: '{}' }),
    }),
  })),
  DynamoDB: {
    DocumentClient: jest.fn(() => ({})),
  },
}));

jest.mock('passport-google-oauth20', () => ({
  Strategy: jest.fn().mockImplementation((_opts: any, _cb: any) => ({
    name: 'google',
    authenticate: jest.fn(),
  })),
}));

jest.mock('../services/chatbotService', () => ({
  ChatbotDB: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('../services/subscriptionService', () => ({
  getUserSubscriptionType: jest.fn(),
  getAllowedPages: jest.fn(),
  getAllowedSkills: jest.fn(),
}));

jest.mock('../services/skillService', () => ({
  skillService: { getPublishedSkills: jest.fn().mockResolvedValue([]) },
}));

import authRouter from '../routes/auth';

// Single app instance — tests use unique IPs via X-Forwarded-For to isolate rate limit state
const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use('/api/auth', authRouter);

describe('Auth Rate Limiting', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // FAIL test 1: Login should return 429 after too many failed attempts
  it('should return 429 after exceeding login rate limit', async () => {
    mockGetUserByEmail.mockResolvedValue(null);

    const responses = [];
    for (let i = 0; i < 11; i++) {
      const res = await request(app)
        .post('/api/auth/login')
        .set('X-Forwarded-For', '10.0.0.1')
        .send({ email: 'attacker@test.com', password: 'wrong' });
      responses.push(res);
    }

    // First 10 should get normal auth error (not 429)
    for (let i = 0; i < 10; i++) {
      expect(responses[i].status).not.toBe(429);
    }

    // 11th should be rate-limited
    expect(responses[10].status).toBe(429);
    expect(responses[10].body.message).toContain('Too many');
  });

  // FAIL test 2: Register should also be rate-limited
  it('should return 429 after exceeding register rate limit', async () => {
    mockGetUserByEmail.mockResolvedValue({ userId: 'u1', email: 'taken@test.com' });

    const responses = [];
    for (let i = 0; i < 11; i++) {
      const res = await request(app)
        .post('/api/auth/register')
        .set('X-Forwarded-For', '10.0.0.2')
        .send({ email: 'attacker@test.com', password: 'Pass123!' });
      responses.push(res);
    }

    // 11th should be rate-limited
    expect(responses[10].status).toBe(429);
  });

  // FAIL test 3: Rate limit response should include Retry-After header
  it('should include Retry-After header in 429 response', async () => {
    mockGetUserByEmail.mockResolvedValue(null);

    // Exhaust the limit
    for (let i = 0; i < 10; i++) {
      await request(app)
        .post('/api/auth/login')
        .set('X-Forwarded-For', '10.0.0.3')
        .send({ email: 'attacker@test.com', password: 'wrong' });
    }

    const res = await request(app)
      .post('/api/auth/login')
      .set('X-Forwarded-For', '10.0.0.3')
      .send({ email: 'attacker@test.com', password: 'wrong' });

    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBeDefined();
  });

  // SUCCESS test 4: Normal login should work within rate limit
  it('should allow normal login within rate limit', async () => {
    const bcrypt = require('bcryptjs');
    const hashedPassword = await bcrypt.hash('correct123', 10);
    mockGetUserByEmail.mockResolvedValue({
      userId: 'u1',
      email: 'user@test.com',
      password: hashedPassword,
      isActive: true,
      roles: ['customer'],
    });
    mockUpdateUser.mockResolvedValue({});

    const res = await request(app)
      .post('/api/auth/login')
      .set('X-Forwarded-For', '10.0.0.4')
      .send({ email: 'user@test.com', password: 'correct123' });

    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
  });

  // SUCCESS test 5: Other auth endpoints should NOT be rate-limited by auth limiter
  it('should not rate-limit GET /me endpoint with auth rate limiter', async () => {
    for (let i = 0; i < 15; i++) {
      const res = await request(app)
        .get('/api/auth/me')
        .set('X-Forwarded-For', '10.0.0.5');
      expect(res.status).not.toBe(429);
    }
  });

  // change-password is rate-limited. The limiter sits BEFORE authenticateToken,
  // so unauthenticated attempts still count (401 first, then 429) — which is
  // exactly the brute-force surface we're protecting (a stolen JWT trying the
  // current password).
  it('should return 429 after exceeding change-password rate limit', async () => {
    const responses = [];
    for (let i = 0; i < 11; i++) {
      const res = await request(app)
        .put('/api/auth/change-password')
        .set('X-Forwarded-For', '10.0.0.6')
        .send({ currentPassword: 'x', newPassword: 'yyyyyyyyyyyy' });
      responses.push(res);
    }

    // First 10 are rejected by auth (401), not the limiter.
    for (let i = 0; i < 10; i++) {
      expect(responses[i].status).not.toBe(429);
    }
    // 11th is rate-limited.
    expect(responses[10].status).toBe(429);
    expect(responses[10].body.message).toContain('Too many');
  });

  // change-password has its OWN budget, separate from login/register. Exhausting
  // the change-password limit from an IP must NOT rate-limit that IP's logins.
  it('should keep change-password and login budgets independent', async () => {
    mockGetUserByEmail.mockResolvedValue(null);

    // Exhaust change-password for this IP (11 → last is 429).
    for (let i = 0; i < 11; i++) {
      await request(app)
        .put('/api/auth/change-password')
        .set('X-Forwarded-For', '10.0.0.7')
        .send({ currentPassword: 'x', newPassword: 'yyyyyyyyyyyy' });
    }

    // Login from the SAME IP still has its own untouched budget → not 429.
    const res = await request(app)
      .post('/api/auth/login')
      .set('X-Forwarded-For', '10.0.0.7')
      .send({ email: 'someone@test.com', password: 'wrong' });

    expect(res.status).not.toBe(429);
  });
});
