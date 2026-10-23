/**
 * ENG-669 (review CHECK 8): /api/emma routes that take a model from the request body run it on the CALLER's account,
 * outside the agent turn (and so outside the resolver), so with the tier model allowlist on the model must be in the
 * caller's plan: 422 model_unavailable / not_in_plan, nothing called. Switch off: unchanged.
 */
import express from 'express';
import request from 'supertest';

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: 'user-123', email: 'test@example.com', isAdmin: false };
    next();
  },
  AuthenticatedRequest: jest.fn(),
}));
jest.mock('../services/tokenUsageService', () => ({
  checkTokenUsage: jest.fn().mockResolvedValue({ allowed: true, warning: false, used: 0, allowance: null, bonus: 0, effectiveAllowance: null, percentUsed: 0, month: '2026-10' }),
}));
const mockService = {
  createHtmlFromTemplate: jest.fn(),
  describeImage: jest.fn(),
  describeVideo: jest.fn(),
  getDefaultModel: jest.fn(async () => 'default-model'),
  getModelDisplayName: jest.fn((id: string) => (id === 'premium-model' ? 'Premium Model' : undefined)),
  resolveGenerationModel: jest.fn((model: string) => (['default-model', 'cheap-model', 'premium-model'].includes(model)
    ? { model, fellBack: false, requestedModel: model }
    : { model: 'default-model', fellBack: true, requestedModel: model })),
};
jest.mock('../services/agentModeService', () => ({ agentModeService: mockService }));
jest.mock('../services/chatbotService', () => ({ chatbotDb: { getChatSession: jest.fn() } }));
const mockSettings: Record<string, string | undefined> = {};
jest.mock('../services/settingsService', () => ({
  settingsService: {
    getSetting: jest.fn(async (name: string) => (mockSettings[name] === undefined ? null : { settingName: name, settingValue: mockSettings[name] })),
  },
}));
jest.mock('../services/db', () => ({ userDb: { getUserById: jest.fn(async () => ({ isAdmin: false })) } }));
jest.mock('../services/subscriptionService', () => ({
  getUserSubscriptionResolution: jest.fn(async () => ({ subscriptionType: 'Free', resolved: true })),
  readTierAllowedModels: jest.fn(async () => ({ configured: true, allowedModels: ['cheap-model'] })),
}));

import emmaApiRoutes from '../routes/emmaApi';
import { modelAccess } from '../services/agentMode/modelAccessInstance';

const app = express();
app.use(express.json());
app.use('/api/emma', emmaApiRoutes);

beforeEach(() => {
  jest.clearAllMocks();
  for (const key of Object.keys(mockSettings)) delete mockSettings[key];
  mockSettings.subscription_types = JSON.stringify([{ name: 'Free', allowedModels: ['cheap-model'] }, { name: 'Pro' }]);
  modelAccess.reset();
  mockService.createHtmlFromTemplate.mockResolvedValue({ success: true });
  mockService.describeImage.mockResolvedValue({ description: 'ok' });
});

describe('switch on', () => {
  beforeEach(() => { mockSettings.model_tier_allowlist_enabled = 'true'; });

  it('create-html-from-template: a model outside the caller\'s plan is a 422 and no LLM call is made', async () => {
    const res = await request(app).post('/api/emma/create-html-from-template').send({ llm_model: 'premium-model', template_id: 't1' });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: 'model_unavailable', reason: 'not_in_plan', tier: 'Free', upgradeRequired: ['Pro'] });
    expect(mockService.createHtmlFromTemplate).not.toHaveBeenCalled();
  });

  it('create-html-from-template: an allowed model, the default, or no model runs as before', async () => {
    for (const llm_model of ['cheap-model', 'default-model', undefined]) {
      const res = await request(app).post('/api/emma/create-html-from-template').send({ llm_model, template_id: 't1' });
      expect(res.status).toBe(200);
    }
    expect(mockService.createHtmlFromTemplate).toHaveBeenCalledTimes(3);
  });

  it('describe-media (image): a model outside the caller\'s plan is a 422; video analysis takes no model and is untouched', async () => {
    const refused = await request(app).post('/api/emma/describe-media').send({ type: 'image', url: 'https://x/y.png', llm_model: 'premium-model' });
    expect(refused.status).toBe(422);
    expect(mockService.describeImage).not.toHaveBeenCalled();
    mockService.describeVideo.mockResolvedValue({ description: 'ok' });
    const video = await request(app).post('/api/emma/describe-media').send({ type: 'video', url: 'https://x/y.mp4', llm_model: 'premium-model' });
    expect(video.status).toBe(200);
  });
});

it('switch off: the same requests run exactly as before', async () => {
  const html = await request(app).post('/api/emma/create-html-from-template').send({ llm_model: 'premium-model', template_id: 't1' });
  expect(html.status).toBe(200);
  const image = await request(app).post('/api/emma/describe-media').send({ type: 'image', url: 'https://x/y.png', llm_model: 'premium-model' });
  expect(image.status).toBe(200);
});

describe('ENG-669 PR-C: the AgentWeb Model can never run on a single-call route', () => {
  it.each([false, true])('refused with a visible 422 (allowlist on: %s); never falls back to the default model', async (allowlistOn) => {
    if (allowlistOn) mockSettings.model_tier_allowlist_enabled = 'true';
    const html = await request(app).post('/api/emma/create-html-from-template').send({ llm_model: 'agentweb-model', template_id: 't1' });
    expect(html.status).toBe(422);
    expect(html.body).toEqual({
      error: 'AgentWeb Model can\'t be used here. Choose a specific model to continue.',
      code: 'model_unavailable',
      requestedModel: 'agentweb-model',
      reason: 'not_selectable',
    });
    const image = await request(app).post('/api/emma/describe-media').send({ type: 'image', url: 'https://x/y.png', llm_model: 'agentweb-model' });
    expect(image.status).toBe(422);
    expect(mockService.createHtmlFromTemplate).not.toHaveBeenCalled();
    expect(mockService.describeImage).not.toHaveBeenCalled();
  });
});
