import request from 'supertest';
import express from 'express';
import adminRoutes from '../routes/admin';

// Mock auth + admin middleware so we always act as an admin
jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: 'admin-user-1', isAdmin: true };
    next();
  },
}));

jest.mock('../middleware/admin', () => ({
  isAdmin: (_req: any, _res: any, next: any) => next(),
}));

// Mock settings service used to persist subscription types
jest.mock('../services/settingsService', () => ({
  settingsService: {
    getSetting: jest.fn(),
    setSetting: jest.fn(),
  },
}));

// Mock subscriptionService helpers so we control available pages / function calls
jest.mock('../services/subscriptionService', () => ({
  getAllAvailablePages: jest.fn(() => ['/', '/agent-mode', '/settings', '/guide', '/tasks']),
  getAllAvailableFunctionCalls: jest.fn(async () => ['generate_image', 'generate_video', 'search_web']),
}));

import { settingsService } from '../services/settingsService';
import * as subscriptionService from '../services/subscriptionService';

const mockedSettingsService = settingsService as jest.Mocked<typeof settingsService>;

let app: express.Application;

describe('Admin subscription types routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    app = express();
    app.use(express.json());
    app.use('/api/admin', adminRoutes);
  });

  it('GET /api/admin/subscription-types should expand "*" to full lists and include generate_video', async () => {
    // Simulate existing config in AW-Settings using "*" for pages and function calls
    const storedTypes = [
      {
        name: 'Basic',
        allowedPages: ['*'],
        allowedFunctionCalls: ['*'],
      },
    ];

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

    expect(res.body).toHaveLength(1);
    const basic = res.body[0];

    // allowedPages should be expanded using getAllAvailablePages
    expect(basic.allowedPages).toEqual(
      (subscriptionService.getAllAvailablePages as jest.Mock).mock.results[0].value,
    );

    // allowedFunctionCalls should be expanded using getAllAvailableFunctionCalls and include generate_video
    expect(basic.allowedFunctionCalls).toEqual(
      await (subscriptionService.getAllAvailableFunctionCalls as jest.Mock).mock.results[0].value,
    );
    expect(basic.allowedFunctionCalls).toContain('generate_video');
    // No wildcard should remain
    expect(basic.allowedFunctionCalls).not.toContain('*');
  });

  it('POST /api/admin/subscription-types should save expanded lists instead of "*"', async () => {
    (subscriptionService.getAllAvailablePages as jest.Mock).mockReturnValue([
      '/',
      '/agent-mode',
      '/settings',
      '/guide',
      '/tasks',
    ]);
    (subscriptionService.getAllAvailableFunctionCalls as jest.Mock).mockResolvedValue([
      'generate_image',
      'generate_video',
      'search_web',
    ]);

    const payload = {
      subscriptionTypes: [
        {
          name: 'Pro',
          allowedPages: ['*'],
          allowedFunctionCalls: ['*'],
        },
      ],
    };

    mockedSettingsService.setSetting.mockResolvedValue(undefined as any);

    await request(app)
      .post('/api/admin/subscription-types')
      .set('Authorization', 'Bearer test-token')
      .send(payload)
      .expect(200);

    expect(mockedSettingsService.setSetting).toHaveBeenCalledTimes(1);
    const [, settingValue] = mockedSettingsService.setSetting.mock.calls[0];

    const savedTypes = JSON.parse(settingValue as string);
    expect(savedTypes).toHaveLength(1);
    const pro = savedTypes[0];

    // Wildcards should have been expanded before saving
    expect(pro.allowedPages).toEqual([
      '/',
      '/agent-mode',
      '/settings',
      '/guide',
      '/tasks',
    ]);
    expect(pro.allowedFunctionCalls).toEqual([
      'generate_image',
      'generate_video',
      'search_web',
    ]);
    expect(pro.allowedFunctionCalls).not.toContain('*');
  });
});
