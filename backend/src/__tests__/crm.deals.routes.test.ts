/**
 * Integration-style tests for the /api/crm/deals routes (A2).
 *
 * The routes delegate to dealDb, so these tests focus on HTTP wiring:
 *   - auth middleware attaches req.user
 *   - response status codes map correctly from thrown errors
 *   - ownership filtering on GET /deals
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
}));

jest.mock('../services/dealDb', () => {
  class DealNotFoundError extends Error {
    constructor(dealId: string) {
      super(`Deal ${dealId} not found`);
      this.name = 'DealNotFoundError';
    }
  }
  class DealAuthError extends Error {
    constructor() {
      super('Not authorized to modify this deal');
      this.name = 'DealAuthError';
    }
  }
  return {
    dealDb: {
      createDeal: jest.fn(),
      getDeal: jest.fn(),
      updateDeal: jest.fn(),
      deleteDeal: jest.fn(),
      getDealsByOwner: jest.fn(),
      getDealsByDomain: jest.fn(),
      rotatePrimary: jest.fn(),
    },
    DealAuthError,
    DealNotFoundError,
    DEAL_STAGES: ['Lead', 'Qualified', 'Demo', 'Proposal', 'Negotiation', 'Won', 'Lost'],
  };
});

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

const mockUser: { userId: string } = { userId: 'user-A' };
jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = mockUser;
    next();
  },
  AuthenticatedRequest: {},
}));

import express from 'express';
import request from 'supertest';
import router from '../routes/crm';
import { dealDb, DealAuthError, DealNotFoundError } from '../services/dealDb';

const app = express();
app.use(express.json());
app.use('/api/crm', router);

const mockDealDb = dealDb as jest.Mocked<typeof dealDb>;

beforeEach(() => {
  jest.clearAllMocks();
  mockUser.userId = 'user-A';
});

describe('POST /api/crm/deals', () => {
  it('401s when user is not authenticated', async () => {
    mockUser.userId = '' as any;
    const res = await request(app).post('/api/crm/deals').send({ primaryContactId: 'c1' });
    expect(res.status).toBe(401);
  });

  it('400s when primaryContactId missing', async () => {
    const res = await request(app).post('/api/crm/deals').send({});
    expect(res.status).toBe(400);
  });

  it('201s on successful creation and forwards ownerUserId from auth', async () => {
    mockDealDb.createDeal.mockResolvedValueOnce({
      dealId: 'd1',
      ownerUserId: 'user-A',
      primaryContactId: 'c1',
      contactIds: ['c1'],
      stage: 'Lead',
      createdAt: 't',
      updatedAt: 't',
    } as any);

    const res = await request(app)
      .post('/api/crm/deals')
      .send({ primaryContactId: 'c1', stage: 'Lead' });

    expect(res.status).toBe(201);
    expect(mockDealDb.createDeal).toHaveBeenCalledWith(
      expect.objectContaining({ ownerUserId: 'user-A', primaryContactId: 'c1' })
    );
  });

  it('maps validation errors to 400', async () => {
    mockDealDb.createDeal.mockRejectedValueOnce(new Error('Invalid deal stage: Nope'));
    const res = await request(app)
      .post('/api/crm/deals')
      .send({ primaryContactId: 'c1', stage: 'Nope' });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/crm/deals/:dealId', () => {
  it('403s when the deal belongs to another user', async () => {
    mockDealDb.getDeal.mockResolvedValueOnce({
      dealId: 'd1',
      ownerUserId: 'someone-else',
      primaryContactId: 'c1',
      contactIds: ['c1'],
      stage: 'Lead',
      createdAt: 't',
      updatedAt: 't',
    } as any);

    const res = await request(app).get('/api/crm/deals/d1');
    expect(res.status).toBe(403);
  });

  it('404s when the deal is missing', async () => {
    mockDealDb.getDeal.mockResolvedValueOnce(null as any);
    const res = await request(app).get('/api/crm/deals/missing');
    expect(res.status).toBe(404);
  });

  it('200s for the owner', async () => {
    mockDealDb.getDeal.mockResolvedValueOnce({
      dealId: 'd1',
      ownerUserId: 'user-A',
      primaryContactId: 'c1',
      contactIds: ['c1'],
      stage: 'Lead',
      createdAt: 't',
      updatedAt: 't',
    } as any);
    const res = await request(app).get('/api/crm/deals/d1');
    expect(res.status).toBe(200);
    expect(res.body.deal.dealId).toBe('d1');
  });
});

describe('GET /api/crm/deals (list)', () => {
  it('filters cross-tenant results when companyDomain is used', async () => {
    mockDealDb.getDealsByDomain.mockResolvedValueOnce([
      { dealId: 'd1', ownerUserId: 'user-A', stage: 'Lead' } as any,
      { dealId: 'd2', ownerUserId: 'someone-else', stage: 'Lead' } as any,
    ]);
    const res = await request(app).get('/api/crm/deals?companyDomain=acme.com');
    expect(res.status).toBe(200);
    expect(res.body.deals).toHaveLength(1);
    expect(res.body.deals[0].dealId).toBe('d1');
  });

  it('400s on unknown stage with domain filter', async () => {
    const res = await request(app).get('/api/crm/deals?companyDomain=acme.com&stage=Bogus');
    expect(res.status).toBe(400);
  });

  it('returns the caller own deals when no filter is supplied', async () => {
    mockDealDb.getDealsByOwner.mockResolvedValueOnce([
      { dealId: 'd1', ownerUserId: 'user-A' } as any,
    ]);
    const res = await request(app).get('/api/crm/deals');
    expect(res.status).toBe(200);
    expect(mockDealDb.getDealsByOwner).toHaveBeenCalledWith('user-A', { limit: 100 });
  });
});

describe('PUT /api/crm/deals/:dealId', () => {
  it('403s when dealDb raises DealAuthError', async () => {
    mockDealDb.updateDeal.mockRejectedValueOnce(new DealAuthError());
    const res = await request(app).put('/api/crm/deals/d1').send({ stage: 'Won' });
    expect(res.status).toBe(403);
  });

  it('404s when dealDb raises DealNotFoundError', async () => {
    mockDealDb.updateDeal.mockRejectedValueOnce(new DealNotFoundError('d1'));
    const res = await request(app).put('/api/crm/deals/d1').send({ stage: 'Won' });
    expect(res.status).toBe(404);
  });
});

describe('POST /api/crm/deals/:dealId/rotate-primary', () => {
  it('400s without newPrimaryContactId', async () => {
    const res = await request(app).post('/api/crm/deals/d1/rotate-primary').send({});
    expect(res.status).toBe(400);
  });

  it('passes contact refs through when provided', async () => {
    mockDealDb.rotatePrimary.mockResolvedValueOnce({
      dealId: 'd1',
      ownerUserId: 'user-A',
      primaryContactId: 'c2',
      contactIds: ['c1', 'c2'],
      stage: 'Lead',
      createdAt: 't',
      updatedAt: 't',
    } as any);

    const res = await request(app).post('/api/crm/deals/d1/rotate-primary').send({
      newPrimaryContactId: 'c2',
      oldPrimaryRef: { listId: 'L1', leadId: 'c1' },
      newPrimaryRef: { listId: 'L1', leadId: 'c2' },
    });

    expect(res.status).toBe(200);
    expect(mockDealDb.rotatePrimary).toHaveBeenCalledWith(
      'd1',
      'user-A',
      'c2',
      expect.objectContaining({
        oldPrimary: { listId: 'L1', leadId: 'c1' },
        newPrimary: { listId: 'L1', leadId: 'c2' },
      })
    );
  });
});

describe('DELETE /api/crm/deals/:dealId', () => {
  it('returns success: true on owner delete', async () => {
    mockDealDb.deleteDeal.mockResolvedValueOnce(undefined as any);
    const res = await request(app).delete('/api/crm/deals/d1');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('403s on auth error', async () => {
    mockDealDb.deleteDeal.mockRejectedValueOnce(new DealAuthError());
    const res = await request(app).delete('/api/crm/deals/d1');
    expect(res.status).toBe(403);
  });
});
