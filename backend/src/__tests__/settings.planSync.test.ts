import { Request, Response } from 'express';
import settingsRouter from '../routes/settings';
import { settingsService } from '../services/settingsService';

jest.mock('../services/settingsService');

const mockedSettingsService = settingsService as jest.Mocked<typeof settingsService>;

type HttpMethod = 'get' | 'post' | 'put' | 'delete';

const getRouteHandler = (path: string, method: HttpMethod) => {
  const layer = (settingsRouter as any).stack.find((item: any) =>
    item.route && item.route.path === path && item.route.methods?.[method]
  );

  if (!layer) {
    throw new Error(`Route not found: ${method.toUpperCase()} ${path}`);
  }

  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
};

const mockResponse = () => {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as Response;
};

describe('Settings Plan Sync API', () => {
  const originalEnv = process.env.NODE_ENV;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  describe('GET /api/settings/agent-mode-predefined-workplans/sync-status', () => {
    const handler = getRouteHandler('/agent-mode-predefined-workplans/sync-status', 'get');

    it('should return sync status for all plans in development environment', async () => {
      process.env.NODE_ENV = 'development';

      const mockStatus = {
        'plan-1': {
          inSync: true,
          existsInProd: true,
          existsInDev: true,
          changedFields: []
        },
        'plan-2': {
          inSync: false,
          existsInProd: true,
          existsInDev: true,
          changedFields: ['title', 'steps']
        }
      };

      mockedSettingsService.getPlanSyncStatus.mockResolvedValue(mockStatus);

      const req = {} as Request;
      const res = mockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        plans: mockStatus,
        environment: 'development'
      });
    });

    it('should return sync status for all plans in production environment', async () => {
      process.env.NODE_ENV = 'production';

      const mockStatus = {
        'plan-1': {
          inSync: true,
          existsInProd: true,
          existsInDev: true,
          changedFields: []
        }
      };

      mockedSettingsService.getPlanSyncStatus.mockResolvedValue(mockStatus);

      const req = {} as Request;
      const res = mockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        plans: mockStatus,
        environment: 'production'
      });
    });

    it('should handle errors when getting sync status', async () => {
      mockedSettingsService.getPlanSyncStatus.mockRejectedValue(new Error('DynamoDB error'));

      const req = {} as Request;
      const res = mockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: 'Failed to get plan sync status' });
    });
  });

  describe('POST /api/settings/agent-mode-predefined-workplans/sync', () => {
    const handler = getRouteHandler('/agent-mode-predefined-workplans/sync', 'post');

    const mockPlan = {
      id: 'plan-1',
      title: 'Test Plan',
      description: 'Test description',
      steps: [{ stepCount: 1, title: 'Step 1' }]
    };

    it('should sync plan from dev to prod in development environment', async () => {
      process.env.NODE_ENV = 'development';

      mockedSettingsService.syncPlan.mockResolvedValue(mockPlan);

      const req = {
        body: {
          planId: 'plan-1',
          direction: 'dev-to-prod'
        }
      } as Request;
      const res = mockResponse();

      await handler(req, res);

      expect(mockedSettingsService.syncPlan).toHaveBeenCalledWith('plan-1', 'dev-to-prod');
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(mockPlan);
    });

    it('should sync plan from prod to dev in production environment', async () => {
      process.env.NODE_ENV = 'production';

      mockedSettingsService.syncPlan.mockResolvedValue(mockPlan);

      const req = {
        body: {
          planId: 'plan-1',
          direction: 'prod-to-dev'
        }
      } as Request;
      const res = mockResponse();

      await handler(req, res);

      expect(mockedSettingsService.syncPlan).toHaveBeenCalledWith('plan-1', 'prod-to-dev');
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(mockPlan);
    });

    it('should return 400 when planId is missing', async () => {
      const req = {
        body: {
          direction: 'dev-to-prod'
        }
      } as Request;
      const res = mockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'planId and direction are required' });
      expect(mockedSettingsService.syncPlan).not.toHaveBeenCalled();
    });

    it('should return 400 when direction is missing', async () => {
      const req = {
        body: {
          planId: 'plan-1'
        }
      } as Request;
      const res = mockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'planId and direction are required' });
      expect(mockedSettingsService.syncPlan).not.toHaveBeenCalled();
    });

    it('should return 400 when direction is invalid', async () => {
      const req = {
        body: {
          planId: 'plan-1',
          direction: 'invalid-direction'
        }
      } as Request;
      const res = mockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: 'direction must be "prod-to-dev" or "dev-to-prod"'
      });
      expect(mockedSettingsService.syncPlan).not.toHaveBeenCalled();
    });

    it('should reject prod-to-dev sync in development environment', async () => {
      process.env.NODE_ENV = 'development';

      const req = {
        body: {
          planId: 'plan-1',
          direction: 'prod-to-dev'
        }
      } as Request;
      const res = mockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: 'In dev environment, only "dev-to-prod" sync is allowed'
      });
      expect(mockedSettingsService.syncPlan).not.toHaveBeenCalled();
    });

    it('should reject dev-to-prod sync in production environment', async () => {
      process.env.NODE_ENV = 'production';

      const req = {
        body: {
          planId: 'plan-1',
          direction: 'dev-to-prod'
        }
      } as Request;
      const res = mockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: 'In prod environment, only "prod-to-dev" sync is allowed'
      });
      expect(mockedSettingsService.syncPlan).not.toHaveBeenCalled();
    });

    it('should return 404 when plan not found in source', async () => {
      process.env.NODE_ENV = 'development';

      mockedSettingsService.syncPlan.mockResolvedValue(null);

      const req = {
        body: {
          planId: 'non-existent-plan',
          direction: 'dev-to-prod'
        }
      } as Request;
      const res = mockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ error: 'Plan not found in source environment' });
    });

    it('should handle errors during sync', async () => {
      process.env.NODE_ENV = 'development';

      mockedSettingsService.syncPlan.mockRejectedValue(new Error('Sync error'));

      const req = {
        body: {
          planId: 'plan-1',
          direction: 'dev-to-prod'
        }
      } as Request;
      const res = mockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: 'Failed to sync plan' });
    });

    it('should handle undefined NODE_ENV as production', async () => {
      delete process.env.NODE_ENV;

      mockedSettingsService.syncPlan.mockResolvedValue(mockPlan);

      const req = {
        body: {
          planId: 'plan-1',
          direction: 'prod-to-dev'
        }
      } as Request;
      const res = mockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(mockPlan);
    });

    it('should sync plan with all fields intact', async () => {
      process.env.NODE_ENV = 'development';

      const fullPlan = {
        id: 'plan-1',
        title: 'Full Plan',
        description: 'Complete description',
        welcomeMessage: 'Welcome!',
        autocomplete: true,
        requireLogin: false,
        showLoginSignup: 'after_plan_completed',
        showInAgentMode: true,
        defaultModel: 'claude-opus-4',
        steps: [
          {
            stepCount: 1,
            title: 'Step 1',
            description: 'First step',
            requiredFunctionCalls: ['search_web'],
            skillIds: ['skill-1']
          },
          {
            stepCount: 2,
            title: 'Step 2',
            description: 'Second step'
          }
        ]
      };

      mockedSettingsService.syncPlan.mockResolvedValue(fullPlan);

      const req = {
        body: {
          planId: 'plan-1',
          direction: 'dev-to-prod'
        }
      } as Request;
      const res = mockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(fullPlan);
    });
  });
});
