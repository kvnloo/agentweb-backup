import express from 'express';
import request from 'supertest';

const mockGetUserByEmail = jest.fn();
const mockGetUserById = jest.fn();
const mockCreateUser = jest.fn();
const mockUpdateUser = jest.fn();
const mockGetOrgWithPendingInviteForEmail = jest.fn();
const mockGetOrgsWithAutoJoinDomain = jest.fn();
const mockAddPendingDomainJoinRequest = jest.fn();
const mockSyncNewUserToLeadList = jest.fn();
const mockOnUserRegistered = jest.fn();
const mockSendTeamIntroductionEmail = jest.fn();
const mockJwtSign = jest.fn();
const mockAdmitZoma = jest.fn();
jest.mock('../services/zomaAdmission', () => ({
  ...jest.requireActual('../services/zomaAdmission'),
  admitZomaSignup: (...args: unknown[]) => mockAdmitZoma(...args),
}));

jest.mock('../services/db', () => ({
  userDb: {
    getUserByEmail: (...args: unknown[]) => mockGetUserByEmail(...args),
    getUserById: (...args: unknown[]) => mockGetUserById(...args),
    createUser: (...args: unknown[]) => mockCreateUser(...args),
    updateUser: (...args: unknown[]) => mockUpdateUser(...args),
  },
  orgDb: {
    getOrgWithPendingInviteForEmail: (...args: unknown[]) =>
      mockGetOrgWithPendingInviteForEmail(...args),
    getOrgsWithAutoJoinDomain: (...args: unknown[]) => mockGetOrgsWithAutoJoinDomain(...args),
    addPendingDomainJoinRequest: (...args: unknown[]) => mockAddPendingDomainJoinRequest(...args),
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
    sendTeamIntroductionEmail: (...args: unknown[]) => mockSendTeamIntroductionEmail(...args),
  },
}));

jest.mock('../services/subscriptionService', () => ({
  getTierConfig: jest.fn().mockResolvedValue({ allowedPages: ['home'], allowedSkills: [] }),
  DEFAULT_PAGES: ['home'],
}));

jest.mock('../services/crmAutoSyncService', () => ({
  syncNewUserToLeadList: (...args: unknown[]) => mockSyncNewUserToLeadList(...args),
}));

jest.mock('../types/attribution', () => ({
  normalizeAttribution: jest.fn().mockReturnValue(null),
}));

jest.mock('../services/contactCaptureHooks', () => ({
  onUserRegistered: (...args: unknown[]) => mockOnUserRegistered(...args),
}));

jest.mock('bcryptjs', () => ({
  hash: jest.fn().mockResolvedValue('hashed-password'),
  compare: jest.fn().mockResolvedValue(true),
}));

jest.mock('jsonwebtoken', () => ({
  sign: (...args: unknown[]) => mockJwtSign(...args),
}));

import { register, googleCallback } from '../controllers/auth';

const app = express();
app.use(express.json());
app.post('/register', register);

const registerRequest = (email = 'ghost@unresolvable.test') =>
  request(app)
    .post('/register')
    .send({ email, password: 'ValidPass123!', signupProduct: 'zoma' });

beforeEach(() => {
  jest.clearAllMocks();
  mockGetUserByEmail.mockResolvedValue(null);
  mockGetUserById.mockResolvedValue({ email: 'owner@unresolvable.test' });
  mockCreateUser.mockResolvedValue({
    userId: 'persisted-user',
    email: 'ghost@unresolvable.test',
    roles: ['customer'],
    isAdmin: false,
  });
  mockUpdateUser.mockResolvedValue({ userId: 'persisted-user' });
  mockGetOrgWithPendingInviteForEmail.mockResolvedValue(null);
  mockGetOrgsWithAutoJoinDomain.mockResolvedValue([]);
  mockSyncNewUserToLeadList.mockResolvedValue(undefined);
  mockOnUserRegistered.mockResolvedValue(undefined);
  mockSendTeamIntroductionEmail.mockResolvedValue(undefined);
  mockJwtSign.mockReturnValue('signed.jwt');
});

describe('ENG-2881 registration admission boundary', () => {
  beforeEach(() => { process.env.ZOMA_WAITLIST_ENABLED = 'true'; });
  afterEach(() => { delete process.env.ZOMA_WAITLIST_ENABLED; });
  it.each(['emma_web', 'emma_mcp', undefined])('does not gate %s signup even when capacity is unavailable', async (signupProduct) => {
    mockAdmitZoma.mockRejectedValue(new Error('counter unavailable'));
    const r = await request(app).post('/register').send({ email: 'ghost@unresolvable.test', password: 'ValidPass123!', signupProduct });
    expect(r.status).toBe(201);
    expect(mockAdmitZoma).not.toHaveBeenCalled();
  });
  it('Zoma setup/MCP signed intent reserves a seat without signupProduct', async () => {
    const { mintZomaSignupIntent } = require('../services/zomaSignupIntent');
    mockAdmitZoma.mockResolvedValue('approved');
    const r = await request(app).post('/register').send({ email: 'ghost@unresolvable.test', password: 'ValidPass123!', signupSource: 'mcp', signupIntent: mintZomaSignupIntent() });
    expect(r.status).toBe(201);
    expect(mockAdmitZoma).toHaveBeenCalledWith('ghost@unresolvable.test');
  });
  it('does not reclassify an invalid Zoma intent as an Emma signup', async () => {
    const r = await request(app).post('/register').send({ email: 'ghost@unresolvable.test', password: 'ValidPass123!', signupIntent: 'expired-or-tampered' });
    expect(r.status).toBe(400);
    expect(mockCreateUser).not.toHaveBeenCalled();
  });
  it('approved registration creates an account with access', async () => {
    mockAdmitZoma.mockResolvedValue('approved');
    const r = await registerRequest();
    expect(r.status).toBe(201);
    expect(r.body.token).toBe('signed.jwt');
    expect(mockCreateUser).toHaveBeenCalled();
  });
  it('overflow returns waitlist shape without creating account or token', async () => {
    mockAdmitZoma.mockResolvedValue('waitlisted');
    const r = await registerRequest();
    expect(r.status).toBe(202);
    expect(r.body).toEqual({ code: 'waitlisted', status: 'waitlisted', message: expect.any(String) });
    expect(mockCreateUser).not.toHaveBeenCalled();
    expect(mockJwtSign).not.toHaveBeenCalled();
  });
  it('OAuth signups on Emma portals never consult Zoma capacity', async () => {
    mockAdmitZoma.mockRejectedValue(new Error('counter unavailable'));
    for (const state of ['customer', 'genius', 'partner']) {
      const done = jest.fn();
      await googleCallback({ query: { state } } as any, '', '', { emails: [{ value: 'ghost@unresolvable.test' }] } as any, done);
      expect(done).toHaveBeenCalledWith(null, expect.objectContaining({ userId: 'persisted-user' }));
    }
    expect(mockAdmitZoma).not.toHaveBeenCalled();
  });
  it('existing OAuth accounts bypass admission and remain enabled', async () => {
    mockGetUserByEmail.mockResolvedValue({ userId: 'existing', email: 'ghost@unresolvable.test', roles: ['customer'] });
    const done = jest.fn();
    await googleCallback({ query: { state: 'customer' } } as any, '', '', { emails: [{ value: 'ghost@unresolvable.test' }] } as any, done);
    expect(mockAdmitZoma).not.toHaveBeenCalled();
    expect(done).toHaveBeenCalledWith(null, expect.objectContaining({ userId: 'existing' }));
  });
  it('admission outage fails closed', async () => {
    mockAdmitZoma.mockRejectedValue(new Error('unavailable'));
    expect((await registerRequest()).status).toBe(503);
    expect(mockCreateUser).not.toHaveBeenCalled();
  });
});

describe('register persistence boundary', () => {
  it('returns an actionable non-2xx and no token when createUser reports no persisted user', async () => {
    mockCreateUser.mockResolvedValue(undefined);

    const response = await registerRequest();

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      message: 'We could not create your account. Please try again.',
      code: 'registration_persistence_failed',
    });
    expect(response.body.user).toBeUndefined();
    expect(mockJwtSign).not.toHaveBeenCalled();
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it('returns the same actionable response when the persistence adapter throws', async () => {
    mockCreateUser.mockRejectedValue(new Error('DynamoDB write failed'));

    const response = await registerRequest();

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      message: 'We could not create your account. Please try again.',
      code: 'registration_persistence_failed',
    });
    expect(mockUpdateUser).not.toHaveBeenCalled();
    expect(mockGetOrgWithPendingInviteForEmail).not.toHaveBeenCalled();
    expect(mockGetOrgsWithAutoJoinDomain).not.toHaveBeenCalled();
    expect(mockSyncNewUserToLeadList).not.toHaveBeenCalled();
    expect(mockOnUserRegistered).not.toHaveBeenCalled();
    expect(mockSendTeamIntroductionEmail).not.toHaveBeenCalled();
    expect(mockJwtSign).not.toHaveBeenCalled();
  });

  it('answers a concurrent duplicate signup that lost the account write with 400 User already exists', async () => {
    mockGetUserByEmail
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ userId: 'winner', email: 'ghost@unresolvable.test' });
    mockCreateUser.mockRejectedValue(new Error('ConditionalCheckFailedException'));

    const response = await registerRequest();

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ message: 'User already exists' });
    expect(mockUpdateUser).not.toHaveBeenCalled();
    expect(mockOnUserRegistered).not.toHaveBeenCalled();
    expect(mockJwtSign).not.toHaveBeenCalled();
  });

  it('creates no pending organization request when persistence fails', async () => {
    mockCreateUser.mockResolvedValue(undefined);
    mockGetOrgsWithAutoJoinDomain.mockResolvedValue([{ orgId: 'org-1' }]);

    await registerRequest();

    expect(mockGetOrgWithPendingInviteForEmail).not.toHaveBeenCalled();
    expect(mockGetOrgsWithAutoJoinDomain).not.toHaveBeenCalled();
    expect(mockAddPendingDomainJoinRequest).not.toHaveBeenCalled();
  });

  it('starts no CRM, timeline, or introduction-email side effect when persistence fails', async () => {
    mockCreateUser.mockResolvedValue(undefined);

    await registerRequest();

    expect(mockSyncNewUserToLeadList).not.toHaveBeenCalled();
    expect(mockOnUserRegistered).not.toHaveBeenCalled();
    expect(mockSendTeamIntroductionEmail).not.toHaveBeenCalled();
  });

  it('preserves the persisted company-domain registration path', async () => {
    mockCreateUser.mockResolvedValue({
      userId: 'persisted-user',
      email: 'member@agentweb.pro',
      roles: ['customer'],
      isAdmin: false,
    });

    const response = await registerRequest('member@agentweb.pro');

    expect(response.status).toBe(201);
    expect(response.body.token).toBe('signed.jwt');
    expect(mockUpdateUser).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ subscriptionType: 'Free' }),
    );
    expect(mockSyncNewUserToLeadList).toHaveBeenCalledTimes(1);
    expect(mockOnUserRegistered).toHaveBeenCalledTimes(1);
  });
});

describe('ENG-3124 Zoma signup is separate from Emma signup', () => {
  const { mintZomaSignupIntent, encodeGoogleOAuthState } = require('../services/zomaSignupIntent');
  const gmail = 'founder@gmail.com';
  const google = (state: string) => {
    const done = jest.fn();
    return googleCallback({ query: { state } } as any, '', '', { id: 'g-1', emails: [{ value: gmail }] } as any, done).then(() => done);
  };

  it('Google sign-in with a signed Zoma intent creates a personal-email account attributed to the consent flow', async () => {
    const done = await google(encodeGoogleOAuthState('customer', mintZomaSignupIntent()));
    expect(mockCreateUser).toHaveBeenCalledWith(gmail, expect.any(String), expect.any(String), true, false, ['customer'], expect.anything(), 'g-1', undefined, undefined, undefined);
    expect(mockUpdateUser).toHaveBeenCalledWith('persisted-user', expect.objectContaining({ signupSource: 'mcp' }));
    expect(done).toHaveBeenCalledWith(null, expect.objectContaining({ userId: 'persisted-user', token: 'signed.jwt' }));
  });

  it('Google sign-in with a Zoma intent applies the Zoma capacity gate', async () => {
    process.env.ZOMA_WAITLIST_ENABLED = 'true';
    try {
      mockAdmitZoma.mockResolvedValue('waitlisted');
      const done = await google(encodeGoogleOAuthState('customer', mintZomaSignupIntent()));
      expect(done).toHaveBeenCalledWith(expect.objectContaining({ code: 'waitlisted' }), null);
      expect(mockCreateUser).not.toHaveBeenCalled();
    } finally {
      delete process.env.ZOMA_WAITLIST_ENABLED;
    }
  });

  it.each([
    ['no intent', 'customer'],
    ['a tampered intent', `customer~${'9'.repeat(10)}.forged`],
  ])('Google sign-in with a personal email and %s is still rejected (Emma requires a company email)', async (_label, state) => {
    const done = await google(state);
    expect(done).toHaveBeenCalledWith(expect.objectContaining({ code: 'personal_email_not_allowed' }), null);
    expect(mockCreateUser).not.toHaveBeenCalled();
  });

  it('email signup with a personal email and a signed Zoma intent is created', async () => {
    const r = await request(app).post('/register').send({ email: gmail, password: 'ValidPass123!', signupSource: 'mcp', signupIntent: mintZomaSignupIntent() });
    expect(r.status).toBe(201);
    expect(mockCreateUser).toHaveBeenCalled();
  });

  it.each([
    ['no intent', {}],
    ['the unsigned signupProduct marker', { signupProduct: 'zoma' }],
    ['a tampered intent', { signupIntent: '9999999999.forged' }],
  ])('email signup with a personal email and %s is rejected', async (_label, extra) => {
    const r = await request(app).post('/register').send({ email: gmail, password: 'ValidPass123!', ...extra });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('personal_email_not_allowed');
    expect(mockCreateUser).not.toHaveBeenCalled();
  });
});
