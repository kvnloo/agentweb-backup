process.env.JWT_SECRET = 'test-secret';

jest.mock('axios');
jest.mock('../services/connectedAccountsDb', () => ({
  getAccountsByUserId: jest.fn(),
  getAccountById: jest.fn(),
  updateAccountTokens: jest.fn(),
}));
jest.mock('../config/integrations', () => ({
  getHubSpotConfig: jest.fn().mockResolvedValue({
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    tokenUrl: 'https://api.hubapi.com/oauth/v1/token',
    redirectUri: 'http://localhost:3001/api/oauth/hubspot/callback',
    scopes: ['marketing.campaigns.read', 'marketing.campaigns.write'],
    authorizationUrl: 'https://app.hubspot.com/oauth/authorize',
    tokenInfoUrl: 'https://api.hubapi.com/oauth/v1/access-tokens',
  }),
}));

import axios from 'axios';
import { HubSpotService } from '../services/hubspotService';

const mockAxiosGet = axios.get as jest.Mock;
const mockAxiosPost = axios.post as jest.Mock;
const mockAxiosPatch = axios.patch as jest.Mock;
const mockAxiosDelete = axios.delete as jest.Mock;
const mockAxiosRequest = axios.request as jest.Mock;

const MOCK_RAW_CAMPAIGN = {
  id: 'campaign-guid-1',
  properties: {
    hs_name: 'Q1 Email Campaign',
    hs_start_date: '2025-10-30',
    hs_notes: 'Test notes',
    hs_utm: 'utm_test',
    hs_created_at: '2025-10-01T00:00:00Z',
    hs_updated_at: '2025-10-02T00:00:00Z',
  },
};

const MOCK_METRICS_RESPONSE = {
  id: 'campaign-guid-1',
  metrics: {
    sessions: 100,
    contacts: 50,
    revenue: 5000,
  },
};

// ─── listCampaigns ────────────────────────────────────────────────────────────

describe('HubSpotService — listCampaigns', () => {
  let svc: HubSpotService;
  beforeEach(() => {
    svc = HubSpotService.fromToken('valid-token');
    jest.clearAllMocks();
  });

  it('returns raw HubSpot response', async () => {
    const rawResponse = { results: [MOCK_RAW_CAMPAIGN], paging: { next: { after: 'cursor-200' } } };
    mockAxiosGet.mockResolvedValue({ data: rawResponse });

    const result = await svc.listCampaigns();

    expect(mockAxiosGet).toHaveBeenCalledWith(
      expect.stringContaining('marketing/v3/campaigns'),
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer valid-token' }) })
    );
    expect(result).toEqual(rawResponse);
  });

  it('passes cursor for pagination', async () => {
    mockAxiosGet.mockResolvedValue({ data: { results: [] } });
    await svc.listCampaigns('some-cursor');
    expect(mockAxiosGet).toHaveBeenCalledWith(
      expect.stringContaining('after=some-cursor'),
      expect.any(Object)
    );
  });

  it('returns raw response when no campaigns', async () => {
    mockAxiosGet.mockResolvedValue({ data: { results: [] } });
    const result = await svc.listCampaigns();
    expect(result.results).toHaveLength(0);
  });

  it('surfaces 403 error when HubSpot tier does not support campaigns', async () => {
    const err: any = new Error('Forbidden');
    err.response = { status: 403, data: { message: 'This feature requires Marketing Hub Professional.' } };
    mockAxiosGet.mockRejectedValue(err);

    await expect(svc.listCampaigns()).rejects.toMatchObject({
      response: { status: 403 },
    });
  });
});

// ─── getCampaign ──────────────────────────────────────────────────────────────

describe('HubSpotService — getCampaign', () => {
  let svc: HubSpotService;
  beforeEach(() => {
    svc = HubSpotService.fromToken('valid-token');
    jest.clearAllMocks();
  });

  it('returns raw campaign object from HubSpot', async () => {
    mockAxiosGet.mockResolvedValue({ data: MOCK_RAW_CAMPAIGN });

    const result = await svc.getCampaign('campaign-guid-1');

    expect(mockAxiosGet).toHaveBeenCalledWith(
      expect.stringContaining('marketing/v3/campaigns/campaign-guid-1'),
      expect.any(Object)
    );
    expect(result).toEqual(MOCK_RAW_CAMPAIGN);
  });

  it('propagates 404 when campaign does not exist', async () => {
    const err: any = new Error('Not Found');
    err.response = { status: 404, data: { message: 'Campaign not found' } };
    mockAxiosGet.mockRejectedValue(err);

    await expect(svc.getCampaign('nonexistent-guid')).rejects.toMatchObject({
      response: { status: 404 },
    });
  });

  it('throws if guid is empty', async () => {
    await expect(svc.getCampaign('')).rejects.toThrow(/guid/i);
  });
});

// ─── createCampaign ───────────────────────────────────────────────────────────

describe('HubSpotService — createCampaign', () => {
  let svc: HubSpotService;
  beforeEach(() => {
    svc = HubSpotService.fromToken('valid-token');
    jest.clearAllMocks();
  });

  it('posts to HubSpot and returns raw response', async () => {
    mockAxiosPost.mockResolvedValue({ data: MOCK_RAW_CAMPAIGN });

    const result = await svc.createCampaign('Q1 Email Campaign', {
      startDate: '2025-10-30',
      notes: 'Test notes',
      utm: 'utm_test',
    });

    expect(mockAxiosPost).toHaveBeenCalledWith(
      expect.stringContaining('marketing/v3/campaigns'),
      expect.objectContaining({
        properties: expect.objectContaining({ hs_name: 'Q1 Email Campaign' }),
      }),
      expect.any(Object)
    );
    expect(result).toEqual(MOCK_RAW_CAMPAIGN);
  });

  it('throws when name is empty string', async () => {
    await expect(svc.createCampaign('')).rejects.toThrow(/name/i);
  });

  it('throws when name is whitespace only', async () => {
    await expect(svc.createCampaign('   ')).rejects.toThrow(/name/i);
  });

  it('creates campaign with name only (no optional fields)', async () => {
    const minimal = { id: 'campaign-guid-2', properties: { hs_name: 'Minimal Campaign' } };
    mockAxiosPost.mockResolvedValue({ data: minimal });

    const result = await svc.createCampaign('Minimal Campaign');

    expect(result).toEqual(minimal);
    expect(mockAxiosPost).toHaveBeenCalledWith(
      expect.stringContaining('marketing/v3/campaigns'),
      expect.objectContaining({
        properties: expect.objectContaining({ hs_name: 'Minimal Campaign' }),
      }),
      expect.any(Object)
    );
  });

  it('surfaces API error on create failure', async () => {
    const err: any = new Error('Bad Request');
    err.response = { status: 400, data: { message: 'Invalid property value' } };
    mockAxiosPost.mockRejectedValue(err);

    await expect(svc.createCampaign('Bad Campaign')).rejects.toMatchObject({
      response: { status: 400 },
    });
  });
});

// ─── updateCampaign ───────────────────────────────────────────────────────────

describe('HubSpotService — updateCampaign', () => {
  let svc: HubSpotService;
  beforeEach(() => {
    svc = HubSpotService.fromToken('valid-token');
    jest.clearAllMocks();
  });

  it('patches campaign and returns raw response', async () => {
    const updated = {
      ...MOCK_RAW_CAMPAIGN,
      properties: { ...MOCK_RAW_CAMPAIGN.properties, hs_name: 'Updated Name' },
    };
    mockAxiosPatch.mockResolvedValue({ data: updated });

    const result = await svc.updateCampaign('campaign-guid-1', { name: 'Updated Name' });

    expect(mockAxiosPatch).toHaveBeenCalledWith(
      expect.stringContaining('marketing/v3/campaigns/campaign-guid-1'),
      expect.objectContaining({
        properties: expect.objectContaining({ hs_name: 'Updated Name' }),
      }),
      expect.any(Object)
    );
    expect(result).toEqual(updated);
  });
});

// ─── deleteCampaign ───────────────────────────────────────────────────────────

describe('HubSpotService — deleteCampaign', () => {
  let svc: HubSpotService;
  beforeEach(() => {
    svc = HubSpotService.fromToken('valid-token');
    jest.clearAllMocks();
  });

  it('calls DELETE endpoint with campaign guid', async () => {
    mockAxiosDelete.mockResolvedValue({ status: 204, data: null });

    await svc.deleteCampaign('campaign-guid-1');

    const url = mockAxiosDelete.mock.calls[0][0];
    expect(url).toContain('marketing/v3/campaigns/campaign-guid-1');
  });

  it('throws if guid is empty', async () => {
    await expect(svc.deleteCampaign('')).rejects.toThrow(/guid/i);
  });
});

// ─── getCampaignMetrics ───────────────────────────────────────────────────────

describe('HubSpotService — getCampaignMetrics', () => {
  let svc: HubSpotService;
  beforeEach(() => {
    svc = HubSpotService.fromToken('valid-token');
    jest.clearAllMocks();
  });

  it('returns raw metrics response', async () => {
    mockAxiosGet.mockResolvedValue({ data: MOCK_METRICS_RESPONSE });

    const result = await svc.getCampaignMetrics('campaign-guid-1');

    expect(mockAxiosGet).toHaveBeenCalledWith(
      expect.stringContaining('marketing/v3/campaigns/campaign-guid-1/reports/metrics'),
      expect.any(Object)
    );
    expect(result).toEqual(MOCK_METRICS_RESPONSE);
  });

  it('propagates 404 when campaign metrics not found', async () => {
    const err: any = new Error('Not Found');
    err.response = { status: 404, data: { message: 'Campaign not found' } };
    mockAxiosGet.mockRejectedValue(err);

    await expect(svc.getCampaignMetrics('bad-guid')).rejects.toMatchObject({
      response: { status: 404 },
    });
  });
});

// ─── listCampaignAssets ───────────────────────────────────────────────────────

describe('HubSpotService — listCampaignAssets', () => {
  let svc: HubSpotService;
  beforeEach(() => {
    svc = HubSpotService.fromToken('valid-token');
    jest.clearAllMocks();
  });

  it('fetches single asset type and returns raw response', async () => {
    const raw = { results: [{ id: 'email-1', type: 'MARKETING_EMAIL', metrics: { clicks: 10 } }] };
    mockAxiosGet.mockResolvedValue({ data: raw });

    const result = await svc.listCampaignAssets('campaign-guid-1', 'MARKETING_EMAIL');

    expect(mockAxiosGet).toHaveBeenCalledWith(
      expect.stringContaining('marketing/campaigns/2026-03/campaign-guid-1/assets/MARKETING_EMAIL'),
      expect.any(Object)
    );
    expect(result).toEqual(raw);
  });

  it('appends startDate and endDate to URL', async () => {
    mockAxiosGet.mockResolvedValue({ data: { results: [] } });

    await svc.listCampaignAssets('campaign-guid-1', 'FORM', {
      startDate: '2025-01-01',
      endDate: '2025-06-30',
    });

    const calledUrl: string = mockAxiosGet.mock.calls[0][0];
    expect(calledUrl).toContain('startDate=2025-01-01');
    expect(calledUrl).toContain('endDate=2025-06-30');
  });

  it('appends cursor as after param', async () => {
    mockAxiosGet.mockResolvedValue({ data: { results: [] } });
    await svc.listCampaignAssets('campaign-guid-1', 'MARKETING_EMAIL', { cursor: 'tok123' });
    expect(mockAxiosGet).toHaveBeenCalledWith(
      expect.stringContaining('after=tok123'),
      expect.any(Object)
    );
  });

  it('fans out across all asset types when none specified', async () => {
    mockAxiosGet.mockResolvedValue({ data: { results: [] } });

    const result = await svc.listCampaignAssets('campaign-guid-1');

    // Should have called for each known type
    expect(mockAxiosGet.mock.calls.length).toBeGreaterThanOrEqual(
      HubSpotService.CAMPAIGN_ASSET_TYPES.length
    );
    expect(result).toHaveProperty('byType');
    HubSpotService.CAMPAIGN_ASSET_TYPES.forEach(t => {
      expect(result.byType).toHaveProperty(t);
    });
  });

  it('partial success: failed type recorded as error, others succeed', async () => {
    const err: any = new Error('Forbidden');
    err.response = { status: 403 };
    mockAxiosGet
      .mockRejectedValueOnce(err) // first type fails
      .mockResolvedValue({ data: { results: [] } }); // rest succeed

    const result = await svc.listCampaignAssets('campaign-guid-1');

    expect(result.byType).toBeDefined();
    const firstType = HubSpotService.CAMPAIGN_ASSET_TYPES[0];
    expect(result.byType[firstType]).toHaveProperty('error');
  });
});
