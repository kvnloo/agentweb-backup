/**
 * Route tests for /api/drip-campaigns (Phase A: customer-scoped).
 *
 * Phase A removes the admin gate — every authenticated user can manage
 * their own drip campaigns. We mock the service layer rather than re-testing
 * DynamoDB wiring. These tests cover request/response shapes, status codes,
 * auth, validation coercion, and cross-tenant isolation (reads/updates/
 * deletes for a campaign owned by another user return 404).
 */
import express from 'express';
import request from 'supertest';

// ─── Auth mock ──────────────────────────────────────────────────────────────
// We drive `authenticateToken` with a mutable userId so the same test file
// can exercise "owner" and "other tenant" pathways without spinning up a
// real JWT signer.
let _currentUserId = 'user-alice';
jest.mock('../../middleware/auth', () => ({
  authenticateToken: jest.fn((req: any, _res: any, next: any) => {
    req.user = { userId: _currentUserId, email: `${_currentUserId}@example.com` };
    next();
  }),
}));

// ─── dripExecutor mock — isolates the segment-preview endpoint from the
//     cron file so this test stays a pure route test. ─────────────────────
const mockDefaultListLeadsForCampaign = jest.fn();
jest.mock('../../cron/dripExecutor', () => ({
  defaultListLeadsForCampaign: (...a: any[]) =>
    mockDefaultListLeadsForCampaign(...a),
}));

// ─── Service mock ───────────────────────────────────────────────────────────
const mockCreate = jest.fn();
const mockGetById = jest.fn();
const mockListByUserId = jest.fn();
const mockUpdate = jest.fn();
const mockDeleteById = jest.fn();

jest.mock('../../services/dripCampaignDb', () => {
  const actual = jest.requireActual('../../services/dripCampaignDb');
  return {
    ...actual,
    getDripCampaignDb: jest.fn(() => ({
      create: (...a: any[]) => mockCreate(...a),
      getById: (...a: any[]) => mockGetById(...a),
      listByUserId: (...a: any[]) => mockListByUserId(...a),
      update: (...a: any[]) => mockUpdate(...a),
      deleteById: (...a: any[]) => mockDeleteById(...a),
    })),
  };
});

import dripCampaignsRouter from '../dripCampaigns';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/drip-campaigns', dripCampaignsRouter);
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
  userId: 'user-alice',
  createdBy: 'user-alice',
  createdAt: '2026-04-19T00:00:00Z',
  updatedAt: '2026-04-19T00:00:00Z',
};

beforeEach(() => {
  jest.clearAllMocks();
  _currentUserId = 'user-alice';
});

describe('GET /api/drip-campaigns', () => {
  it('returns the caller-scoped list', async () => {
    mockListByUserId.mockResolvedValueOnce([storedCampaign]);
    const app = makeApp();
    const res = await request(app).get('/api/drip-campaigns');
    expect(res.status).toBe(200);
    expect(res.body.campaigns).toHaveLength(1);
    expect(res.body.campaigns[0].campaignId).toBe('cmp-1');
    expect(mockListByUserId).toHaveBeenCalledWith('user-alice');
  });

  it('returns 500 on underlying error', async () => {
    mockListByUserId.mockRejectedValueOnce(new Error('boom'));
    const app = makeApp();
    const res = await request(app).get('/api/drip-campaigns');
    expect(res.status).toBe(500);
  });
});

describe('GET /api/drip-campaigns/:id', () => {
  it('returns 200 when caller owns the campaign', async () => {
    mockGetById.mockResolvedValueOnce(storedCampaign);
    const app = makeApp();
    const res = await request(app).get('/api/drip-campaigns/cmp-1');
    expect(res.status).toBe(200);
    expect(res.body.campaign.campaignId).toBe('cmp-1');
    expect(mockGetById).toHaveBeenCalledWith('cmp-1', 'user-alice');
  });

  it('returns 404 when the campaign does not exist', async () => {
    mockGetById.mockResolvedValueOnce(null);
    const app = makeApp();
    const res = await request(app).get('/api/drip-campaigns/nope');
    expect(res.status).toBe(404);
  });

  it('returns 404 when another tenant asks for it (cross-tenant read)', async () => {
    // DB layer returns null for cross-tenant — route should surface 404.
    _currentUserId = 'user-bob';
    mockGetById.mockResolvedValueOnce(null);
    const app = makeApp();
    const res = await request(app).get('/api/drip-campaigns/cmp-1');
    expect(res.status).toBe(404);
    expect(mockGetById).toHaveBeenCalledWith('cmp-1', 'user-bob');
  });
});

describe('POST /api/drip-campaigns', () => {
  it('creates a campaign scoped to the caller', async () => {
    mockCreate.mockResolvedValueOnce(storedCampaign);
    const app = makeApp();
    const res = await request(app)
      .post('/api/drip-campaigns')
      .send(validBody);
    expect(res.status).toBe(201);
    expect(res.body.campaign.campaignId).toBe('cmp-1');
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Brand step drop-off',
        userId: 'user-alice',
        createdBy: 'user-alice',
      }),
    );
  });

  it('returns 400 when a required field is missing', async () => {
    const app = makeApp();
    const res = await request(app).post('/api/drip-campaigns').send({
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
    const res = await request(app).post('/api/drip-campaigns').send(validBody);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Invalid merge fields/);
  });

  it('returns 500 on unexpected service error', async () => {
    mockCreate.mockRejectedValueOnce(new Error('dynamodb down'));
    const app = makeApp();
    const res = await request(app).post('/api/drip-campaigns').send(validBody);
    expect(res.status).toBe(500);
  });

  it('defaults isActive=true and killSwitch=false when omitted', async () => {
    mockCreate.mockResolvedValueOnce(storedCampaign);
    const { isActive: _ia, killSwitch: _ks, ...noDefaults } = validBody;
    const app = makeApp();
    await request(app).post('/api/drip-campaigns').send(noDefaults);
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ isActive: true, killSwitch: false }),
    );
  });

  it('accepts CRM-flavoured segmentQuery fields (lifecycle, heatScore, utmSource, leadListId)', async () => {
    mockCreate.mockResolvedValueOnce(storedCampaign);
    const app = makeApp();
    await request(app)
      .post('/api/drip-campaigns')
      .send({
        ...validBody,
        segmentQuery: {
          lifecycle: 'trialing',
          minHeatScore: 60,
          utmSource: 'linkedin',
          leadListId: 'list-abc',
        },
      });
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        segmentQuery: {
          lifecycle: 'trialing',
          minHeatScore: 60,
          utmSource: 'linkedin',
          leadListId: 'list-abc',
        },
      }),
    );
  });
});

describe('PATCH /api/drip-campaigns/:id', () => {
  it('updates and returns the new campaign', async () => {
    mockUpdate.mockResolvedValueOnce({
      ...storedCampaign,
      killSwitch: true,
      updatedAt: '2026-04-19T01:00:00Z',
    });
    const app = makeApp();
    const res = await request(app)
      .patch('/api/drip-campaigns/cmp-1')
      .send({ killSwitch: true });
    expect(res.status).toBe(200);
    expect(res.body.campaign.killSwitch).toBe(true);
    expect(mockUpdate).toHaveBeenCalledWith(
      'cmp-1',
      'user-alice',
      expect.objectContaining({ killSwitch: true }),
    );
  });

  it('returns 404 when campaign is missing OR owned by someone else', async () => {
    mockUpdate.mockRejectedValueOnce(new Error('Campaign not found: cmp-1'));
    const app = makeApp();
    const res = await request(app)
      .patch('/api/drip-campaigns/cmp-1')
      .send({ killSwitch: true });
    expect(res.status).toBe(404);
  });

  it('returns 400 on validation failure from service', async () => {
    mockUpdate.mockRejectedValueOnce(
      new Error('cadenceValue must be a positive integer'),
    );
    const app = makeApp();
    const res = await request(app)
      .patch('/api/drip-campaigns/cmp-1')
      .send({ cadenceValue: -5 });
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/drip-campaigns/:id', () => {
  it('returns 204 on success', async () => {
    mockDeleteById.mockResolvedValueOnce(undefined);
    const app = makeApp();
    const res = await request(app).delete('/api/drip-campaigns/cmp-1');
    expect(res.status).toBe(204);
    expect(mockDeleteById).toHaveBeenCalledWith('cmp-1', 'user-alice');
  });

  it('returns 404 when trying to delete someone else\'s campaign', async () => {
    mockDeleteById.mockRejectedValueOnce(
      new Error('Campaign not found: cmp-1'),
    );
    const app = makeApp();
    const res = await request(app).delete('/api/drip-campaigns/cmp-1');
    expect(res.status).toBe(404);
  });

  it('returns 500 on unexpected service error', async () => {
    mockDeleteById.mockRejectedValueOnce(new Error('boom'));
    const app = makeApp();
    const res = await request(app).delete('/api/drip-campaigns/cmp-1');
    expect(res.status).toBe(500);
  });
});

describe('POST /api/drip-campaigns/preview-segment', () => {
  const leadFixture = {
    listId: 'list-A',
    leadId: 'lead-1',
    userId: 'user-alice',
    email: 'a@a.test',
    firstName: 'Alice',
    lastName: 'Smith',
    company: 'Acme',
    lifecycle: 'trialing',
    heatScore: 72,
    utmSource: 'linkedin',
    contactStatus: 'active',
  };

  it('returns matching leads scoped to the caller', async () => {
    mockDefaultListLeadsForCampaign.mockResolvedValueOnce([leadFixture]);
    const app = makeApp();
    const res = await request(app)
      .post('/api/drip-campaigns/preview-segment')
      .send({ lifecycle: 'trialing', minHeatScore: 50 });

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.sampleSize).toBe(1);
    expect(res.body.leads).toHaveLength(1);
    expect(res.body.leads[0].email).toBe('a@a.test');
    expect(res.body.criteria).toEqual({
      lifecycle: 'trialing',
      minHeatScore: 50,
    });

    // Verify it synthesised a campaign scoped to the CURRENT user, not
    // a different tenant.
    const passedCampaign = mockDefaultListLeadsForCampaign.mock.calls[0][0];
    expect(passedCampaign.userId).toBe('user-alice');
    expect(passedCampaign.segmentQuery.lifecycle).toBe('trialing');
  });

  it('caps limit at 100 and floors at 1', async () => {
    const many = Array.from({ length: 500 }, (_, i) => ({
      ...leadFixture,
      leadId: `lead-${i}`,
    }));
    mockDefaultListLeadsForCampaign.mockResolvedValueOnce(many);
    const app = makeApp();
    const res = await request(app)
      .post('/api/drip-campaigns/preview-segment')
      .send({ lifecycle: 'trialing', limit: 9999 });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(500);
    expect(res.body.sampleSize).toBe(100);
    expect(res.body.leads).toHaveLength(100);
  });

  it('returns 500 on service error', async () => {
    mockDefaultListLeadsForCampaign.mockRejectedValueOnce(
      new Error('dynamodb down'),
    );
    const app = makeApp();
    const res = await request(app)
      .post('/api/drip-campaigns/preview-segment')
      .send({ lifecycle: 'trialing' });
    expect(res.status).toBe(500);
  });
});

describe('POST /api/drip-campaigns/:id/preview', () => {
  it('renders the template with sample user values (caller owns campaign)', async () => {
    mockGetById.mockResolvedValueOnce(storedCampaign);
    const app = makeApp();
    const res = await request(app)
      .post('/api/drip-campaigns/cmp-1/preview')
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
      .post('/api/drip-campaigns/cmp-1/preview')
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.renderedHtml).toBe('<p>Hi Alex at Acme Co.</p>');
  });

  it('returns 404 if campaign not found OR caller does not own it', async () => {
    mockGetById.mockResolvedValueOnce(null);
    const app = makeApp();
    const res = await request(app)
      .post('/api/drip-campaigns/missing/preview')
      .send({});
    expect(res.status).toBe(404);
  });
});
