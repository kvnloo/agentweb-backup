/**
 * ENG-1402: registration fires a server-side Meta CAPI `CompleteRegistration`
 * event carrying the same `eventId` returned to the client for its browser-side
 * `fbq('track', 'CompleteRegistration', ..., { eventID })` call, so the two
 * dedupe into one Meta conversion.
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

const ORIGINAL_ENV = process.env;

beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...ORIGINAL_ENV };
  mockGetUserByEmail.mockResolvedValue(null); // no existing user
  mockCreateUser.mockResolvedValue({
    userId: 'uuid-u1',
    email: 'new@user.com',
    isAdmin: false,
    roles: ['customer'],
  });
  mockUpdateUser.mockResolvedValue({ userId: 'uuid-u1' });
  mockSendCapiLeadEvent.mockResolvedValue({ success: true, fbtraceId: 'trace-1' });
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

// Registration fires the CAPI send fire-and-forget; give its microtask a tick
// to run before asserting on the mock.
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('register controller — CompleteRegistration CAPI (ENG-1402)', () => {
  it('returns a metaEventId in the response body', async () => {
    process.env.AGENTWEB_META_PIXEL_ID = 'pixel-123';
    process.env.AGENTWEB_META_CAPI_ACCESS_TOKEN = 'token-abc';

    const app = makeApp();
    const res = await request(app)
      .post('/register')
      .send({ email: 'new@user.com', password: 'ValidPass123!' });

    expect(res.status).toBe(201);
    expect(typeof res.body.metaEventId).toBe('string');
    expect(res.body.metaEventId.length).toBeGreaterThan(0);
  });

  it('sends a server-side CompleteRegistration CAPI event carrying the same eventId returned to the client', async () => {
    process.env.AGENTWEB_META_PIXEL_ID = 'pixel-123';
    process.env.AGENTWEB_META_CAPI_ACCESS_TOKEN = 'token-abc';

    const app = makeApp();
    const res = await request(app)
      .post('/register')
      .send({ email: 'new@user.com', password: 'ValidPass123!' });
    await flush();

    expect(mockSendCapiLeadEvent).toHaveBeenCalledTimes(1);
    const [pixelId, accessToken, event] = mockSendCapiLeadEvent.mock.calls[0];
    expect(pixelId).toBe('pixel-123');
    expect(accessToken).toBe('token-abc');
    expect(event.eventName).toBe('CompleteRegistration');
    expect(event.email).toBe('new@user.com');
    expect(event.eventId).toBe(res.body.metaEventId);
  });

  it('still returns 201 with a metaEventId, and does not throw, when AGENTWEB_META_* env is unset', async () => {
    delete process.env.AGENTWEB_META_PIXEL_ID;
    delete process.env.AGENTWEB_META_CAPI_ACCESS_TOKEN;

    const app = makeApp();
    const res = await request(app)
      .post('/register')
      .send({ email: 'new@user.com', password: 'ValidPass123!' });
    await flush();

    expect(res.status).toBe(201);
    expect(typeof res.body.metaEventId).toBe('string');
    expect(mockSendCapiLeadEvent).not.toHaveBeenCalled();
  });

  it('does not fail registration when the CAPI send rejects', async () => {
    process.env.AGENTWEB_META_PIXEL_ID = 'pixel-123';
    process.env.AGENTWEB_META_CAPI_ACCESS_TOKEN = 'token-abc';
    mockSendCapiLeadEvent.mockRejectedValueOnce(new Error('meta down'));

    const app = makeApp();
    const res = await request(app)
      .post('/register')
      .send({ email: 'new@user.com', password: 'ValidPass123!' });
    await flush();

    expect(res.status).toBe(201);
  });

  it('does not fail registration when the CAPI send resolves success:false', async () => {
    process.env.AGENTWEB_META_PIXEL_ID = 'pixel-123';
    process.env.AGENTWEB_META_CAPI_ACCESS_TOKEN = 'token-abc';
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockSendCapiLeadEvent.mockResolvedValueOnce({ success: false, error: 'invalid_token' });

    const app = makeApp();
    const res = await request(app)
      .post('/register')
      .send({ email: 'new@user.com', password: 'ValidPass123!' });
    await flush();

    expect(res.status).toBe(201);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('CompleteRegistration CAPI send failed: invalid_token')
    );
    errorSpy.mockRestore();
  });
});
