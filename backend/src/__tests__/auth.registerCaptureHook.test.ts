/**
 * Verify that the register controller fires the onUserRegistered capture hook
 * for the activity timeline. This is a small integration test — we mock every
 * downstream dep and assert the hook is called with the right args after a
 * successful signup.
 */

import express from 'express';
import request from 'supertest';

// ---- Mocks BEFORE controller import ----------------------------------------

const mockGetUserByEmail = jest.fn();
const mockCreateUser = jest.fn();
const mockUpdateUser = jest.fn();

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
  waitlistDb: { getByEmail: jest.fn().mockResolvedValue(null) },
}));

jest.mock('../services/emailService', () => ({
  emailService: {
    sendEmail: jest.fn().mockResolvedValue(undefined),
    sendTeamIntroductionEmail: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../services/subscriptionService', () => ({
  getTierConfig: jest.fn().mockResolvedValue({ allowedPages: ['home'], allowedSkills: [] }),
  DEFAULT_PAGES: ['home'],
}));

jest.mock('../services/crmAutoSyncService', () => ({
  syncNewUserToLeadList: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../types/attribution', () => ({
  normalizeAttribution: jest.fn().mockReturnValue(null),
}));

const mockOnUserRegistered = jest.fn();
const mockConsumeSignupIntent = jest.fn();
jest.mock('../services/contactCaptureHooks', () => ({
  onUserRegistered: (...args: any[]) => mockOnUserRegistered(...args),
}));
jest.mock('../mcp/oauth/oauthService', () => ({
  mcpOAuthService: {
    consumeSignupIntent: (...args: any[]) => mockConsumeSignupIntent(...args),
  },
}));

jest.mock('bcryptjs', () => ({
  hash: jest.fn().mockResolvedValue('hashed-password'),
  compare: jest.fn().mockResolvedValue(true),
}));

jest.mock('jsonwebtoken', () => ({
  sign: jest.fn().mockReturnValue('test.jwt.token'),
  verify: jest.fn().mockReturnValue({ purpose: 'mcp_signup' }),
}));

// Import the controller AFTER mocks are set up.
import { register } from '../controllers/auth';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.post('/register', register);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetUserByEmail.mockResolvedValue(null); // no existing user
  mockCreateUser.mockResolvedValue({
    userId: 'uuid-u1',
    email: 'new@user.com',
    isAdmin: false,
    roles: ['customer'],
  });
  mockUpdateUser.mockResolvedValue({ userId: 'uuid-u1' });
  mockOnUserRegistered.mockResolvedValue(null);
  mockConsumeSignupIntent.mockResolvedValue(true);
});

describe('register controller fires onUserRegistered', () => {
  it('invokes onUserRegistered with userId, email, displayName, and source=password on successful signup', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/register')
      .send({ email: 'New@User.com', password: 'ValidPass123!', displayName: 'Alice' });

    expect(res.status).toBe(201);
    expect(mockOnUserRegistered).toHaveBeenCalledTimes(1);
    const call = mockOnUserRegistered.mock.calls[0][0];
    expect(call.userId).toBeDefined();
    expect(call.email).toBe('new@user.com'); // lowercased by the controller
    expect(call.displayName).toBe('Alice');
    expect(call.signupSource).toBe('password');
    expect(typeof call.createdAt).toBe('string');
  });

  it('does not break signup when the capture hook rejects', async () => {
    mockOnUserRegistered.mockRejectedValueOnce(new Error('timeline db down'));
    const app = makeApp();
    const res = await request(app)
      .post('/register')
      .send({ email: 'new@user.com', password: 'ValidPass123!' });

    // 201 is returned before the hook's promise would settle — the test passes
    // as long as the controller doesn't throw synchronously.
    expect(res.status).toBe(201);
  });

  it('records MCP-originated OAuth signup without accepting arbitrary source values', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/register')
      .send({ email: 'new@user.com', password: 'ValidPass123!', signupSource: 'mcp', signupIntent: 'signed-intent' });

    expect(res.status).toBe(201);
    expect(mockOnUserRegistered.mock.calls[0][0].signupSource).toBe('mcp');
    expect(mockUpdateUser).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ signupSource: 'mcp' }));
  });

  it('does not call the hook when registration fails early (user already exists)', async () => {
    mockGetUserByEmail.mockResolvedValueOnce({ userId: 'existing', email: 'taken@x.com' });
    const app = makeApp();
    const res = await request(app)
      .post('/register')
      .send({ email: 'taken@x.com', password: 'ValidPass123!' });

    expect(res.status).toBe(400);
    expect(mockOnUserRegistered).not.toHaveBeenCalled();
  });
});
