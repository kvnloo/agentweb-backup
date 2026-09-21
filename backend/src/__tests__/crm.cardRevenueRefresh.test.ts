/**
 * ENG-1388 AC7: the per-field "Refresh" endpoint runs the legacy web/LinkedIn
 * LLM path with forceOverwrite. Card revenue is measured by Enigma, so a refresh
 * of one must be refused before that path can overwrite it with a guess.
 */

const mockExecute = jest.fn();
jest.mock('../services/crmEnrichmentService', () => ({
  CrmEnrichmentService: jest.fn().mockImplementation(() => ({ execute: (...a: any[]) => mockExecute(...a) })),
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

const mockGetLeadListById = jest.fn();
const mockGetLeadById = jest.fn();
jest.mock('../services/db', () => ({
  crmDb: {
    getLeadListById: (...a: any[]) => mockGetLeadListById(...a),
    getLeadById: (...a: any[]) => mockGetLeadById(...a),
  },
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


beforeEach(() => {
  jest.clearAllMocks();
  mockUser.userId = 'user-A';
  mockGetLeadListById.mockResolvedValue({ listId: 'l1', userId: 'user-A' });
  mockGetLeadById.mockResolvedValue({ leadId: 'lead1', listId: 'l1' });
  mockExecute.mockResolvedValue({ processed: 1 });
});

describe('POST /api/crm/lists/:listId/leads/:leadId/fields/:field/refresh', () => {
  it.each(['card_revenue_12m', 'card_revenue_period_end', 'card_revenue_yoy_growth'])(
    'refuses to refresh %s through the web/LLM path',
    async (field) => {
      const res = await request(app).post(`/api/crm/lists/l1/leads/lead1/fields/${field}/refresh`).send({});

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/Enigma/);
      expect(mockExecute).not.toHaveBeenCalled();
    },
  );

  it('still refreshes an ordinary field', async () => {
    const res = await request(app).post('/api/crm/lists/l1/leads/lead1/fields/industry/refresh').send({});

    expect(res.status).toBe(200);
    expect(mockExecute).toHaveBeenCalledWith(expect.objectContaining({ outputFields: ['industry'], forceOverwrite: true }));
  });
});
