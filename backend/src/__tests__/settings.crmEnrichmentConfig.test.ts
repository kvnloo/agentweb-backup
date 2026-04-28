import request from 'supertest';
import express from 'express';
import settingsRoutes from '../routes/settings';
import { settingsService } from '../services/settingsService';

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: 'admin-1', email: 'admin@example.com', isAdmin: true };
    next();
  },
  requireAdmin: (_req: any, _res: any, next: any) => next(),
}));

jest.mock('../services/settingsService', () => ({
  settingsService: {
    getSetting: jest.fn(),
    setSetting: jest.fn(),
  },
}));

jest.mock('../services/db', () => ({ userDb: {} }));
jest.mock('../services/linkedInOutreachService', () => ({
  linkedInOutreachService: { checkAccountConnectivity: jest.fn() },
}));
jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    getSupportedModels: jest.fn().mockResolvedValue([
      'gemini-3-flash-preview',
      'gemini-3-pro-preview',
      'gpt-5-chat-2',
      'anthropic.claude-sonnet-4-6',
    ]),
  },
}));

const mockSettingsService = settingsService as jest.Mocked<typeof settingsService>;

const app = express();
app.use(express.json());
app.use('/api/settings', settingsRoutes);

const CRM_ENRICHMENT_KEY = 'crm-enrichment-config';
const DEFAULTS = {
  enrichmentModel: 'gemini-3-flash-preview',
  dataExtractionModel: 'gemini-3-flash-preview',
};

describe('GET /api/settings/crm-enrichment-config', () => {
  afterEach(() => jest.clearAllMocks());

  it('returns defaults when no setting is stored', async () => {
    mockSettingsService.getSetting.mockResolvedValue(null);
    const res = await request(app).get('/api/settings/crm-enrichment-config');
    expect(res.status).toBe(200);
    expect(res.body.config).toMatchObject(DEFAULTS);
    expect(Array.isArray(res.body.availableModels)).toBe(true);
    expect(res.body.availableModels.length).toBeGreaterThan(0);
  });

  it('returns persisted config when setting exists', async () => {
    const stored = {
      enrichmentModel: 'gemini-3-pro-preview',
      dataExtractionModel: 'gpt-5-chat-2',
    };
    mockSettingsService.getSetting.mockResolvedValue({
      settingName: CRM_ENRICHMENT_KEY,
      settingValue: JSON.stringify(stored),
      description: '',
      updatedBy: 'admin@example.com',
      updatedAt: new Date().toISOString(),
    });
    const res = await request(app).get('/api/settings/crm-enrichment-config');
    expect(res.status).toBe(200);
    expect(res.body.config).toMatchObject(stored);
  });

  it('falls back to defaults when stored JSON is malformed', async () => {
    mockSettingsService.getSetting.mockResolvedValue({
      settingName: CRM_ENRICHMENT_KEY,
      settingValue: 'not-json',
      description: '',
      updatedBy: 'system',
      updatedAt: new Date().toISOString(),
    });
    const res = await request(app).get('/api/settings/crm-enrichment-config');
    expect(res.status).toBe(200);
    expect(res.body.config).toMatchObject(DEFAULTS);
  });
});

describe('PUT /api/settings/crm-enrichment-config', () => {
  afterEach(() => jest.clearAllMocks());

  it('saves valid config and returns 200', async () => {
    const payload = {
      enrichmentModel: 'gemini-3-pro-preview',
      dataExtractionModel: 'gpt-5-chat-2',
    };
    mockSettingsService.setSetting.mockResolvedValue({
      settingName: CRM_ENRICHMENT_KEY,
      settingValue: JSON.stringify(payload),
      description: 'CRM enrichment model configuration',
      updatedBy: 'admin@example.com',
      updatedAt: new Date().toISOString(),
    });
    const res = await request(app)
      .put('/api/settings/crm-enrichment-config')
      .send(payload);
    expect(res.status).toBe(200);
    expect(res.body.config).toMatchObject(payload);
    expect(mockSettingsService.setSetting).toHaveBeenCalledWith(
      CRM_ENRICHMENT_KEY,
      JSON.stringify(payload),
      'CRM enrichment model configuration',
      'admin@example.com',
    );
  });

  it('rejects request with missing enrichmentModel (400)', async () => {
    const res = await request(app)
      .put('/api/settings/crm-enrichment-config')
      .send({ dataExtractionModel: 'gpt-5-chat-2' });
    expect(res.status).toBe(400);
    expect(mockSettingsService.setSetting).not.toHaveBeenCalled();
  });

  it('rejects request with missing dataExtractionModel (400)', async () => {
    const res = await request(app)
      .put('/api/settings/crm-enrichment-config')
      .send({ enrichmentModel: 'gemini-3-flash-preview' });
    expect(res.status).toBe(400);
    expect(mockSettingsService.setSetting).not.toHaveBeenCalled();
  });

  it('returns 500 when settingsService throws', async () => {
    mockSettingsService.setSetting.mockRejectedValue(new Error('DynamoDB error'));
    const res = await request(app)
      .put('/api/settings/crm-enrichment-config')
      .send({
        enrichmentModel: 'gemini-3-flash-preview',
        dataExtractionModel: 'gemini-3-flash-preview',
      });
    expect(res.status).toBe(500);
  });
});
