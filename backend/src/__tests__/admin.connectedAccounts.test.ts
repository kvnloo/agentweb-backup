import request from 'supertest';
import express from 'express';
import adminRoutes from '../routes/admin';

// Mock auth + admin middleware
jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: 'admin-user-1', isAdmin: true };
    next();
  },
}));

jest.mock('../middleware/admin', () => ({
  isAdmin: (_req: any, _res: any, next: any) => next(),
}));

// Mock settings service
jest.mock('../services/settingsService', () => ({
  settingsService: {
    getSetting: jest.fn(),
    setSetting: jest.fn(),
  },
}));

// Mock subscriptionService helpers
jest.mock('../services/subscriptionService', () => ({
  getAllAvailablePages: jest.fn(() => ['/', '/agent-mode', '/settings', '/guide', '/tasks']),
  getAllAvailableSkills: jest.fn(async () => ['skill-1', 'skill-2', '__other_skills__']),
  getAllAvailableConnectedAccounts: jest.fn(() => [
    'linkedin', 'unipile', 'meta', 'gmail', 'youtube', 'fathom', 'instagram', 'google_ads',
  ]),
  getPublicAllowedSkills: jest.fn(async () => []),
  getAllAvailableFunctionCalls: jest.fn(async () => ['generate_image', 'generate_video', 'search_web']),
  getAllAvailableSubscriptionFeatures: jest.fn(() => [{
    id: 'scheduled_chats', label: 'Scheduled chats', description: 'Create and run scheduled chats.',
  }]),
}));

// Mock skillService
jest.mock('../services/skillService', () => ({
  skillService: {
    getPublishedSkills: jest.fn(async () => [
      { skillId: 'skill-1', name: 'Image Gen', description: 'Image generation', toolNames: ['generate_image'] },
      { skillId: 'skill-2', name: 'Video Gen', description: 'Video generation', toolNames: ['generate_video', 'search_web'] },
    ]),
  },
}));

// Mock agentModeService
jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    getUnassociatedToolNames: jest.fn(() => ['other_tool_1', 'other_tool_2']),
  },
}));

import { settingsService } from '../services/settingsService';
import * as subscriptionService from '../services/subscriptionService';

const mockedSettingsService = settingsService as jest.Mocked<typeof settingsService>;

let app: express.Application;

describe('Admin subscription types - allowedConnectedAccounts', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    app = express();
    app.use(express.json());
    app.use('/api/admin', adminRoutes);
  });

  it('GET should expand "*" in allowedConnectedAccounts to full platform list', async () => {
    const storedTypes = [{
      name: 'Pro',
      allowedPages: ['*'],
      allowedSkills: ['*'],
      allowedConnectedAccounts: ['*'],
    }];

    mockedSettingsService.getSetting.mockResolvedValue({
      settingName: 'subscription_types',
      settingValue: JSON.stringify(storedTypes),
      description: 'Subscription types',
      updatedAt: new Date().toISOString(),
      updatedBy: 'system',
    } as any);

    const res = await request(app)
      .get('/api/admin/subscription-types')
      .set('Authorization', 'Bearer test-token')
      .expect(200);

    expect(res.body[0].allowedConnectedAccounts).toEqual([
      'linkedin', 'unipile', 'meta', 'gmail', 'youtube', 'fathom', 'instagram', 'google_ads',
    ]);
  });

  it('GET should default to all platforms when allowedConnectedAccounts is missing (backward compat)', async () => {
    const storedTypes = [{
      name: 'Legacy',
      allowedPages: ['/tasks'],
      allowedSkills: ['skill-1'],
    }];

    mockedSettingsService.getSetting.mockResolvedValue({
      settingName: 'subscription_types',
      settingValue: JSON.stringify(storedTypes),
      description: 'Subscription types',
      updatedAt: new Date().toISOString(),
      updatedBy: 'system',
    } as any);

    const res = await request(app)
      .get('/api/admin/subscription-types')
      .set('Authorization', 'Bearer test-token')
      .expect(200);

    expect(res.body[0].allowedConnectedAccounts).toEqual([
      'linkedin', 'unipile', 'meta', 'gmail', 'youtube', 'fathom', 'instagram', 'google_ads',
    ]);
  });

  it('GET should preserve specific platform list when not wildcard', async () => {
    const storedTypes = [{
      name: 'Basic',
      allowedPages: ['*'],
      allowedSkills: ['*'],
      allowedConnectedAccounts: ['linkedin', 'gmail'],
    }];

    mockedSettingsService.getSetting.mockResolvedValue({
      settingName: 'subscription_types',
      settingValue: JSON.stringify(storedTypes),
      description: 'Subscription types',
      updatedAt: new Date().toISOString(),
      updatedBy: 'system',
    } as any);

    const res = await request(app)
      .get('/api/admin/subscription-types')
      .set('Authorization', 'Bearer test-token')
      .expect(200);

    expect(res.body[0].allowedConnectedAccounts).toEqual(['linkedin', 'gmail']);
  });

  it('POST should save allowedConnectedAccounts and expand "*"', async () => {
    mockedSettingsService.setSetting.mockResolvedValue(undefined as any);

    const payload = {
      subscriptionTypes: [{
        name: 'Pro',
        allowedPages: ['*'],
        allowedSkills: ['*'],
        allowedConnectedAccounts: ['*'],
      }],
    };

    await request(app)
      .post('/api/admin/subscription-types')
      .set('Authorization', 'Bearer test-token')
      .send(payload)
      .expect(200);

    expect(mockedSettingsService.setSetting).toHaveBeenCalledTimes(1);
    const savedTypes = JSON.parse(mockedSettingsService.setSetting.mock.calls[0][1] as string);
    expect(savedTypes[0].allowedConnectedAccounts).toEqual([
      'linkedin', 'unipile', 'meta', 'gmail', 'youtube', 'fathom', 'instagram', 'google_ads',
    ]);
  });

  it('POST should save specific platform list without expansion', async () => {
    mockedSettingsService.setSetting.mockResolvedValue(undefined as any);

    const payload = {
      subscriptionTypes: [{
        name: 'Basic',
        allowedPages: ['*'],
        allowedSkills: ['*'],
        allowedConnectedAccounts: ['linkedin', 'gmail'],
      }],
    };

    await request(app)
      .post('/api/admin/subscription-types')
      .set('Authorization', 'Bearer test-token')
      .send(payload)
      .expect(200);

    const savedTypes = JSON.parse(mockedSettingsService.setSetting.mock.calls[0][1] as string);
    expect(savedTypes[0].allowedConnectedAccounts).toEqual(['linkedin', 'gmail']);
  });

  it('POST should default to all platforms when allowedConnectedAccounts is missing', async () => {
    mockedSettingsService.setSetting.mockResolvedValue(undefined as any);

    const payload = {
      subscriptionTypes: [{
        name: 'Basic',
        allowedPages: ['*'],
        allowedSkills: ['*'],
        // no allowedConnectedAccounts
      }],
    };

    await request(app)
      .post('/api/admin/subscription-types')
      .set('Authorization', 'Bearer test-token')
      .send(payload)
      .expect(200);

    const savedTypes = JSON.parse(mockedSettingsService.setSetting.mock.calls[0][1] as string);
    expect(savedTypes[0].allowedConnectedAccounts).toEqual([
      'linkedin', 'unipile', 'meta', 'gmail', 'youtube', 'fathom', 'instagram', 'google_ads',
    ]);
  });
});
