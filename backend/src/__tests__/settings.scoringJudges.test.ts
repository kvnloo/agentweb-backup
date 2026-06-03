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
    deleteSetting: jest.fn(),
  },
}));

jest.mock('../services/db', () => ({ userDb: {} }));
jest.mock('../services/linkedInOutreachService', () => ({
  linkedInOutreachService: { checkAccountConnectivity: jest.fn() },
}));
jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    getSupportedModels: jest.fn().mockResolvedValue([
      'gemini-3.1-flash-lite',
      'gemini-3.5-flash',
      'gemini-3.1-flash-live-preview',
    ]),
    llmModels: {
      'gemini-3.1-flash-lite': { isLive: false },
      'gemini-3.5-flash': { isLive: false },
      'gemini-3.1-flash-live-preview': { isLive: true },
    },
  },
}));

const mockSettingsService = settingsService as jest.Mocked<typeof settingsService>;

const app = express();
app.use(express.json());
app.use('/api/settings', settingsRoutes);

afterEach(() => jest.clearAllMocks());

describe('GET /api/settings/scoring-judges', () => {
  it('returns judges and available models, filtering out live models', async () => {
    mockSettingsService.getSetting.mockResolvedValue({
      settingName: 'scoring-judges',
      settingValue: JSON.stringify([{ id: 'j1', name: 'A', systemPrompt: 'p', llmModel: 'gemini-3.5-flash' }]),
      description: '',
      updatedBy: 'admin@example.com',
      updatedAt: new Date().toISOString(),
    });

    const res = await request(app).get('/api/settings/scoring-judges');

    expect(res.status).toBe(200);
    expect(res.body.judges).toHaveLength(1);
    expect(res.body.availableModels).toContain('gemini-3.5-flash');
    expect(res.body.availableModels).toContain('gemini-3.1-flash-lite');
    expect(res.body.availableModels).not.toContain('gemini-3.1-flash-live-preview');
  });

  it('returns an empty judges array when nothing is stored', async () => {
    mockSettingsService.getSetting.mockResolvedValue(null);
    const res = await request(app).get('/api/settings/scoring-judges');
    expect(res.status).toBe(200);
    expect(res.body.judges).toEqual([]);
  });
});

describe('POST /api/settings/scoring-judges', () => {
  it('persists llmModel when provided', async () => {
    mockSettingsService.getSetting.mockResolvedValue(null);
    mockSettingsService.setSetting.mockResolvedValue({} as any);

    const res = await request(app)
      .post('/api/settings/scoring-judges')
      .send({ name: 'Strict', systemPrompt: 'Rate it', llmModel: 'gemini-3.5-flash' });

    expect(res.status).toBe(200);
    expect(res.body.judge.llmModel).toBe('gemini-3.5-flash');
    expect(res.body.judge.name).toBe('Strict');
  });

  it('omits llmModel when not provided', async () => {
    mockSettingsService.getSetting.mockResolvedValue(null);
    mockSettingsService.setSetting.mockResolvedValue({} as any);

    const res = await request(app)
      .post('/api/settings/scoring-judges')
      .send({ name: 'Lenient', systemPrompt: 'Rate it' });

    expect(res.status).toBe(200);
    expect(res.body.judge.llmModel).toBeUndefined();
  });

  it('returns 400 when name or systemPrompt missing', async () => {
    const res = await request(app)
      .post('/api/settings/scoring-judges')
      .send({ name: 'NoPrompt' });
    expect(res.status).toBe(400);
    expect(mockSettingsService.setSetting).not.toHaveBeenCalled();
  });
});

describe('PUT /api/settings/scoring-judges/:judgeId', () => {
  const existing = [{ id: 'j1', name: 'A', systemPrompt: 'p', llmModel: 'gemini-3.5-flash', createdAt: 't', updatedAt: 't' }];

  it('updates llmModel when provided', async () => {
    mockSettingsService.getSetting.mockResolvedValue({
      settingName: 'scoring-judges',
      settingValue: JSON.stringify(existing),
      description: '', updatedBy: 'a', updatedAt: 't',
    });
    mockSettingsService.setSetting.mockResolvedValue({} as any);

    const res = await request(app)
      .put('/api/settings/scoring-judges/j1')
      .send({ llmModel: 'gemini-3.1-flash-lite' });

    expect(res.status).toBe(200);
    expect(res.body.judge.llmModel).toBe('gemini-3.1-flash-lite');
  });

  it('clears llmModel when an empty string is sent', async () => {
    mockSettingsService.getSetting.mockResolvedValue({
      settingName: 'scoring-judges',
      settingValue: JSON.stringify(existing),
      description: '', updatedBy: 'a', updatedAt: 't',
    });
    mockSettingsService.setSetting.mockResolvedValue({} as any);

    const res = await request(app)
      .put('/api/settings/scoring-judges/j1')
      .send({ llmModel: '' });

    expect(res.status).toBe(200);
    expect(res.body.judge.llmModel).toBeUndefined();
  });

  it('returns 404 for an unknown judge id', async () => {
    mockSettingsService.getSetting.mockResolvedValue({
      settingName: 'scoring-judges',
      settingValue: JSON.stringify(existing),
      description: '', updatedBy: 'a', updatedAt: 't',
    });
    const res = await request(app)
      .put('/api/settings/scoring-judges/does-not-exist')
      .send({ llmModel: 'gemini-3.5-flash' });
    expect(res.status).toBe(404);
  });
});

describe('default scoring model', () => {
  it('GET default-prompt returns the configured llmModel', async () => {
    mockSettingsService.getSetting.mockImplementation(async (key: string) => {
      if (key === 'default-scoring-prompt') return { settingValue: 'custom prompt' } as any;
      if (key === 'default-scoring-model') return { settingValue: 'gemini-3.5-flash' } as any;
      return null as any;
    });

    const res = await request(app).get('/api/settings/scoring-judges/default-prompt');

    expect(res.status).toBe(200);
    expect(res.body.llmModel).toBe('gemini-3.5-flash');
    expect(res.body.isCustom).toBe(true);
  });

  it('PUT default-prompt persists the llmModel', async () => {
    mockSettingsService.setSetting.mockResolvedValue({} as any);
    mockSettingsService.getSetting.mockResolvedValue({ settingValue: 'gemini-3.5-flash' } as any);

    const res = await request(app)
      .put('/api/settings/scoring-judges/default-prompt')
      .send({ systemPrompt: 'new prompt', llmModel: 'gemini-3.5-flash' });

    expect(res.status).toBe(200);
    expect(res.body.llmModel).toBe('gemini-3.5-flash');
    expect(mockSettingsService.setSetting).toHaveBeenCalledWith(
      'default-scoring-model', 'gemini-3.5-flash', expect.any(String), 'admin@example.com'
    );
  });

  it('PUT default-prompt clears the model when llmModel is empty', async () => {
    mockSettingsService.setSetting.mockResolvedValue({} as any);
    mockSettingsService.deleteSetting.mockResolvedValue(undefined as any);
    mockSettingsService.getSetting.mockResolvedValue(null);

    const res = await request(app)
      .put('/api/settings/scoring-judges/default-prompt')
      .send({ systemPrompt: 'new prompt', llmModel: '' });

    expect(res.status).toBe(200);
    expect(res.body.llmModel).toBe('');
    expect(mockSettingsService.deleteSetting).toHaveBeenCalledWith('default-scoring-model');
  });

  it('PUT default-prompt returns 400 when systemPrompt missing', async () => {
    const res = await request(app)
      .put('/api/settings/scoring-judges/default-prompt')
      .send({ llmModel: 'gemini-3.5-flash' });
    expect(res.status).toBe(400);
  });

  it('DELETE default-prompt clears both prompt and model', async () => {
    mockSettingsService.deleteSetting.mockResolvedValue(undefined as any);

    const res = await request(app).delete('/api/settings/scoring-judges/default-prompt');

    expect(res.status).toBe(200);
    expect(res.body.llmModel).toBe('');
    expect(mockSettingsService.deleteSetting).toHaveBeenCalledWith('default-scoring-prompt');
    expect(mockSettingsService.deleteSetting).toHaveBeenCalledWith('default-scoring-model');
  });
});
