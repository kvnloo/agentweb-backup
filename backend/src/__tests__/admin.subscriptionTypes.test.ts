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
  getAllAvailableConnectedAccounts: jest.fn(() => ['linkedin', 'unipile', 'meta', 'gmail', 'youtube', 'fathom', 'instagram']),
  getAllAvailableSubscriptionFeatures: jest.fn(() => [
    { id: 'scheduled_chats', label: 'Scheduled chats', description: 'Create and run scheduled chats.' },
  ]),
  getPublicAllowedSkills: jest.fn(async () => []),
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
    getSupportedModels: jest.fn(async () => [
      'gemini-3.1-flash-lite',
      'anthropic.claude-haiku-4-5-20251001-v1:0',
      'anthropic.claude-opus-5',
    ]),
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
    expect(legacy.allowedFeatures).toEqual(['scheduled_chats']);
  });

  it('GET /api/admin/subscription-features returns reusable feature metadata', async () => {
    const res = await request(app)
      .get('/api/admin/subscription-features')
      .set('Authorization', 'Bearer test-token')
      .expect(200);
    expect(res.body.features).toEqual([expect.objectContaining({ id: 'scheduled_chats' })]);
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
    expect(pro.allowedFeatures).toEqual(['scheduled_chats']);
  });

  it('POST /api/admin/subscription-types persists an explicit feature denial', async () => {
    mockedSettingsService.setSetting.mockResolvedValue(undefined as any);
    await request(app)
      .post('/api/admin/subscription-types')
      .set('Authorization', 'Bearer test-token')
      .send({ subscriptionTypes: [{
        name: 'Community', allowedPages: ['/tasks'], allowedSkills: ['skill-1'], allowedFeatures: [],
      }] })
      .expect(200);
    const saved = JSON.parse(mockedSettingsService.setSetting.mock.calls[0][1] as string);
    expect(saved[0].allowedFeatures).toEqual([]);
  });

  // ENG-200: the per-user cost cap lives on the tier as monthlyCostAllowance. The
  // admin read/write paths must round-trip it (symmetric with monthlyTokenAllowance)
  // or the Users-tab "LLM Cost $X / $cap" display can never show a cap, and any
  // tier edit via the admin UI silently wipes a cap set out-of-band.
  it('GET /api/admin/subscription-types should return monthlyCostAllowance when set', async () => {
    const storedTypes = [
      { name: 'Starter', allowedPages: ['/tasks'], allowedSkills: ['skill-1'], monthlyTokenAllowance: 20000000, monthlyCostAllowance: 500 },
      { name: 'Free', allowedPages: ['/tasks'], allowedSkills: ['skill-1'] },
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

    const starter = res.body.find((t: any) => t.name === 'Starter');
    const free = res.body.find((t: any) => t.name === 'Free');
    expect(starter.monthlyCostAllowance).toBe(500);
    // Unset stays absent (unlimited), not coerced to a number
    expect(free.monthlyCostAllowance).toBeUndefined();
  });

  it('POST /api/admin/subscription-types should persist monthlyCostAllowance', async () => {
    // No wildcards in the payload below, so the page/skill expansion mocks are
    // irrelevant here — leave the shared mocks untouched to avoid leaking a
    // narrowed skill list into later wildcard-expansion tests.
    mockedSettingsService.setSetting.mockResolvedValue(undefined as any);

    const payload = {
      subscriptionTypes: [
        { name: 'Starter', allowedPages: ['/tasks'], allowedSkills: ['skill-1'], monthlyCostAllowance: 250 },
        { name: 'Free', allowedPages: ['/tasks'], allowedSkills: ['skill-1'] },
      ],
    };

    await request(app)
      .post('/api/admin/subscription-types')
      .set('Authorization', 'Bearer test-token')
      .send(payload)
      .expect(200);

    const [, settingValue] = mockedSettingsService.setSetting.mock.calls[0];
    const savedTypes = JSON.parse(settingValue as string);
    const starter = savedTypes.find((t: any) => t.name === 'Starter');
    const free = savedTypes.find((t: any) => t.name === 'Free');
    expect(starter.monthlyCostAllowance).toBe(250);
    expect(free.monthlyCostAllowance).toBeUndefined();
  });

  it('GET /api/admin/subscription-types round-trips the versioned LLM usage policy', async () => {
    const llmUsagePolicy = {
      version: 'starter-v1', enforcementState: 'enforce',
      optimizationCostThresholdMicroUsd: 30_000_000,
      hardCostThresholdMicroUsd: 60_000_000,
      optimizedModelIds: ['gemini-3.1-flash-lite'],
      optimizedDefaultModel: 'gemini-3.1-flash-lite',
    };
    mockedSettingsService.getSetting.mockResolvedValue({
      settingName: 'subscription_types',
      settingValue: JSON.stringify([{ name: 'Starter', allowedPages: ['/tasks'], allowedSkills: ['skill-1'], llmUsagePolicy }]),
    } as any);

    const res = await request(app).get('/api/admin/subscription-types').expect(200);

    expect(res.body[0].llmUsagePolicy).toEqual(llmUsagePolicy);
  });

  it('POST /api/admin/subscription-types validates and persists a cost-only policy', async () => {
    const llmUsagePolicy = {
      version: 'starter-v1', enforcementState: 'enforce',
      optimizationCostThresholdMicroUsd: 30_000_000,
      hardCostThresholdMicroUsd: 60_000_000,
      optimizedModelIds: ['gemini-3.1-flash-lite'],
      optimizedDefaultModel: 'gemini-3.1-flash-lite',
    };

    await request(app).post('/api/admin/subscription-types').send({
      subscriptionTypes: [{ name: 'Starter', allowedPages: ['/tasks'], allowedSkills: ['skill-1'], llmUsagePolicy }],
    }).expect(200);

    const saved = JSON.parse(mockedSettingsService.setSetting.mock.calls[0][1] as string);
    expect(saved[0].llmUsagePolicy).toEqual(llmUsagePolicy);
  });

  // ENG-1214 AC5: the alert thresholds are only "admin-configurable" if the
  // admin save path can actually carry them. It builds the stored policy from an
  // explicit field whitelist, so a field missing from that list is not merely
  // un-settable -- it is silently DROPPED from any policy that already had it,
  // reverting the tier to the defaults without telling anyone.
  it('persists the alert thresholds when an admin sets them', async () => {
    const llmUsagePolicy = {
      version: 'starter-alert-v1', enforcementState: 'enforce',
      optimizationCostThresholdMicroUsd: 30_000_000,
      hardCostThresholdMicroUsd: 60_000_000,
      optimizedModelIds: ['gemini-3.1-flash-lite'],
      optimizedDefaultModel: 'gemini-3.1-flash-lite',
      alertUsagePercentThreshold: 75,
      alertOnForecastShortfall: false,
    };

    await request(app).post('/api/admin/subscription-types').send({
      subscriptionTypes: [{ name: 'Starter', allowedPages: ['/tasks'], allowedSkills: ['skill-1'], llmUsagePolicy }],
    }).expect(200);

    const saved = JSON.parse(mockedSettingsService.setSetting.mock.calls[0][1] as string);
    expect(saved[0].llmUsagePolicy.alertUsagePercentThreshold).toBe(75);
    expect(saved[0].llmUsagePolicy.alertOnForecastShortfall).toBe(false);
  });

  it('leaves the alert fields absent when the admin omits them', async () => {
    // Absent must stay absent rather than being materialised as the default:
    // a stored 90 cannot later be told apart from "never configured", which is
    // what lets the default move without rewriting every tier.
    const llmUsagePolicy = {
      version: 'starter-noalert-v1', enforcementState: 'enforce',
      optimizationCostThresholdMicroUsd: 30_000_000,
      hardCostThresholdMicroUsd: 60_000_000,
      optimizedModelIds: ['gemini-3.1-flash-lite'],
      optimizedDefaultModel: 'gemini-3.1-flash-lite',
    };

    await request(app).post('/api/admin/subscription-types').send({
      subscriptionTypes: [{ name: 'Starter', allowedPages: ['/tasks'], allowedSkills: ['skill-1'], llmUsagePolicy }],
    }).expect(200);

    const saved = JSON.parse(mockedSettingsService.setSetting.mock.calls[0][1] as string);
    expect(saved[0].llmUsagePolicy).not.toHaveProperty('alertUsagePercentThreshold');
    expect(saved[0].llmUsagePolicy).not.toHaveProperty('alertOnForecastShortfall');
  });

  it('rejects an out-of-range alert threshold instead of coercing it', async () => {
    // Passing the value through RAW is what lets validation see it. Coercing at
    // the boundary (Number(...), === true) would make the validator a no-op and
    // silently store a threshold that never fires.
    await request(app).post('/api/admin/subscription-types').send({
      subscriptionTypes: [{
        name: 'Starter', allowedPages: ['/tasks'], allowedSkills: ['skill-1'],
        llmUsagePolicy: {
          version: 'starter-bad-v1', enforcementState: 'enforce',
          optimizationCostThresholdMicroUsd: 30_000_000,
          hardCostThresholdMicroUsd: 60_000_000,
          optimizedModelIds: ['gemini-3.1-flash-lite'],
          optimizedDefaultModel: 'gemini-3.1-flash-lite',
          alertUsagePercentThreshold: 100,
        },
      }],
    }).expect(400);
  });

  it('rejects a non-boolean forecast-alert flag instead of coercing it', async () => {
    await request(app).post('/api/admin/subscription-types').send({
      subscriptionTypes: [{
        name: 'Starter', allowedPages: ['/tasks'], allowedSkills: ['skill-1'],
        llmUsagePolicy: {
          version: 'starter-bad-v2', enforcementState: 'enforce',
          optimizationCostThresholdMicroUsd: 30_000_000,
          hardCostThresholdMicroUsd: 60_000_000,
          optimizedModelIds: ['gemini-3.1-flash-lite'],
          optimizedDefaultModel: 'gemini-3.1-flash-lite',
          alertOnForecastShortfall: 'yes',
        },
      }],
    }).expect(400);
  });

  it('persists the hard-cap-only rollout state independently of model optimization', async () => {
    const llmUsagePolicy = {
      version: 'starter-hard-v1', enforcementState: 'hard_only',
      optimizationCostThresholdMicroUsd: 30_000_000,
      hardCostThresholdMicroUsd: 60_000_000,
      optimizedModelIds: ['gemini-3.1-flash-lite'],
      optimizedDefaultModel: 'gemini-3.1-flash-lite',
    };
    await request(app).post('/api/admin/subscription-types').send({
      subscriptionTypes: [{ name: 'Starter', allowedPages: ['/tasks'], allowedSkills: ['skill-1'], llmUsagePolicy }],
    }).expect(200);
    const saved = JSON.parse(mockedSettingsService.setSetting.mock.calls[0][1] as string);
    expect(saved[0].llmUsagePolicy.enforcementState).toBe('hard_only');
  });

  it('rejects a policy whose hard cost threshold is not above its optimization threshold', async () => {
    const res = await request(app).post('/api/admin/subscription-types').send({
      subscriptionTypes: [{
        name: 'Starter', allowedPages: ['/tasks'], allowedSkills: ['skill-1'],
        llmUsagePolicy: {
          version: 'bad-v1', enforcementState: 'enforce',
          optimizationCostThresholdMicroUsd: 60_000_000,
          hardCostThresholdMicroUsd: 60_000_000,
          optimizedModelIds: ['gemini-3.1-flash-lite'],
          optimizedDefaultModel: 'gemini-3.1-flash-lite',
        },
      }],
    }).expect(400);

    expect(res.body.message).toContain('hardCostThresholdMicroUsd must be greater');
    expect(mockedSettingsService.setSetting).not.toHaveBeenCalled();
  });

  it('round-trips admin-priced additional usage packages', async () => {
    const llmUsageTopUp = {
      enabled: true,
      minimumMarkupBps: 25_000,
      packages: [{
        id: 'aw-10', label: '10 AgentWeb Credits', priceCents: 2_500,
        usageCreditMicroUsd: 10_000_000, active: true,
      }],
    };
    await request(app).post('/api/admin/subscription-types').send({
      subscriptionTypes: [{ name: 'Starter', allowedPages: ['/tasks'], allowedSkills: ['skill-1'], llmUsageTopUp }],
    }).expect(200);
    const saved = JSON.parse(mockedSettingsService.setSetting.mock.calls[0][1] as string);
    expect(saved[0].llmUsageTopUp).toEqual(llmUsageTopUp);
  });

  it('rejects an additional usage package below the configured markup floor', async () => {
    const res = await request(app).post('/api/admin/subscription-types').send({
      subscriptionTypes: [{
        name: 'Starter', allowedPages: ['/tasks'], allowedSkills: ['skill-1'],
        llmUsageTopUp: {
          enabled: true,
          minimumMarkupBps: 25_000,
          packages: [{ id: 'bad', label: 'Bad', priceCents: 2_499, usageCreditMicroUsd: 10_000_000, active: true }],
        },
      }],
    }).expect(400);
    expect(res.body.message).toContain('below minimumMarkupBps');
  });

  describe('POST /api/admin/subscription-types/:typeName/skills', () => {
    const storedTypes = [
      { name: 'Basic', allowedPages: ['/'], allowedSkills: ['skill-1'] },
      { name: 'Pro', allowedPages: ['/'], allowedSkills: ['skill-1', 'skill-2'] },
    ];

    beforeEach(() => {
      mockedSettingsService.getSetting.mockResolvedValue({
        settingName: 'subscription_types',
        settingValue: JSON.stringify(storedTypes),
        description: 'Subscription types',
        updatedAt: new Date().toISOString(),
        updatedBy: 'system',
      } as any);
      mockedSettingsService.setSetting.mockResolvedValue(undefined as any);
    });

    it('should return 400 when skillId is missing', async () => {
      await request(app)
        .post('/api/admin/subscription-types/Basic/skills')
        .set('Authorization', 'Bearer test-token')
        .send({ action: 'add' })
        .expect(400);
    });

    it('should return 400 when action is invalid', async () => {
      await request(app)
        .post('/api/admin/subscription-types/Basic/skills')
        .set('Authorization', 'Bearer test-token')
        .send({ skillId: 'skill-2', action: 'toggle' })
        .expect(400);
    });

    it('should return 404 when subscription type does not exist', async () => {
      await request(app)
        .post('/api/admin/subscription-types/NonExistent/skills')
        .set('Authorization', 'Bearer test-token')
        .send({ skillId: 'skill-2', action: 'add' })
        .expect(404);
    });

    it('should add a skill to a subscription type', async () => {
      const res = await request(app)
        .post('/api/admin/subscription-types/Basic/skills')
        .set('Authorization', 'Bearer test-token')
        .send({ skillId: 'skill-2', action: 'add' })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.subscriptionType.allowedSkills).toContain('skill-2');
      expect(res.body.subscriptionType.allowedSkills).toContain('skill-1');

      // Verify setSetting was called with updated data
      const savedTypes = JSON.parse(mockedSettingsService.setSetting.mock.calls[0][1] as string);
      const basic = savedTypes.find((t: any) => t.name === 'Basic');
      expect(basic.allowedSkills).toEqual(['skill-1', 'skill-2']);
      // Pro should be untouched
      const pro = savedTypes.find((t: any) => t.name === 'Pro');
      expect(pro.allowedSkills).toEqual(['skill-1', 'skill-2']);
    });

    it('should remove a skill from a subscription type', async () => {
      const res = await request(app)
        .post('/api/admin/subscription-types/Pro/skills')
        .set('Authorization', 'Bearer test-token')
        .send({ skillId: 'skill-2', action: 'remove' })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.subscriptionType.allowedSkills).not.toContain('skill-2');
      expect(res.body.subscriptionType.allowedSkills).toContain('skill-1');
    });

    it('should not duplicate a skill when adding one that already exists', async () => {
      const res = await request(app)
        .post('/api/admin/subscription-types/Basic/skills')
        .set('Authorization', 'Bearer test-token')
        .send({ skillId: 'skill-1', action: 'add' })
        .expect(200);

      expect(res.body.subscriptionType.allowedSkills.filter((s: string) => s === 'skill-1')).toHaveLength(1);
    });

    it('should expand wildcard "*" before removing a skill', async () => {
      const wildcardTypes = [
        { name: 'AllAccess', allowedPages: ['/'], allowedSkills: ['*'] },
      ];
      mockedSettingsService.getSetting.mockResolvedValue({
        settingName: 'subscription_types',
        settingValue: JSON.stringify(wildcardTypes),
        description: 'Subscription types',
        updatedAt: new Date().toISOString(),
        updatedBy: 'system',
      } as any);

      const res = await request(app)
        .post('/api/admin/subscription-types/AllAccess/skills')
        .set('Authorization', 'Bearer test-token')
        .send({ skillId: 'skill-1', action: 'remove' })
        .expect(200);

      expect(res.body.subscriptionType.allowedSkills).not.toContain('skill-1');
      expect(res.body.subscriptionType.allowedSkills).not.toContain('*');
      // Should still have the other skills from the expanded list
      expect(res.body.subscriptionType.allowedSkills).toContain('skill-2');
      expect(res.body.subscriptionType.allowedSkills).toContain('__other_skills__');
    });
  });

  // --- Public skills routes ---

  describe('GET /api/admin/public-skills', () => {
    it('should return empty array when no setting exists', async () => {
      mockedSettingsService.getSetting.mockResolvedValue(null);

      const res = await request(app)
        .get('/api/admin/public-skills')
        .set('Authorization', 'Bearer test-token')
        .expect(200);

      expect(res.body.allowedSkills).toEqual([]);
    });

    it('should return stored public skills list', async () => {
      mockedSettingsService.getSetting.mockResolvedValue({
        settingName: 'public_allowed_skills',
        settingValue: JSON.stringify(['skill-1', '__other_skills__']),
        description: 'Skills available to public/anonymous users',
        updatedAt: new Date().toISOString(),
        updatedBy: 'admin',
      } as any);

      const res = await request(app)
        .get('/api/admin/public-skills')
        .set('Authorization', 'Bearer test-token')
        .expect(200);

      expect(res.body.allowedSkills).toEqual(['skill-1', '__other_skills__']);
    });
  });

  describe('POST /api/admin/public-skills', () => {
    it('should return 400 when skillId is missing', async () => {
      await request(app)
        .post('/api/admin/public-skills')
        .set('Authorization', 'Bearer test-token')
        .send({ action: 'add' })
        .expect(400);
    });

    it('should return 400 when action is invalid', async () => {
      await request(app)
        .post('/api/admin/public-skills')
        .set('Authorization', 'Bearer test-token')
        .send({ skillId: 'skill-1', action: 'toggle' })
        .expect(400);
    });

    it('should add a skill to public access', async () => {
      mockedSettingsService.getSetting.mockResolvedValue({
        settingName: 'public_allowed_skills',
        settingValue: JSON.stringify(['skill-1']),
        description: 'Skills available to public/anonymous users',
        updatedAt: new Date().toISOString(),
        updatedBy: 'admin',
      } as any);
      mockedSettingsService.setSetting.mockResolvedValue(undefined as any);

      const res = await request(app)
        .post('/api/admin/public-skills')
        .set('Authorization', 'Bearer test-token')
        .send({ skillId: 'skill-2', action: 'add' })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.allowedSkills).toContain('skill-1');
      expect(res.body.allowedSkills).toContain('skill-2');
    });

    it('should remove a skill from public access', async () => {
      mockedSettingsService.getSetting.mockResolvedValue({
        settingName: 'public_allowed_skills',
        settingValue: JSON.stringify(['skill-1', 'skill-2']),
        description: 'Skills available to public/anonymous users',
        updatedAt: new Date().toISOString(),
        updatedBy: 'admin',
      } as any);
      mockedSettingsService.setSetting.mockResolvedValue(undefined as any);

      const res = await request(app)
        .post('/api/admin/public-skills')
        .set('Authorization', 'Bearer test-token')
        .send({ skillId: 'skill-1', action: 'remove' })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.allowedSkills).not.toContain('skill-1');
      expect(res.body.allowedSkills).toContain('skill-2');
    });

    it('should expand wildcard before removing a skill', async () => {
      mockedSettingsService.getSetting.mockResolvedValue({
        settingName: 'public_allowed_skills',
        settingValue: JSON.stringify(['*']),
        description: 'Skills available to public/anonymous users',
        updatedAt: new Date().toISOString(),
        updatedBy: 'admin',
      } as any);
      mockedSettingsService.setSetting.mockResolvedValue(undefined as any);

      const res = await request(app)
        .post('/api/admin/public-skills')
        .set('Authorization', 'Bearer test-token')
        .send({ skillId: 'skill-1', action: 'remove' })
        .expect(200);

      expect(res.body.allowedSkills).not.toContain('skill-1');
      expect(res.body.allowedSkills).not.toContain('*');
      expect(res.body.allowedSkills).toContain('skill-2');
      expect(res.body.allowedSkills).toContain('__other_skills__');
    });

    it('should add skill to empty list when no setting exists', async () => {
      mockedSettingsService.getSetting.mockResolvedValue(null);
      mockedSettingsService.setSetting.mockResolvedValue(undefined as any);

      const res = await request(app)
        .post('/api/admin/public-skills')
        .set('Authorization', 'Bearer test-token')
        .send({ skillId: 'skill-1', action: 'add' })
        .expect(200);

      expect(res.body.allowedSkills).toEqual(['skill-1']);
    });
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
