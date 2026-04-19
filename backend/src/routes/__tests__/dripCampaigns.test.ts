/**
 * Route tests for /api/admin/drip-campaigns (Lifecycle Drip Phase 3).
 *
 * We mock the service layer rather than re-testing DynamoDB wiring (that's
 * covered in dripCampaignDb.test.ts). These tests cover request/response
 * shapes, status codes, auth guards, and validation coercion.
 */
import express from 'express';
import request from 'supertest';

// ─── Auth mocks ─────────────────────────────────────────────────────────────
jest.mock('../../middleware/auth', () => ({
  authenticateToken: jest.fn((req: any, _res: any, next: any) => {
    req.user = { userId: 'admin-1', email: 'admin@example.com' };
    next();
  }),
}));

let _isAdminPasses = true;
jest.mock('../../middleware/admin', () => ({
  isAdmin: jest.fn((_req: any, res: any, next: any) => {
    if (_isAdminPasses) return next();
    return res.status(403).json({ message: 'Forbidden' });
  }),
}));

// ─── Service mock ───────────────────────────────────────────────────────────
const mockCreate = jest.fn();
const mockGetById = jest.fn();
const mockListAll = jest.fn();
const mockUpdate = jest.fn();
const mockDeleteById = jest.fn();

jest.mock('../../services/dripCampaignDb', () => {
  const actual = jest.requireActual('../../services/dripCampaignDb');
  return {
    ...actual,
    getDripCampaignDb: jest.fn(() => ({
      create: (...a: any[]) => mockCreate(...a),
      getById: (...a: any[]) => mockGetById(...a),
      listAll: (...a: any[]) => mockListAll(...a),
      update: (...a: any[]) => mockUpdate(...a),
      deleteById: (...a: any[]) => mockDeleteById(...a),
    })),
  };
});

import dripCampaignsRouter from '../dripCampaigns';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/drip-campaigns', dripCampaignsRouter);
  return app;
}

const validBody = {
  name: 'Brand step drop-off',
  subjectLine: 'Emma is waiting — 2 min setup',
  templateHtml: '<p>Hi {{firstName}} at {{companyName}}.</p>',
  cadenceUnit: 'days',
  cadenceValue: 7,
  maxSends: 3,
  isActive: true,
  killSwitch: false,
  segmentQuery: { stage: 'brand_skipped' },
};

const storedCampaign = {
  ...validBody,
  campaignId: 'cmp-1',
  createdBy: 'admin-1',
  createdAt: '2026-04-19T00:00:00Z',
  updatedAt: '2026-04-19T00:00:00Z',
};

beforeEach(() => {
  jest.clearAllMocks();
  _isAdminPasses = true;
});

describe('Auth guards', () => {
  it('returns 403 when isAdmin fails', async () => {
    _isAdminPasses = false;
    const app = makeApp();
    const res = await request(app).get('/api/admin/drip-campaigns');
    expect(res.status).toBe(403);
  });
});

describe('GET /api/admin/drip-campaigns', () => {
  it('returns the full list', async () => {
    mockListAll.mockResolvedValueOnce([storedCampaign]);
    const app = makeApp();
    const res = await request(app).get('/api/admin/drip-campaigns');
    expect(res.status).toBe(200);
    expect(res.body.campaigns).toHaveLength(1);
    expect(res.body.campaigns[0].campaignId).toBe('cmp-1');
  });

  it('returns 500 on underlying error', async () => {
    mockListAll.mockRejectedValueOnce(new Error('boom'));
    const app = makeApp();
    const res = await request(app).get('/api/admin/drip-campaigns');
    expect(res.status).toBe(500);
  });
});

describe('GET /api/admin/drip-campaigns/:id', () => {
  it('returns 200 when found', async () => {
    mockGetById.mockResolvedValueOnce(storedCampaign);
    const app = makeApp();
    const res = await request(app).get('/api/admin/drip-campaigns/cmp-1');
    expect(res.status).toBe(200);
    expect(res.body.campaign.campaignId).toBe('cmp-1');
  });

  it('returns 404 when missing', async () => {
    mockGetById.mockResolvedValueOnce(null);
    const app = makeApp();
    const res = await request(app).get('/api/admin/drip-campaigns/nope');
    expect(res.status).toBe(404);
  });
});

describe('POST /api/admin/drip-campaigns', () => {
  it('creates a campaign and echoes back the result', async () => {
    mockCreate.mockResolvedValueOnce(storedCampaign);
    const app = makeApp();
    const res = await request(app)
      .post('/api/admin/drip-campaigns')
      .send(validBody);
    expect(res.status).toBe(201);
    expect(res.body.campaign.campaignId).toBe('cmp-1');
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Brand step drop-off',
        createdBy: 'admin-1',
      }),
    );
  });

  it('returns 400 when a required field is missing', async () => {
    const app = makeApp();
    const res = await request(app).post('/api/admin/drip-campaigns').send({
      subjectLine: 'no name here',
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/required/);
  });

  it('returns 400 when the service throws a validation error', async () => {
    mockCreate.mockRejectedValueOnce(
      new Error('Invalid merge fields: fake. Allowed: firstName'),
    );
    const app = makeApp();
    const res = await request(app)
      .post('/api/admin/drip-campaigns')
      .send(validBody);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Invalid merge fields/);
  });

  it('returns 500 on unexpected service error', async () => {
    mockCreate.mockRejectedValueOnce(new Error('dynamodb down'));
    const app = makeApp();
    const res = await request(app)
      .post('/api/admin/drip-campaigns')
      .send(validBody);
    expect(res.status).toBe(500);
  });

  it('defaults isActive=true and killSwitch=false when omitted', async () => {
    mockCreate.mockResolvedValueOnce(storedCampaign);
    const { isActive: _ia, killSwitch: _ks, ...noDefaults } = validBody;
    const app = makeApp();
    await request(app).post('/api/admin/drip-campaigns').send(noDefaults);
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ isActive: true, killSwitch: false }),
    );
  });
});

describe('PATCH /api/admin/drip-campaigns/:id', () => {
  it('updates and returns the new campaign', async () => {
    mockUpdate.mockResolvedValueOnce({
      ...storedCampaign,
      killSwitch: true,
      updatedAt: '2026-04-19T01:00:00Z',
    });
    const app = makeApp();
    const res = await request(app)
      .patch('/api/admin/drip-campaigns/cmp-1')
      .send({ killSwitch: true });
    expect(res.status).toBe(200);
    expect(res.body.campaign.killSwitch).toBe(true);
    expect(mockUpdate).toHaveBeenCalledWith(
      'cmp-1',
      expect.objectContaining({ killSwitch: true }),
    );
  });

  it('returns 404 when campaign is missing', async () => {
    mockUpdate.mockRejectedValueOnce(new Error('Campaign not found: cmp-1'));
    const app = makeApp();
    const res = await request(app)
      .patch('/api/admin/drip-campaigns/cmp-1')
      .send({ killSwitch: true });
    expect(res.status).toBe(404);
  });

  it('returns 400 on validation failure from service', async () => {
    mockUpdate.mockRejectedValueOnce(
      new Error('cadenceValue must be a positive integer'),
    );
    const app = makeApp();
    const res = await request(app)
      .patch('/api/admin/drip-campaigns/cmp-1')
      .send({ cadenceValue: -5 });
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/admin/drip-campaigns/:id', () => {
  it('returns 204 on success', async () => {
    mockDeleteById.mockResolvedValueOnce(undefined);
    const app = makeApp();
    const res = await request(app).delete('/api/admin/drip-campaigns/cmp-1');
    expect(res.status).toBe(204);
    expect(mockDeleteById).toHaveBeenCalledWith('cmp-1');
  });

  it('returns 500 on service error', async () => {
    mockDeleteById.mockRejectedValueOnce(new Error('boom'));
    const app = makeApp();
    const res = await request(app).delete('/api/admin/drip-campaigns/cmp-1');
    expect(res.status).toBe(500);
  });
});

describe('POST /api/admin/drip-campaigns/:id/preview', () => {
  it('renders the template with sample user values', async () => {
    mockGetById.mockResolvedValueOnce(storedCampaign);
    const app = makeApp();
    const res = await request(app)
      .post('/api/admin/drip-campaigns/cmp-1/preview')
      .send({ sampleUser: { firstName: 'Rui', companyName: 'AgentWeb' } });

    expect(res.status).toBe(200);
    expect(res.body.renderedHtml).toBe('<p>Hi Rui at AgentWeb.</p>');
    expect(res.body.mergeFieldsUsed.sort()).toEqual(
      ['firstName', 'companyName'].sort(),
    );
    expect(res.body.allowedMergeFields).toContain('firstName');
  });

  it('falls back to default sample values if sampleUser omitted', async () => {
    mockGetById.mockResolvedValueOnce(storedCampaign);
    const app = makeApp();
    const res = await request(app)
      .post('/api/admin/drip-campaigns/cmp-1/preview')
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.renderedHtml).toBe('<p>Hi Alex at Acme Co.</p>');
  });

  it('returns 404 if campaign not found', async () => {
    mockGetById.mockResolvedValueOnce(null);
    const app = makeApp();
    const res = await request(app)
      .post('/api/admin/drip-campaigns/missing/preview')
      .send({});
    expect(res.status).toBe(404);
  });
});
