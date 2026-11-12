/** ENG-2899: register maps createUser ConditionalCheckFailed -> 409. */

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

jest.mock('../services/contactCaptureHooks', () => ({
  onUserRegistered: jest.fn().mockResolvedValue(null),
}));

jest.mock('bcryptjs', () => ({
  hash: jest.fn().mockResolvedValue('hashed-password'),
  compare: jest.fn().mockResolvedValue(true),
}));

jest.mock('jsonwebtoken', () => ({
  sign: jest.fn().mockReturnValue('test.jwt.token'),
}));

const mockSendCapiLeadEvent = jest.fn();
jest.mock('../services/metaService', () => ({
  metaService: {
    sendCapiLeadEvent: (...args: any[]) => mockSendCapiLeadEvent(...args),
  },
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
  mockGetUserByEmail.mockResolvedValue(null);
  mockUpdateUser.mockResolvedValue({ userId: 'uuid-u1' });
  mockSendCapiLeadEvent.mockResolvedValue({ success: true });
});

describe('register — createUser uniqueness conflict (ENG-2899)', () => {
  it('returns 409 email_unavailable when the email already occupies the PK', async () => {
    const err: any = new Error('The conditional request failed');
    err.code = 'ConditionalCheckFailedException';
    mockCreateUser.mockRejectedValue(err);
    const res = await request(makeApp()).post('/register').send({ email: 'old@user.com', password: 'ValidPass123!' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('email_unavailable');
    expect(res.body.message).toMatch(/contact support/i);
    // A just-created account may be missing from the eventually consistent
    // EmailIndex, so keep retry guidance (CodeRabbit on 77ae8a9).
    expect(res.body.message).toMatch(/try again/i);
    // login + forgot-password skip deleted_ tombstones, so never point there (Opslane run 1793).
    expect(res.body.message).not.toMatch(/sign(ing)? in|reset/i);
    expect(JSON.stringify(res.body)).not.toMatch(/tombstone|deleted|changed/i);
  });

  it('keeps the existing 400 when the conflict resolves to a live account (concurrent duplicate)', async () => {
    mockCreateUser.mockRejectedValue(Object.assign(new Error('c'), { code: 'ConditionalCheckFailedException' }));
    mockGetUserByEmail.mockResolvedValueOnce(null).mockResolvedValueOnce({ userId: 'u-live', email: 'dup@user.com' });
    const res = await request(makeApp()).post('/register').send({ email: 'dup@user.com', password: 'ValidPass123!' });
    expect(res.status).toBe(400);
  });

  it('leaves non-conflict failures on the unchanged persistence-failure response', async () => {
    mockCreateUser.mockRejectedValue(Object.assign(new Error('boom'), { code: 'ProvisionedThroughputExceededException' }));
    const res = await request(makeApp()).post('/register').send({ email: 'x@user.com', password: 'ValidPass123!' });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('registration_persistence_failed');
  });
});
