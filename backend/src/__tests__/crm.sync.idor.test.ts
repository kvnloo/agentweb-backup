/**
 * Tests for the IDOR fix on POST /api/crm/sync.
 *
 * Behaviour we want:
 *   (a) unauthenticated request -> 401
 *   (b) authenticated request with body.tenantId mismatching authReq.user.userId -> 403
 *   (c) authenticated request with no body.tenantId -> server stamps tenantId = userId
 *   (d) authenticated request with body.tenantId === userId -> success, passes through
 */

jest.mock('../server', () => ({
  io: { to: jest.fn().mockReturnValue({ emit: jest.fn() }), emit: jest.fn() },
  app: {},
}));

jest.mock('../controllers/templates', () => ({
  createTemplate: jest.fn(),
  getTemplates: jest.fn(),
  getTemplate: jest.fn(),
  updateTemplate: jest.fn(),
  deleteTemplate: jest.fn(),
  publishTemplate: jest.fn(),
}));

jest.mock('../config/aws', () => ({
  dynamodb: {
    get: jest.fn().mockReturnValue({ promise: () => Promise.resolve({}) }),
    put: jest.fn().mockReturnValue({ promise: () => Promise.resolve({}) }),
    update: jest.fn().mockReturnValue({ promise: () => Promise.resolve({}) }),
    delete: jest.fn().mockReturnValue({ promise: () => Promise.resolve({}) }),
    query: jest.fn().mockReturnValue({ promise: () => Promise.resolve({ Items: [] }) }),
    scan: jest.fn().mockReturnValue({ promise: () => Promise.resolve({ Items: [] }) }),
  },
}));

jest.mock('../services/db', () => ({
  crmDb: {},
  taskDb: {},
  subscriberDb: {},
  userDb: {},
  orgDb: {},
}));

jest.mock('../services/dealDb', () => ({
  dealDb: {},
  DealAuthError: class extends Error {},
  DealNotFoundError: class extends Error {},
  DEAL_STAGES: [],
}));

jest.mock('../services/settingsService', () => ({ settingsService: { getSetting: jest.fn(), setSetting: jest.fn() } }));
jest.mock('../services/resendService', () => ({ resendService: { sendEmail: jest.fn() } }));
jest.mock('../services/leadListAlertService', () => ({ leadListAlertService: {} }));

const mockSyncContact = jest.fn();
jest.mock('../services/contactSyncService', () => ({
  syncContact: (...args: any[]) => mockSyncContact(...args),
}));

jest.mock('../services/internalEnrichmentService', () => ({
  enrichContact: jest.fn(),
  defaultEnrichmentCache: {},
}));
jest.mock('../services/contactDedupService', () => ({ dedupContactsForUser: jest.fn() }));
jest.mock('../services/emailEventsDb', () => ({ emailEventsDb: {} }));
jest.mock('../services/externalCrmSyncService', () => ({ externalCrmSyncService: {} }));
jest.mock('../services/dripSequenceDb', () => ({ dripSequenceDb: {} }));

const mockUser: { userId: string; email: string; isAdmin?: boolean } = {
  userId: 'user-A',
  email: 'a@example.com',
  isAdmin: false,
};

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = mockUser.userId
      ? { userId: mockUser.userId, email: mockUser.email, isAdmin: mockUser.isAdmin }
      : undefined;
    next();
  },
  AuthenticatedRequest: {},
}));

import express from 'express';
import request from 'supertest';
import router from '../routes/crm';

const app = express();
app.use(express.json());
app.use('/api/crm', router);

beforeEach(() => {
  jest.clearAllMocks();
  mockUser.userId = 'user-A';
  mockUser.email = 'a@example.com';
  mockUser.isAdmin = false;
});

const validBody = (overrides: Record<string, unknown> = {}) => ({
  source: 'manual',
  sourceRecordId: 'rec-1',
  eventType: 'manual.event',
  identity: { email: 'lead@x.com' },
  ...overrides,
});

describe('POST /api/crm/sync — IDOR guard', () => {
  it('returns 401 when unauthenticated', async () => {
    mockUser.userId = '';
    const res = await request(app).post('/api/crm/sync').send(validBody());
    expect(res.status).toBe(401);
    expect(mockSyncContact).not.toHaveBeenCalled();
  });

  it('returns 403 when tenantId mismatches authenticated userId', async () => {
    const res = await request(app)
      .post('/api/crm/sync')
      .send(validBody({ tenantId: 'user-B' }));
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/tenantId mismatch/i);
    expect(mockSyncContact).not.toHaveBeenCalled();
  });

  it('stamps tenantId = userId when client omits tenantId', async () => {
    mockSyncContact.mockResolvedValueOnce({
      contactId: 'c-1',
      created: false,
      deduplicated: false,
      event: { eventId: 'e-1', eventType: 'manual.event' },
      scores: { heatScore: 0, healthScore: 0, lifecycle: 'lead' },
    });
    const res = await request(app).post('/api/crm/sync').send(validBody());
    expect(res.status).toBe(200);
    expect(mockSyncContact).toHaveBeenCalledTimes(1);
    const calledWith = mockSyncContact.mock.calls[0][0];
    expect(calledWith.tenantId).toBe('user-A');
  });

  it('passes through when tenantId matches authenticated userId', async () => {
    mockSyncContact.mockResolvedValueOnce({
      contactId: 'c-1',
      created: true,
      deduplicated: false,
      event: { eventId: 'e-1', eventType: 'manual.event' },
      scores: { heatScore: 1, healthScore: 1, lifecycle: 'lead' },
    });
    const res = await request(app)
      .post('/api/crm/sync')
      .send(validBody({ tenantId: 'user-A' }));
    expect(res.status).toBe(200);
    expect(mockSyncContact).toHaveBeenCalledTimes(1);
    const calledWith = mockSyncContact.mock.calls[0][0];
    expect(calledWith.tenantId).toBe('user-A');
  });
});
