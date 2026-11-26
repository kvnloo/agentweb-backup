/**
 * ENG-2840 (W2-8): POST /api/emma/describe-media (type image) with no llm_model passes undefined to describeImage (which then runs
 * the configured vision model, as Emma's own tool does), no longer 'gpt-4o'. A given model is passed through. Tier allowlist off.
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
  checkTokenUsage: jest.fn().mockResolvedValue({ allowed: true, warning: false, used: 0, allowance: null, bonus: 0, effectiveAllowance: null, percentUsed: 0, month: '2026-11' }),
}));
const mockService = {
  describeImage: jest.fn(),
  describeVideo: jest.fn(),
  getDefaultModel: jest.fn(async () => 'default-model'),
  getModelDisplayName: jest.fn(() => undefined),
  resolveGenerationModel: jest.fn((model: string) => ({ model, fellBack: false, requestedModel: model })),
};
jest.mock('../services/agentModeService', () => ({ agentModeService: mockService }));
jest.mock('../services/chatbotService', () => ({ chatbotDb: { getChatSession: jest.fn() } }));
jest.mock('../services/settingsService', () => ({
  settingsService: { getSetting: jest.fn(async () => null) },
}));
jest.mock('../services/db', () => ({ userDb: { getUserById: jest.fn(async () => ({ isAdmin: false })) } }));
jest.mock('../services/subscriptionService', () => ({
  getUserSubscriptionResolution: jest.fn(async () => ({ subscriptionType: 'Free', resolved: true })),
  readTierAllowedModels: jest.fn(async () => ({ configured: false, allowedModels: [] })),
}));

import emmaApiRoutes from '../routes/emmaApi';
import { modelAccess } from '../services/agentMode/modelAccessInstance';

const app = express();
app.use(express.json());
app.use('/api/emma', emmaApiRoutes);

const URL_ = 'https://agentweb-user-files.s3.us-west-2.amazonaws.com/users/user-123/files/1/logo.png';

beforeEach(() => {
  mockService.describeImage.mockReset();
  mockService.describeVideo.mockReset();
  mockService.describeImage.mockResolvedValueOnce({ success: true, description: 'ok' });
  modelAccess.reset();
});

describe('POST /api/emma/describe-media (type image): the model sent to describeImage', () => {
  it('no llm_model: undefined (the vision model), not gpt-4o', async () => {
    const res = await request(app)
      .post('/api/emma/describe-media')
      .send({ type: 'image', url: URL_, prompt: 'what is this', session_id: 'sess-1' });

    expect(res.status).toBe(200);
    expect(mockService.describeImage).toHaveBeenCalledTimes(1);
    expect(mockService.describeImage).toHaveBeenCalledWith(undefined, URL_, 'what is this', {
      userId: 'user-123',
      sessionId: 'sess-1',
      feature: 'describe_image',
    });
    expect(mockService.describeImage.mock.calls[0][0]).not.toBe('gpt-4o');
  });

  it('no type at all (defaults to image): undefined model as well', async () => {
    await request(app).post('/api/emma/describe-media').send({ url: URL_ }).expect(200);
    expect(mockService.describeImage).toHaveBeenCalledWith(undefined, URL_, undefined, expect.objectContaining({ userId: 'user-123', feature: 'describe_image' }));
  });

  it('an empty llm_model is treated as none', async () => {
    await request(app).post('/api/emma/describe-media').send({ type: 'image', url: URL_, llm_model: '' }).expect(200);
    expect(mockService.describeImage.mock.calls[0][0]).toBeUndefined();
  });

  it('a given model is passed through', async () => {
    await request(app)
      .post('/api/emma/describe-media')
      .send({ type: 'image', url: URL_, prompt: 'p', llm_model: 'claude-sonnet-test' })
      .expect(200);

    expect(mockService.describeImage).toHaveBeenCalledWith('claude-sonnet-test', URL_, 'p', {
      userId: 'user-123',
      sessionId: undefined,
      feature: 'describe_image',
    });
  });

  it('video still goes to describeVideo, never describeImage', async () => {
    mockService.describeVideo.mockResolvedValueOnce({ success: true });
    await request(app).post('/api/emma/describe-media').send({ type: 'video', url: 'https://x/v.mp4' }).expect(200);
    expect(mockService.describeVideo).toHaveBeenCalledTimes(1);
    expect(mockService.describeImage).not.toHaveBeenCalled();
  });
});
