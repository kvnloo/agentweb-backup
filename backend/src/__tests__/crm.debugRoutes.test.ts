/**
 * Tests for the admin gate on:
 *   POST /api/crm/debug/serp
 *   GET  /api/crm/debug/enrichment-raw-cache
 *
 * Both must require isAdmin in addition to a valid userId.
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

const mockSearchWeb = jest.fn();
jest.mock('../services/agentModeService', () => ({
  agentModeService: { searchWeb: (...args: any[]) => mockSearchWeb(...args) },
}));

const dynamoScan = jest.fn();
jest.mock('aws-sdk', () => {
  return {
    DynamoDB: Object.assign(
      jest.fn().mockImplementation(() => ({
        createTable: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
        waitFor: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      })),
      {
        DocumentClient: jest.fn().mockImplementation(() => ({
          scan: (...args: any[]) => ({ promise: () => dynamoScan(...args) }),
        })),
      }
    ),
  };
});

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
jest.mock('../services/contactSyncService', () => ({ syncContact: jest.fn() }));
jest.mock('../services/internalEnrichmentService', () => ({
  enrichContact: jest.fn(),
  defaultEnrichmentCache: {},
}));
jest.mock('../services/contactDedupService', () => ({ dedupContactsForUser: jest.fn() }));
jest.mock('../services/emailEventsDb', () => ({ emailEventsDb: {} }));
jest.mock('../services/externalCrmSyncService', () => ({ externalCrmSyncService: {} }));
jest.mock('../services/dripSequenceDb', () => ({ dripSequenceDb: {} }));

const mockUser: { userId: string; email: string; isAdmin: boolean } = {
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
  dynamoScan.mockReset();
});

describe('POST /api/crm/debug/serp', () => {
  it('returns 401 when unauthenticated', async () => {
    mockUser.userId = '';
    const res = await request(app).post('/api/crm/debug/serp').send({ query: 'foo' });
    expect(res.status).toBe(401);
    expect(mockSearchWeb).not.toHaveBeenCalled();
  });

  it('returns 403 for non-admin user', async () => {
    mockUser.userId = 'user-A';
    mockUser.isAdmin = false;
    const res = await request(app).post('/api/crm/debug/serp').send({ query: 'foo' });
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/admin/i);
    expect(mockSearchWeb).not.toHaveBeenCalled();
  });

  it('returns 200 for admin user', async () => {
    mockUser.isAdmin = true;
    mockSearchWeb.mockResolvedValueOnce({ success: true, results: [{ title: 't', link: 'l' }] });
    const res = await request(app).post('/api/crm/debug/serp').send({ query: 'foo' });
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(mockSearchWeb).toHaveBeenCalledWith('foo', 5);
  });
});

describe('GET /api/crm/debug/enrichment-raw-cache', () => {
  it('returns 401 when unauthenticated', async () => {
    mockUser.userId = '';
    const res = await request(app).get('/api/crm/debug/enrichment-raw-cache');
    expect(res.status).toBe(401);
    expect(dynamoScan).not.toHaveBeenCalled();
  });

  it('returns 403 for non-admin user', async () => {
    mockUser.userId = 'user-A';
    mockUser.isAdmin = false;
    const res = await request(app).get('/api/crm/debug/enrichment-raw-cache');
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/admin/i);
    expect(dynamoScan).not.toHaveBeenCalled();
  });

  it('returns 200 for admin user (mock scan succeeds)', async () => {
    mockUser.isAdmin = true;
    dynamoScan.mockResolvedValueOnce({
      Count: 1,
      ScannedCount: 1,
      Items: [{ canonicalId: 'x', fieldGroup: 'fg' }],
      LastEvaluatedKey: undefined,
    });
    const res = await request(app).get('/api/crm/debug/enrichment-raw-cache');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
  });
});
