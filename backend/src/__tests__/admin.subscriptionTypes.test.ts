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

// Mock subscriptionService helpers so we control available pages / skills
jest.mock('../services/subscriptionService', () => ({
  getAllAvailablePages: jest.fn(() => ['/', '/agent-mode', '/settings', '/guide', '/tasks']),
  getAllAvailableSkills: jest.fn(async () => ['skill-1', 'skill-2', '__other_skills__']),
  // Keep getAllAvailableFunctionCalls for backward compat if referenced elsewhere
  getAllAvailableFunctionCalls: jest.fn(async () => ['generate_image', 'generate_video', 'search_web']),
}));

// Mock skillService for the available-skills endpoint
jest.mock('../services/skillService', () => ({
  skillService: {
    getPublishedSkills: jest.fn(async () => [
      { skillId: 'skill-1', name: 'Image Gen', description: 'Image generation', toolNames: ['generate_image'] },
      { skillId: 'skill-2', name: 'Video Gen', description: 'Video generation', toolNames: ['generate_video', 'search_web'] },
    ]),
  },
}));

// Mock agentModeService for the available-skills endpoint
jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    getUnassociatedToolNames: jest.fn(() => ['other_tool_1', 'other_tool_2']),
  },
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

  it('GET /api/admin/subscription-types should expand "*" to full skill lists', async () => {
    // Simulate existing config in AW-Settings using "*" for pages and skills
    const storedTypes = [
      {
        name: 'Basic',
        allowedPages: ['*'],
        allowedSkills: ['*'],
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

    // allowedSkills should be expanded using getAllAvailableSkills
    expect(basic.allowedSkills).toEqual(
      await (subscriptionService.getAllAvailableSkills as jest.Mock).mock.results[0].value,
    );
    expect(basic.allowedSkills).toContain('skill-1');
    expect(basic.allowedSkills).toContain('skill-2');
    expect(basic.allowedSkills).toContain('__other_skills__');
    // No wildcard should remain
    expect(basic.allowedSkills).not.toContain('*');
  });

  it('GET /api/admin/subscription-types backward compat: old format with allowedFunctionCalls gets all skills', async () => {
    // Old format without allowedSkills
    const storedTypes = [
      {
        name: 'Legacy',
        allowedPages: ['/tasks'],
        allowedFunctionCalls: ['generate_image'],
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
    const legacy = res.body[0];

    // Missing allowedSkills should be expanded to all available skills
    expect(legacy.allowedSkills).toEqual(
      await (subscriptionService.getAllAvailableSkills as jest.Mock).mock.results[0].value,
    );
    // Should not have allowedFunctionCalls in the response (replaced by allowedSkills)
    expect(legacy.allowedSkills).toContain('skill-1');
  });

  it('POST /api/admin/subscription-types should save expanded skills instead of "*"', async () => {
    (subscriptionService.getAllAvailablePages as jest.Mock).mockReturnValue([
      '/',
      '/agent-mode',
      '/settings',
      '/guide',
      '/tasks',
    ]);
    (subscriptionService.getAllAvailableSkills as jest.Mock).mockResolvedValue([
      'skill-1',
      'skill-2',
      '__other_skills__',
    ]);

    const payload = {
      subscriptionTypes: [
        {
          name: 'Pro',
          allowedPages: ['*'],
          allowedSkills: ['*'],
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
    expect(pro.allowedSkills).toEqual([
      'skill-1',
      'skill-2',
      '__other_skills__',
    ]);
    expect(pro.allowedSkills).not.toContain('*');
  });

  it('GET /api/admin/available-skills returns published skills plus __other_skills__', async () => {
    const res = await request(app)
      .get('/api/admin/available-skills')
      .set('Authorization', 'Bearer test-token')
      .expect(200);

    expect(res.body).toHaveLength(3); // 2 published + 1 virtual
    expect(res.body[0].skillId).toBe('skill-1');
    expect(res.body[0].name).toBe('Image Gen');
    expect(res.body[0].toolNames).toEqual(['generate_image']);
    expect(res.body[1].skillId).toBe('skill-2');
    expect(res.body[2].skillId).toBe('__other_skills__');
    expect(res.body[2].name).toBe('Other Skills');
    expect(res.body[2].toolNames).toEqual(['other_tool_1', 'other_tool_2']);
  });
});
