/**
 * ENG-2906: a password signup made on the MCP OAuth consent page (portal sends
 * signupSource "mcp") is stamped signupSource "mcp" on the AW-Users row and is NOT attributed
 * as a web signup; the consent decision attributes it (requiring that marker, never account
 * age). Any other password signup is an Emma web signup and gets no marker.
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
  orgDb: {
    getOrgWithPendingInviteForEmail: jest.fn().mockResolvedValue(null),
    getOrgsWithAutoJoinDomain: jest.fn().mockResolvedValue([]),
  },
}));

jest.mock('../services/serverSignalEmitter', () => ({ emitAppSignal: jest.fn().mockResolvedValue(true) }));

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

const mockNoteSignup = jest.fn().mockResolvedValue(true);
jest.mock('../services/journeyMilestones', () => ({
  noteSignup: (...a: any[]) => mockNoteSignup(...a),
  noteProductUse: jest.fn().mockResolvedValue(undefined),
}));

import { register } from '../controllers/auth';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.post('/register', register);
  return app;
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  jest.clearAllMocks();
  process.env.AGENTWEB_META_PIXEL_ID = 'test-pixel';
  process.env.AGENTWEB_META_CAPI_ACCESS_TOKEN = 'test-capi';
  mockGetUserByEmail.mockResolvedValue(null);
  mockCreateUser.mockResolvedValue({ userId: 'uuid-u1', email: 'new@user.com', isAdmin: false, roles: ['customer'] });
  mockUpdateUser.mockResolvedValue({ userId: 'uuid-u1' });
  mockSendCapiLeadEvent.mockResolvedValue({ success: true });
});

describe('ENG-2906 register: consent-page signup marker', () => {
  it('stamps signupSource "mcp" on the row and defers attribution to the consent decision', async () => {
    const res = await request(makeApp()).post('/register').send({ email: 'new@user.com', password: 'ValidPass123!', signupSource: 'mcp' });
    expect(res.status).toBe(201);
    await flush();
    const tierUpdate = mockUpdateUser.mock.calls.find((c) => c[1]?.subscriptionType === 'Free');
    expect(tierUpdate?.[1]).toMatchObject({ signupSource: 'mcp' });
    expect(mockNoteSignup).not.toHaveBeenCalled();
  });

  it('a web signup gets no marker and is attributed emma_web (explicit, stored as tracked)', async () => {
    const res = await request(makeApp()).post('/register').send({ email: 'new@user.com', password: 'ValidPass123!', ref: 'hn' });
    expect(res.status).toBe(201);
    await flush();
    const tierUpdate = mockUpdateUser.mock.calls.find((c) => c[1]?.subscriptionType === 'Free');
    expect(tierUpdate?.[1]).not.toHaveProperty('signupSource');
    expect(mockNoteSignup).toHaveBeenCalledWith(expect.any(String), { product: 'emma_web', path: 'webapp', client: 'web', ref: 'hn', confidence: 'explicit' });
  });

  it('an arbitrary signupSource value is not persisted as the marker', async () => {
    await request(makeApp()).post('/register').send({ email: 'new@user.com', password: 'ValidPass123!', signupSource: 'evil' });
    const tierUpdate = mockUpdateUser.mock.calls.find((c) => c[1]?.subscriptionType === 'Free');
    expect(tierUpdate?.[1]).not.toHaveProperty('signupSource');
  });
});
