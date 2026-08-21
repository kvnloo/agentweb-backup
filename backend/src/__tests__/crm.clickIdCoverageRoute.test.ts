/**
 * ENG-926 §F / AC5 — the click-ID coverage endpoint.
 *
 * Mock harness copied from crm.debugRoutes.test.ts, which is the established way to
 * mount this router without its full dependency graph. The coverage computation itself
 * is covered in metaAttributionCoverage.test.ts; this pins auth, validation, and that the
 * route is reachable at all — it sits after ~6800 lines of other routes, and a shadowing
 * path would be invisible from the handler.
 */

const mockComputeCoverage = jest.fn();
jest.mock('../services/metaAttributionCoverage', () => ({
  computeClickIdCoverageForUser: (...a: any[]) => mockComputeCoverage(...a),
}));

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
  agentModeService: { youSearchWeb: (...args: any[]) => mockSearchWeb(...args) },
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
    SecretsManager: jest.fn().mockImplementation(() => ({
      getSecretValue: jest.fn().mockReturnValue({
        promise: jest.fn().mockResolvedValue({ SecretString: '{}' }),
      }),
    })),
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

const COVERAGE = {
  windowDays: 30,
  totals: { leads: 4, withClickId: 0, coverage: 0, undated: 0 },
  daily: [],
  lists: [],
  unreadableLists: [],
};

beforeEach(() => {
  jest.clearAllMocks();
  mockUser.userId = 'user-A';
  mockComputeCoverage.mockResolvedValue(COVERAGE);
});

describe('GET /api/crm/attribution/click-id-coverage', () => {
  it('returns 401 when unauthenticated', async () => {
    mockUser.userId = '';
    const res = await request(app).get('/api/crm/attribution/click-id-coverage');
    expect(res.status).toBe(401);
    expect(mockComputeCoverage).not.toHaveBeenCalled();
  });

  it('is reachable and scoped to the caller, never to a client-supplied user', async () => {
    // The route sits after ~6800 lines of other routes; if any of them shadowed this path
    // the handler would never run and would look correct in isolation.
    const res = await request(app).get('/api/crm/attribution/click-id-coverage');
    expect(res.status).toBe(200);
    expect(mockComputeCoverage).toHaveBeenCalledWith('user-A', 30);
  });

  it('ignores a userId supplied in the query string', async () => {
    await request(app).get('/api/crm/attribution/click-id-coverage?userId=someone-else');
    expect(mockComputeCoverage).toHaveBeenCalledWith('user-A', 30);
  });

  it('honours an explicit window', async () => {
    await request(app).get('/api/crm/attribution/click-id-coverage?days=7');
    expect(mockComputeCoverage).toHaveBeenCalledWith('user-A', 7);
  });

  it('rejects a window that would page the entire CRM', async () => {
    for (const days of ['0', '-5', '400', 'abc', '7.5.1']) {
      const res = await request(app).get(`/api/crm/attribution/click-id-coverage?days=${days}`);
      expect(res.status).toBe(400);
    }
    expect(mockComputeCoverage).not.toHaveBeenCalled();
  });

  it('returns the computed body unchanged', async () => {
    const res = await request(app).get('/api/crm/attribution/click-id-coverage');
    expect(res.body).toEqual(COVERAGE);
  });

  it('fails with 500 rather than leaking an internal error message', async () => {
    mockComputeCoverage.mockRejectedValue(new Error('dynamo table AW-Leads throttled'));
    const res = await request(app).get('/api/crm/attribution/click-id-coverage');
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('AW-Leads');
  });
});
