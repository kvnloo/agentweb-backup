/**
 * Tests for /api/hubspot/campaigns REST routes.
 * Mocks HubSpotService — verifies routing, auth guard, validation, error propagation.
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('../../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: 'user-1', email: 'u@test.com', isAdmin: false };
    next();
  },
  requireAdmin: (_req: any, _res: any, next: any) => next(),
  isAdmin: (_req: any, _res: any, next: any) => next(),
  isRealAdmin: () => false,
}));

// ── AWS mock (required by app.ts) ─────────────────────────────────────────────

const mockDynamo = () => ({
  put: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
  get: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
  query: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({ Items: [] }) }),
  scan: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({ Items: [] }) }),
  update: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
  delete: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
  batchWrite: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
});
const mockS3 = () => ({
  upload: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
  getObject: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
  putObject: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
  deleteObject: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
  getSignedUrl: jest.fn().mockReturnValue('https://mock-url'),
  headObject: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
  listObjectsV2: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({ Contents: [] }) }),
});
jest.mock('aws-sdk', () => {
  const awsMock = {
    config: { update: jest.fn() },
    DynamoDB: { DocumentClient: jest.fn(mockDynamo) },
    S3: jest.fn(mockS3),
    EC2: jest.fn(() => ({ describeInstances: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }) })),
    SSM: jest.fn(() => ({ sendCommand: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }) })),
    IAM: jest.fn(() => ({ getInstanceProfile: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }) })),
    SecretsManager: jest.fn(() => ({ getSecretValue: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({ SecretString: '{}' }) }) })),
    SES: jest.fn(() => ({})),
  };
  return { __esModule: true, default: awsMock, ...awsMock };
});

// ── HubSpotService mock ───────────────────────────────────────────────────────

const mockListCampaigns = jest.fn();
const mockGetCampaign = jest.fn();
const mockCreateCampaign = jest.fn();
const mockUpdateCampaign = jest.fn();
const mockDeleteCampaign = jest.fn();
const mockGetCampaignMetrics = jest.fn();

const mockSvc = {
  listCampaigns: mockListCampaigns,
  getCampaign: mockGetCampaign,
  createCampaign: mockCreateCampaign,
  updateCampaign: mockUpdateCampaign,
  deleteCampaign: mockDeleteCampaign,
  getCampaignMetrics: mockGetCampaignMetrics,
};

jest.mock('../../services/hubspotService', () => ({
  HubSpotService: {
    create: jest.fn().mockResolvedValue(mockSvc),
    fromToken: jest.fn().mockReturnValue(mockSvc),
  },
}));

import request from 'supertest';
import app from '../../app';
const AUTH = 'Bearer test-token';
const GUID = 'campaign-guid-1';
const RAW_LIST = { results: [{ id: GUID, properties: { hs_name: 'Camp1' } }] };
const RAW_CAMPAIGN = { id: GUID, properties: { hs_name: 'Camp1' } };
const RAW_METRICS = { id: GUID, metrics: { sessions: 100 } };

beforeEach(() => jest.clearAllMocks());

// ─── GET / — list ─────────────────────────────────────────────────────────────

describe('GET /api/hubspot/campaigns', () => {
  it('returns campaign list', async () => {
    mockListCampaigns.mockResolvedValue(RAW_LIST);
    const res = await request(app).get('/api/hubspot/campaigns').set('Authorization', AUTH);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(RAW_LIST);
  });

  it('passes cursor query param', async () => {
    mockListCampaigns.mockResolvedValue(RAW_LIST);
    await request(app).get('/api/hubspot/campaigns?cursor=abc').set('Authorization', AUTH);
    expect(mockListCampaigns).toHaveBeenCalledWith('abc');
  });

  it('returns HubSpot status on API error', async () => {
    const err: any = new Error('Forbidden'); err.response = { status: 403, data: { message: 'Pro required' } };
    mockListCampaigns.mockRejectedValue(err);
    const res = await request(app).get('/api/hubspot/campaigns').set('Authorization', AUTH);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/pro required/i);
  });
});

// ─── POST / — create ──────────────────────────────────────────────────────────

describe('POST /api/hubspot/campaigns', () => {
  it('returns 400 when name missing', async () => {
    const res = await request(app).post('/api/hubspot/campaigns').set('Authorization', AUTH).send({});
    expect(res.status).toBe(400);
    expect(mockCreateCampaign).not.toHaveBeenCalled();
  });

  it('returns 400 when name is blank', async () => {
    const res = await request(app).post('/api/hubspot/campaigns').set('Authorization', AUTH).send({ name: '   ' });
    expect(res.status).toBe(400);
  });

  it('creates campaign and returns 201', async () => {
    mockCreateCampaign.mockResolvedValue(RAW_CAMPAIGN);
    const res = await request(app).post('/api/hubspot/campaigns')      .send({ name: 'Camp1', startDate: '2025-01-01', notes: 'n', utm: 'u' });
    expect(res.status).toBe(201);
    expect(res.body).toEqual(RAW_CAMPAIGN);
    expect(mockCreateCampaign).toHaveBeenCalledWith('Camp1', { startDate: '2025-01-01', notes: 'n', utm: 'u' });
  });
});

// ─── GET /:guid ───────────────────────────────────────────────────────────────

describe('GET /api/hubspot/campaigns/:guid', () => {
  it('returns campaign', async () => {
    mockGetCampaign.mockResolvedValue(RAW_CAMPAIGN);
    const res = await request(app).get(`/api/hubspot/campaigns/${GUID}`).set('Authorization', AUTH);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(RAW_CAMPAIGN);
    expect(mockGetCampaign).toHaveBeenCalledWith(GUID);
  });

  it('returns 404 on missing campaign', async () => {
    const err: any = new Error('Not Found'); err.response = { status: 404, data: { message: 'Not found' } };
    mockGetCampaign.mockRejectedValue(err);
    const res = await request(app).get(`/api/hubspot/campaigns/${GUID}`).set('Authorization', AUTH);
    expect(res.status).toBe(404);
  });
});

// ─── PATCH /:guid ─────────────────────────────────────────────────────────────

describe('PATCH /api/hubspot/campaigns/:guid', () => {
  it('updates campaign and returns result', async () => {
    mockUpdateCampaign.mockResolvedValue(RAW_CAMPAIGN);
    const res = await request(app).patch(`/api/hubspot/campaigns/${GUID}`)
      .set('Authorization', AUTH).send({ name: 'New Name' });
    expect(res.status).toBe(200);
    expect(mockUpdateCampaign).toHaveBeenCalledWith(GUID, { name: 'New Name' });
  });
});

// ─── DELETE /:guid ────────────────────────────────────────────────────────────

describe('DELETE /api/hubspot/campaigns/:guid', () => {
  it('deletes campaign and returns 204', async () => {
    mockDeleteCampaign.mockResolvedValue(undefined);
    const res = await request(app).delete(`/api/hubspot/campaigns/${GUID}`).set('Authorization', AUTH);
    expect(res.status).toBe(204);
    expect(mockDeleteCampaign).toHaveBeenCalledWith(GUID);
  });
});

// ─── GET /:guid/metrics ───────────────────────────────────────────────────────

describe('GET /api/hubspot/campaigns/:guid/metrics', () => {
  it('returns metrics', async () => {
    mockGetCampaignMetrics.mockResolvedValue(RAW_METRICS);
    const res = await request(app).get(`/api/hubspot/campaigns/${GUID}/metrics`).set('Authorization', AUTH);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(RAW_METRICS);
    expect(mockGetCampaignMetrics).toHaveBeenCalledWith(GUID);
  });
});
