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

describe('Settings Work Plans API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /api/settings/agent-mode-predefined-workplans/:planId', () => {
    const handler = getRouteHandler('/agent-mode-predefined-workplans/:planId', 'get');

    it('should return 404 when no setting exists', async () => {
      mockedSettingsService.getSetting.mockResolvedValue(null);

      const req = {
        params: { planId: 'plan-1' }
      } as unknown as Request;
      const res = mockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ error: 'No predefined work plans found' });
    });

    it('should return the requested work plan when found', async () => {
      mockedSettingsService.getSetting.mockResolvedValue({
        settingKey: 'agent-mode-predefined-workplans',
        settingValue: JSON.stringify([
          { id: 'plan-1', title: 'Plan 1', steps: [{ stepCount: 1, title: 'Step 1' }] }
        ])
      } as any);

      const req = {
        params: { planId: 'plan-1' }
      } as unknown as Request;
      const res = mockResponse();

      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith({
        id: 'plan-1',
        title: 'Plan 1',
        steps: [{ stepCount: 1, title: 'Step 1' }]
      });
    });
  });

  describe('POST /api/settings/agent-mode-predefined-workplans', () => {
    const handler = getRouteHandler('/agent-mode-predefined-workplans', 'post');

    it('should create and persist a normalized work plan', async () => {
      mockedSettingsService.getSetting.mockResolvedValue(null);
      mockedSettingsService.setSetting.mockResolvedValue({} as any);

      const req = {
        body: {
          title: '  Onboarding  ',
          description: '  Plan desc  ',
          welcomeMessage: ' Welcome ',
          autocomplete: true,
          requireLogin: true,
          showLoginSignup: 'always',
          steps: [
            {
              title: '  Step 1  ',
              description: '  Desc  ',
              requiredFunctionCalls: ['search_web', '  ']
            },
            { title: '   ' }
          ]
        },
        user: { email: 'admin@example.com' }
      } as unknown as Request;
      const res = mockResponse();

      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          workPlan: expect.objectContaining({
            title: 'Onboarding',
            description: 'Plan desc',
            welcomeMessage: 'Welcome',
            autocomplete: true,
            requireLogin: true,
            showLoginSignup: 'always'
          })
        })
      );

      const setCall = mockedSettingsService.setSetting.mock.calls[0];
      const savedPlans = JSON.parse(setCall[1] as string);
      expect(savedPlans).toHaveLength(1);
      expect(savedPlans[0].steps).toHaveLength(1);
      expect(savedPlans[0].steps[0]).toEqual(
        expect.objectContaining({
          stepCount: 1,
          title: 'Step 1',
          description: 'Desc',
          requiredFunctionCalls: ['search_web']
        })
      );
    });

    it('should return 400 when title or steps are missing', async () => {
      const req = {
        body: { title: '', steps: [] },
        user: { email: 'admin@example.com' }
      } as unknown as Request;
      const res = mockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'title and steps are required' });
    });

    it('should return 409 when a work plan ID already exists', async () => {
      mockedSettingsService.getSetting.mockResolvedValue({
        settingKey: 'agent-mode-predefined-workplans',
        settingValue: JSON.stringify([
          { id: 'plan-1', title: 'Existing', steps: [{ stepCount: 1, title: 'Step 1' }] }
        ])
      } as any);

      const req = {
        body: { id: 'plan-1', title: 'New Plan', steps: [{ title: 'Step 1' }] },
        user: { email: 'admin@example.com' }
      } as unknown as Request;
      const res = mockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.json).toHaveBeenCalledWith({ error: 'Work plan with this ID already exists' });
    });

    it('should persist defaultModel when specified', async () => {
      mockedSettingsService.getSetting.mockResolvedValue(null);
      mockedSettingsService.setSetting.mockResolvedValue({} as any);

      const req = {
        body: {
          title: 'Test Plan',
          defaultModel: '  gemini-3-pro-preview  ',
          steps: [{ title: 'Step 1' }]
        },
        user: { email: 'admin@example.com' }
      } as unknown as Request;
      const res = mockResponse();

      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          workPlan: expect.objectContaining({
            title: 'Test Plan',
            defaultModel: 'gemini-3-pro-preview'
          })
        })
      );

      const setCall = mockedSettingsService.setSetting.mock.calls[0];
      const savedPlans = JSON.parse(setCall[1] as string);
      expect(savedPlans[0].defaultModel).toBe('gemini-3-pro-preview');
    });

    it('should normalize empty defaultModel to undefined', async () => {
      mockedSettingsService.getSetting.mockResolvedValue(null);
      mockedSettingsService.setSetting.mockResolvedValue({} as any);

      const req = {
        body: {
          title: 'Test Plan',
          defaultModel: '   ',
          steps: [{ title: 'Step 1' }]
        },
        user: { email: 'admin@example.com' }
      } as unknown as Request;
      const res = mockResponse();

      await handler(req, res);

      const setCall = mockedSettingsService.setSetting.mock.calls[0];
      const savedPlans = JSON.parse(setCall[1] as string);
      expect(savedPlans[0].defaultModel).toBeUndefined();
    });
  });

  describe('PUT /api/settings/agent-mode-predefined-workplans/:planId', () => {
    const handler = getRouteHandler('/agent-mode-predefined-workplans/:planId', 'put');

    it('should update an existing work plan', async () => {
      mockedSettingsService.getSetting.mockResolvedValue({
        settingKey: 'agent-mode-predefined-workplans',
        settingValue: JSON.stringify([
          { id: 'plan-1', title: 'Original', steps: [{ stepCount: 1, title: 'Old' }] }
        ])
      } as any);
      mockedSettingsService.setSetting.mockResolvedValue({} as any);

      const req = {
        params: { planId: 'plan-1' },
        body: {
          title: ' Updated ',
          steps: [{ title: 'New Step' }]
        },
        user: { email: 'admin@example.com' }
      } as unknown as Request;
      const res = mockResponse();

      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          workPlan: expect.objectContaining({
            id: 'plan-1',
            title: 'Updated'
          })
        })
      );

      const setCall = mockedSettingsService.setSetting.mock.calls[0];
      const savedPlans = JSON.parse(setCall[1] as string);
      expect(savedPlans[0].steps[0].stepCount).toBe(1);
    });

    it('should return 404 when updating missing work plans', async () => {
      mockedSettingsService.getSetting.mockResolvedValue(null);

      const req = {
        params: { planId: 'plan-1' },
        body: { title: 'Updated', steps: [{ title: 'Step 1' }] },
        user: { email: 'admin@example.com' }
      } as unknown as Request;
      const res = mockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ error: 'No predefined work plans found' });
    });

    it('should update defaultModel when specified', async () => {
      mockedSettingsService.getSetting.mockResolvedValue({
        settingKey: 'agent-mode-predefined-workplans',
        settingValue: JSON.stringify([
          { id: 'plan-1', title: 'Original', steps: [{ stepCount: 1, title: 'Old' }] }
        ])
      } as any);
      mockedSettingsService.setSetting.mockResolvedValue({} as any);

      const req = {
        params: { planId: 'plan-1' },
        body: {
          title: 'Updated',
          defaultModel: 'claude-opus-4',
          steps: [{ title: 'New Step' }]
        },
        user: { email: 'admin@example.com' }
      } as unknown as Request;
      const res = mockResponse();

      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          workPlan: expect.objectContaining({
            id: 'plan-1',
            title: 'Updated',
            defaultModel: 'claude-opus-4'
          })
        })
      );

      const setCall = mockedSettingsService.setSetting.mock.calls[0];
      const savedPlans = JSON.parse(setCall[1] as string);
      expect(savedPlans[0].defaultModel).toBe('claude-opus-4');
    });

    it('should remove defaultModel when updated to empty string', async () => {
      mockedSettingsService.getSetting.mockResolvedValue({
        settingKey: 'agent-mode-predefined-workplans',
        settingValue: JSON.stringify([
          { id: 'plan-1', title: 'Original', defaultModel: 'old-model', steps: [{ stepCount: 1, title: 'Old' }] }
        ])
      } as any);
      mockedSettingsService.setSetting.mockResolvedValue({} as any);

      const req = {
        params: { planId: 'plan-1' },
        body: {
          title: 'Updated',
          defaultModel: '',
          steps: [{ title: 'New Step' }]
        },
        user: { email: 'admin@example.com' }
      } as unknown as Request;
      const res = mockResponse();

      await handler(req, res);

      const setCall = mockedSettingsService.setSetting.mock.calls[0];
      const savedPlans = JSON.parse(setCall[1] as string);
      expect(savedPlans[0].defaultModel).toBeUndefined();
    });
  });

  describe('DELETE /api/settings/agent-mode-predefined-workplans/:planId', () => {
    const handler = getRouteHandler('/agent-mode-predefined-workplans/:planId', 'delete');

    it('should delete a work plan when it exists', async () => {
      mockedSettingsService.getSetting.mockResolvedValue({
        settingKey: 'agent-mode-predefined-workplans',
        settingValue: JSON.stringify([
          { id: 'plan-1', title: 'Plan 1', steps: [{ stepCount: 1, title: 'Step 1' }] },
          { id: 'plan-2', title: 'Plan 2', steps: [{ stepCount: 1, title: 'Step 1' }] }
        ])
      } as any);
      mockedSettingsService.setSetting.mockResolvedValue({} as any);

      const req = {
        params: { planId: 'plan-1' },
        user: { email: 'admin@example.com' }
      } as unknown as Request;
      const res = mockResponse();

      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith({ success: true, message: 'Work plan deleted successfully' });

      const setCall = mockedSettingsService.setSetting.mock.calls[0];
      const savedPlans = JSON.parse(setCall[1] as string);
      expect(savedPlans).toHaveLength(1);
      expect(savedPlans[0].id).toBe('plan-2');
    });
  });
});
