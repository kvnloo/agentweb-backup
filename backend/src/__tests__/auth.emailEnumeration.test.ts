/**
 * Tests for email enumeration prevention in login and register endpoints.
 * Both endpoints should return generic error messages to prevent attackers
 * from discovering valid email addresses.
 */
import request from 'supertest';
import express from 'express';

// Mock dependencies
const mockGetUserByEmail = jest.fn();
const mockCreateUser = jest.fn();
const mockUpdateUser = jest.fn();

jest.mock('../services/db', () => ({
  userDb: {
    getUserByEmail: (...args: any[]) => mockGetUserByEmail(...args),
    createUser: (...args: any[]) => mockCreateUser(...args),
    updateUser: (...args: any[]) => mockUpdateUser(...args),
  },
}));

jest.mock('../services/waitlistDb', () => ({
  waitlistDb: {
    getEntry: jest.fn(),
  },
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

import { login, register } from '../controllers/auth';

const app = express();
app.use(express.json());
app.post('/api/auth/login', login);
app.post('/api/auth/register', register);

describe('Email Enumeration Prevention', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('Login', () => {
    // FAIL test 1: Non-existent user should NOT reveal "user not found"
    it('should return generic "Invalid credentials" for non-existent email', async () => {
      mockGetUserByEmail.mockResolvedValue(null);

      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: 'nonexistent@test.com', password: 'wrong' });

      // Should NOT return 404 or mention "not found"
      expect(res.status).not.toBe(404);
      expect(res.body.message).not.toContain('not found');
      expect(res.body.code).not.toBe('user_not_found');
      // Should return same message as wrong password
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('invalid_credentials');
    });

    // FAIL test 2: Wrong password should return same message as non-existent user
    it('should return same error for wrong password as for non-existent user', async () => {
      // Setup: user exists but password is wrong
      const bcrypt = require('bcryptjs');
      const hashedPassword = await bcrypt.hash('correctpassword', 10);
      mockGetUserByEmail.mockResolvedValue({
        userId: 'u1',
        email: 'exists@test.com',
        password: hashedPassword,
        isActive: true,
      });

      const wrongPwRes = await request(app)
        .post('/api/auth/login')
        .send({ email: 'exists@test.com', password: 'wrongpassword' });

      // Setup: user doesn't exist
      mockGetUserByEmail.mockResolvedValue(null);

      const noUserRes = await request(app)
        .post('/api/auth/login')
        .send({ email: 'nonexistent@test.com', password: 'anything' });

      // Both should return identical status and message
      expect(wrongPwRes.status).toBe(noUserRes.status);
      expect(wrongPwRes.body.message).toBe(noUserRes.body.message);
      expect(wrongPwRes.body.code).toBe(noUserRes.body.code);
    });

    // SUCCESS test 3: Valid login should still work
    it('should return token for valid credentials', async () => {
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
        .send({ email: 'user@test.com', password: 'correct123' });

      expect(res.status).toBe(200);
      expect(res.body.token).toBeDefined();
    });
  });

  describe('Register', () => {
    // FAIL test 4: Existing email should NOT reveal "user already exists"
    it('should return generic error for existing email', async () => {
      mockGetUserByEmail.mockResolvedValue({ userId: 'u1', email: 'taken@test.com' });

      const res = await request(app)
        .post('/api/auth/register')
        .send({ email: 'taken@test.com', password: 'Pass123!' });

      expect(res.body.message).not.toContain('already exists');
      // Should return a generic message
      expect(res.status).toBe(400);
    });
  });
});
