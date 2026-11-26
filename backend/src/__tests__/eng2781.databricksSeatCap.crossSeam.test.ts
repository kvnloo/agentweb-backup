// ENG-2781: Databricks exemption is behind the launch flag; these suites test it ON, window closed.
process.env.ZOMA_DATABRICKS_LAUNCH_ENABLED = 'true';
process.env.ZOMA_OPEN_TESTER_UNTIL = '2000-01-01T00:00:00Z';
/**
 * ENG-2781 cross-seam: a REAL signed Databricks signup intent through the REAL register / Google callback /
 * authorization admission path, with only the storage layer faked (the AW-Waitlist DynamoDB fake the ENG-2881
 * launch tests use, plus the user/org stores). Nothing between the token and the seat counter is mocked, so a
 * break in the marker, the controller wiring or the exemption shows up here even when each unit test passes.
 */
const mockGetUserByEmail = jest.fn();
const mockGetUserById = jest.fn();
const mockCreateUser = jest.fn();
const mockUpdateUser = jest.fn();
const mockGetOrgWithPendingInviteForEmail = jest.fn();
const mockJwtSign = jest.fn();

jest.mock('aws-sdk', () => require('./helpers/zomaWaitlistFake').awsSdkMockWithInertClients());
jest.mock('../services/db', () => ({
  userDb: {
    getUserByEmail: (...args: unknown[]) => mockGetUserByEmail(...args),
    getUserById: (...args: unknown[]) => mockGetUserById(...args),
    createUser: (...args: unknown[]) => mockCreateUser(...args),
    updateUser: (...args: unknown[]) => mockUpdateUser(...args),
  },
  orgDb: {
    getOrgWithPendingInviteForEmail: (...args: unknown[]) => mockGetOrgWithPendingInviteForEmail(...args),
    getOrgsWithAutoJoinDomain: jest.fn().mockResolvedValue([]),
    addPendingDomainJoinRequest: jest.fn(),
  },
  taskDb: {},
  subscriberDb: {},
}));
jest.mock('../services/waitlistDb', () => ({ waitlistDb: { getByEmail: jest.fn().mockResolvedValue(null) } }));
jest.mock('../services/emailService', () => ({
  emailService: { sendEmail: jest.fn().mockResolvedValue(undefined), sendTeamIntroductionEmail: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('../services/subscriptionService', () => ({
  getTierConfig: jest.fn().mockResolvedValue({ allowedPages: ['home'], allowedSkills: [] }),
  DEFAULT_PAGES: ['home'],
}));
jest.mock('../services/crmAutoSyncService', () => ({ syncNewUserToLeadList: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../types/attribution', () => ({ normalizeAttribution: jest.fn().mockReturnValue(null) }));
jest.mock('../services/contactCaptureHooks', () => ({ onUserRegistered: jest.fn().mockResolvedValue(undefined) }));
jest.mock('bcryptjs', () => ({ hash: jest.fn().mockResolvedValue('hashed-password'), compare: jest.fn().mockResolvedValue(true) }));
jest.mock('jsonwebtoken', () => ({ sign: (...args: unknown[]) => mockJwtSign(...args) }));

import express from 'express';
import request from 'supertest';
import { mockGet, rows } from './helpers/zomaWaitlistFake';
import { register, googleCallback } from '../controllers/auth';
import { admitZomaAuthorizationSignup } from '../services/zomaAuthorizationAdmission';
import { setZomaWaitlistSlackPoster } from '../services/zomaAdmission';
import { encodeGoogleOAuthState, mintZomaSignupIntent } from '../services/zomaSignupIntent';

const COUNTER = '__zoma_free_capacity__';
const buyer = 'buyer@gmail.com'; // a personal address: only a valid signed Zoma intent lets it register at all
const company = 'ghost@unresolvable.test';

const app = express();
app.use(express.json());
app.post('/register', register);
const signup = (email: string, signupIntent: string) =>
  request(app).post('/register').send({ email, password: 'ValidPass123!', signupSource: 'mcp', signupIntent });
const google = (state: string) => {
  const done = jest.fn();
  return googleCallback({ query: { state } } as any, '', '', { id: 'g-1', emails: [{ value: buyer }] } as any, done).then(() => done);
};
const seatsUsed = () => rows.get(COUNTER).approvedCount;
/** The ordinary intent with the Databricks marker bolted on: the mac does not cover it. */
const forgedMarker = () => {
  const [expiry, mac] = mintZomaSignupIntent().split('.');
  return `${expiry}.db.${mac}`;
};

let log: jest.SpyInstance;
beforeEach(() => {
  rows.clear();
  rows.set(COUNTER, { email: COUNTER, approvedCount: 60 }); // every free seat is taken
  process.env.ZOMA_WAITLIST_ENABLED = 'true';
  process.env.ZOMA_FREE_USER_CAP = '60';
  process.env.ZOMA_WAITLIST_COHORT_STARTED_AT = '2026-11-13T00:00:00.000Z';
  setZomaWaitlistSlackPoster(async () => undefined);
  mockGetUserByEmail.mockResolvedValue(null);
  mockCreateUser.mockResolvedValue({ userId: 'persisted-user', email: buyer, roles: ['customer'], isAdmin: false });
  mockUpdateUser.mockResolvedValue({ userId: 'persisted-user' });
  mockGetOrgWithPendingInviteForEmail.mockResolvedValue(null);
  mockJwtSign.mockReturnValue('signed.jwt');
  log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
  log.mockRestore();
  delete process.env.ZOMA_WAITLIST_ENABLED;
  delete process.env.ZOMA_FREE_USER_CAP;
  delete process.env.ZOMA_WAITLIST_COHORT_STARTED_AT;
});
afterAll(() => setZomaWaitlistSlackPoster(async () => undefined));

describe('registration (POST /register) with the free seats full', () => {
  it('a real signed Databricks intent is admitted without a seat: account created, counter unchanged, no waitlist row', async () => {
    const r = await signup(buyer, mintZomaSignupIntent({ databricks: true }));
    expect(r.status).toBe(201);
    expect(mockCreateUser).toHaveBeenCalledTimes(1);
    expect(seatsUsed()).toBe(60);
    expect([...rows.keys()]).toEqual([COUNTER]);
    expect(log.mock.calls.map(([line]) => String(line)).join('\n')).toContain('signed intent marker');
    expect(JSON.stringify(log.mock.calls)).not.toContain(buyer);
  });

  it('a real signed ordinary intent is still waitlisted: no account, a waitlist row, counter unchanged', async () => {
    const r = await signup(buyer, mintZomaSignupIntent());
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ code: 'waitlisted' });
    expect(mockCreateUser).not.toHaveBeenCalled();
    expect(rows.get(buyer)).toEqual(expect.objectContaining({ zomaStatus: 'waitlisted' }));
    expect(seatsUsed()).toBe(60);
  });

  it.each([
    ['a company address', company, 'invalid_signup_intent'],
    ['a personal address', buyer, 'personal_email_not_allowed'],
  ])('a forged Databricks marker with %s is refused before any seat decision', async (_label, email, code) => {
    const r = await signup(email, forgedMarker());
    expect(r.status).toBe(400);
    expect(r.body.code).toBe(code);
    expect(mockCreateUser).not.toHaveBeenCalled();
    expect([...rows.keys()]).toEqual([COUNTER]); // no waitlist row, no seat
    expect(seatsUsed()).toBe(60);
  });

  it('an admin Reject stands: a rejected applicant with a Databricks intent is refused and the row is untouched', async () => {
    rows.set(buyer, { email: buyer, zomaStatus: 'rejected', rejectedBy: 'admin-1' });
    const r = await signup(buyer, mintZomaSignupIntent({ databricks: true }));
    expect(r.status).toBe(202);
    expect(mockCreateUser).not.toHaveBeenCalled();
    expect(rows.get(buyer)).toEqual({ email: buyer, zomaStatus: 'rejected', rejectedBy: 'admin-1' });
    expect(seatsUsed()).toBe(60);
  });

  it('a waitlisted applicant with a Databricks intent is admitted: the cap is moot for them, the row is untouched', async () => {
    rows.set(buyer, { email: buyer, zomaStatus: 'waitlisted' });
    const r = await signup(buyer, mintZomaSignupIntent({ databricks: true }));
    expect(r.status).toBe(201);
    expect(rows.get(buyer)).toEqual({ email: buyer, zomaStatus: 'waitlisted' });
    expect(seatsUsed()).toBe(60);
  });

  it('with the gate off the Databricks intent never touches the waitlist storage', async () => {
    delete process.env.ZOMA_WAITLIST_ENABLED;
    const r = await signup(buyer, mintZomaSignupIntent({ databricks: true }));
    expect(r.status).toBe(201);
    expect(mockGet).not.toHaveBeenCalled();
    expect(seatsUsed()).toBe(60);
  });
});

describe('Google sign-in with the free seats full', () => {
  it('a real Databricks state is admitted without a seat', async () => {
    const done = await google(encodeGoogleOAuthState('customer', mintZomaSignupIntent({ databricks: true })));
    expect(done).toHaveBeenCalledWith(null, expect.objectContaining({ userId: 'persisted-user' }));
    expect(seatsUsed()).toBe(60);
    expect([...rows.keys()]).toEqual([COUNTER]);
  });

  it('a real ordinary Zoma state is still waitlisted', async () => {
    const done = await google(encodeGoogleOAuthState('customer', mintZomaSignupIntent()));
    expect(done).toHaveBeenCalledWith(expect.objectContaining({ code: 'waitlisted' }), null);
    expect(mockCreateUser).not.toHaveBeenCalled();
    expect(seatsUsed()).toBe(60);
  });

  it('a forged Databricks marker is neither exempt nor allowed a personal address', async () => {
    const done = await google(`customer~${forgedMarker()}`);
    expect(done).toHaveBeenCalledWith(expect.objectContaining({ code: 'personal_email_not_allowed' }), null);
    expect(mockCreateUser).not.toHaveBeenCalled();
    expect([...rows.keys()]).toEqual([COUNTER]);
  });

  it('a rejected applicant stays refused through a Databricks state', async () => {
    rows.set(buyer, { email: buyer, zomaStatus: 'rejected' });
    const done = await google(encodeGoogleOAuthState('customer', mintZomaSignupIntent({ databricks: true })));
    expect(done).toHaveBeenCalledWith(expect.objectContaining({ code: 'waitlisted' }), null);
    expect(mockCreateUser).not.toHaveBeenCalled();
  });
});

describe('OAuth authorization (admitZomaAuthorizationSignup) with the free seats full', () => {
  beforeEach(() => mockGetUserById.mockResolvedValue({ email: buyer, createdAt: '2026-11-14T00:00:00.000Z' }));

  it('a Databricks origin is admitted without a seat, and the log names the client and account but not the email', async () => {
    expect(await admitZomaAuthorizationSignup('u-1', { databricks: true, clientId: 'client-1' })).toBe('approved');
    expect(seatsUsed()).toBe(60);
    expect([...rows.keys()]).toEqual([COUNTER]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Databricks-origin signup admitted'), { clientId: 'client-1', userId: 'u-1' });
    expect(JSON.stringify(log.mock.calls)).not.toContain(buyer);
  });

  it('any other client is still waitlisted', async () => {
    expect(await admitZomaAuthorizationSignup('u-1')).toBe('waitlisted');
    expect(rows.get(buyer)).toEqual(expect.objectContaining({ zomaStatus: 'waitlisted' }));
    expect(seatsUsed()).toBe(60);
  });

  it('an admin Reject stands for a Databricks origin', async () => {
    rows.set(buyer, { email: buyer, zomaStatus: 'rejected' });
    expect(await admitZomaAuthorizationSignup('u-1', { databricks: true, clientId: 'client-1' })).toBe('rejected');
    expect(seatsUsed()).toBe(60);
    expect(log).not.toHaveBeenCalled();
  });

  it('a waitlisted applicant is admitted for a Databricks origin', async () => {
    rows.set(buyer, { email: buyer, zomaStatus: 'waitlisted' });
    expect(await admitZomaAuthorizationSignup('u-1', { databricks: true, clientId: 'client-1' })).toBe('approved');
    expect(rows.get(buyer)).toEqual({ email: buyer, zomaStatus: 'waitlisted' });
  });

  it('is dark with the gate off: nothing is read', async () => {
    delete process.env.ZOMA_WAITLIST_ENABLED;
    expect(await admitZomaAuthorizationSignup('u-1', { databricks: true, clientId: 'client-1' })).toBe('approved');
    expect(mockGet).not.toHaveBeenCalled();
    expect(mockGetUserById).not.toHaveBeenCalled();
  });
});
