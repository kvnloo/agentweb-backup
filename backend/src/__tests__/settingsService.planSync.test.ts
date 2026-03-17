import { PredefinedPlan, PlanSyncInfo } from '../services/settingsService';

describe('SettingsService - Plan Sync', () => {
  let settingsService: any;
  let SettingsService: any;
  let mockPut: jest.Mock;
  let mockGet: jest.Mock;
  let mockPromise: jest.Mock;

  const mockTimestamp = '2026-03-17T10:00:00.000Z';

  beforeAll(() => {
    jest.resetModules();

    mockPromise = jest.fn();
    mockPut = jest.fn(() => ({ promise: mockPromise }));
    mockGet = jest.fn(() => ({ promise: mockPromise }));

    jest.doMock('aws-sdk', () => ({
      DynamoDB: {
        DocumentClient: jest.fn(() => ({
          put: mockPut,
          get: mockGet,
        })),
      },
    }));

    // Import the module after mocking
    const module = require('../services/settingsService');
    settingsService = module.settingsService;
    SettingsService = module.SettingsService;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Date.prototype, 'toISOString').mockReturnValue(mockTimestamp);

    // Reset defaults
    mockPromise.mockResolvedValue({});
    mockPut.mockReturnValue({ promise: mockPromise });
    mockGet.mockReturnValue({ promise: mockPromise });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('syncPlan', () => {
    const mockPlan: PredefinedPlan = {
      id: 'plan-1',
      title: 'Test Plan',
      description: 'Test description',
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
        }
      ]
    };

    it('should read from prod and write to dev for prod-to-dev', async () => {
      const sourceSetting = {
        settingName: 'agent-mode-predefined-workplans',
        settingValue: JSON.stringify([mockPlan])
      };

      const targetSetting = {
        settingName: 'agent-mode-predefined-workplans',
        settingValue: JSON.stringify([]),
        description: 'Existing description'
      };

      mockPromise
        .mockResolvedValueOnce({ Item: sourceSetting }) // get from source
        .mockResolvedValueOnce({ Item: targetSetting }) // get from target
        .mockResolvedValueOnce({}); // put to target

      const result = await settingsService.syncPlan('plan-1', 'prod-to-dev');

      expect(result).toEqual(mockPlan);
      // Should read from AW-Settings (prod)
      expect(mockGet).toHaveBeenNthCalledWith(1, expect.objectContaining({
        TableName: 'AW-Settings',
        Key: { settingName: 'agent-mode-predefined-workplans' },
      }));
      // Should read from Dev-AW-Settings (dev)
      expect(mockGet).toHaveBeenNthCalledWith(2, expect.objectContaining({
        TableName: 'Dev-AW-Settings',
        Key: { settingName: 'agent-mode-predefined-workplans' },
      }));
      // Should write to Dev-AW-Settings (dev)
      expect(mockPut).toHaveBeenCalledWith(expect.objectContaining({
        TableName: 'Dev-AW-Settings',
        Item: expect.objectContaining({
          settingName: 'agent-mode-predefined-workplans',
          settingValue: JSON.stringify([mockPlan]),
        })
      }));
    });

    it('should read from dev and write to prod for dev-to-prod', async () => {
      const sourceSetting = {
        settingName: 'agent-mode-predefined-workplans',
        settingValue: JSON.stringify([mockPlan])
      };

      const targetSetting = {
        settingName: 'agent-mode-predefined-workplans',
        settingValue: JSON.stringify([])
      };

      mockPromise
        .mockResolvedValueOnce({ Item: sourceSetting })
        .mockResolvedValueOnce({ Item: targetSetting })
        .mockResolvedValueOnce({});

      const result = await settingsService.syncPlan('plan-1', 'dev-to-prod');

      expect(result).toEqual(mockPlan);
      // Should read from Dev-AW-Settings (dev)
      expect(mockGet).toHaveBeenNthCalledWith(1, expect.objectContaining({
        TableName: 'Dev-AW-Settings',
      }));
      // Should write to AW-Settings (prod)
      expect(mockPut).toHaveBeenCalledWith(expect.objectContaining({
        TableName: 'AW-Settings',
      }));
    });

    it('should return null if source setting does not exist', async () => {
      mockPromise.mockResolvedValueOnce({ Item: undefined });

      const result = await settingsService.syncPlan('plan-1', 'prod-to-dev');
      expect(result).toBeNull();
      expect(mockPut).not.toHaveBeenCalled();
    });

    it('should return null if plan not found in source', async () => {
      const sourceSetting = {
        settingName: 'agent-mode-predefined-workplans',
        settingValue: JSON.stringify([mockPlan])
      };

      mockPromise.mockResolvedValueOnce({ Item: sourceSetting });

      const result = await settingsService.syncPlan('non-existent-plan', 'prod-to-dev');
      expect(result).toBeNull();
      expect(mockPut).not.toHaveBeenCalled();
    });

    it('should update existing plan in target when plan already exists', async () => {
      const oldPlan: PredefinedPlan = {
        id: 'plan-1',
        title: 'Old Title',
        steps: [{ stepCount: 1, title: 'Old Step' }]
      };

      const sourceSetting = {
        settingName: 'agent-mode-predefined-workplans',
        settingValue: JSON.stringify([mockPlan])
      };

      const targetSetting = {
        settingName: 'agent-mode-predefined-workplans',
        settingValue: JSON.stringify([oldPlan])
      };

      mockPromise
        .mockResolvedValueOnce({ Item: sourceSetting })
        .mockResolvedValueOnce({ Item: targetSetting })
        .mockResolvedValueOnce({});

      await settingsService.syncPlan('plan-1', 'prod-to-dev');

      // Should write updated plans array with the new plan replacing the old one
      expect(mockPut).toHaveBeenCalledWith(expect.objectContaining({
        Item: expect.objectContaining({
          settingValue: JSON.stringify([mockPlan]),
        })
      }));
    });

    it('should add plan to target when target has no plans', async () => {
      const sourceSetting = {
        settingName: 'agent-mode-predefined-workplans',
        settingValue: JSON.stringify([mockPlan])
      };

      mockPromise
        .mockResolvedValueOnce({ Item: sourceSetting })
        .mockResolvedValueOnce({ Item: undefined }) // no target setting
        .mockResolvedValueOnce({});

      await settingsService.syncPlan('plan-1', 'prod-to-dev');

      expect(mockPut).toHaveBeenCalledWith(expect.objectContaining({
        Item: expect.objectContaining({
          settingValue: JSON.stringify([mockPlan]),
        })
      }));
    });

    it('should handle malformed target plans gracefully', async () => {
      const sourceSetting = {
        settingName: 'agent-mode-predefined-workplans',
        settingValue: JSON.stringify([mockPlan])
      };

      const targetSetting = {
        settingName: 'agent-mode-predefined-workplans',
        settingValue: 'invalid-json'
      };

      mockPromise
        .mockResolvedValueOnce({ Item: sourceSetting })
        .mockResolvedValueOnce({ Item: targetSetting })
        .mockResolvedValueOnce({});

      await settingsService.syncPlan('plan-1', 'prod-to-dev');

      // Should write the plan despite malformed target (treated as empty array)
      expect(mockPut).toHaveBeenCalledWith(expect.objectContaining({
        Item: expect.objectContaining({
          settingValue: JSON.stringify([mockPlan]),
        })
      }));
    });
  });

  describe('getPlanSyncStatus', () => {
    const plan1: PredefinedPlan = {
      id: 'plan-1',
      title: 'Plan One',
      description: 'Description',
      steps: [{ stepCount: 1, title: 'Step 1' }]
    };

    const plan2: PredefinedPlan = {
      id: 'plan-2',
      title: 'Plan Two',
      steps: [{ stepCount: 1, title: 'Step 1' }]
    };

    it('should return inSync=true when prod and dev plans match', async () => {
      const prodSetting = {
        settingName: 'agent-mode-predefined-workplans',
        settingValue: JSON.stringify([plan1])
      };

      const devSetting = {
        settingName: 'agent-mode-predefined-workplans',
        settingValue: JSON.stringify([plan1])
      };

      mockPromise
        .mockResolvedValueOnce({ Item: prodSetting })
        .mockResolvedValueOnce({ Item: devSetting });

      const result = await settingsService.getPlanSyncStatus();

      expect(result['plan-1']).toEqual({
        inSync: true,
        existsInProd: true,
        existsInDev: true,
        changedFields: []
      });
    });

    it('should detect changed fields between prod and dev', async () => {
      const prodPlan: PredefinedPlan = {
        id: 'plan-1',
        title: 'Original Title',
        description: 'Original description',
        steps: [{ stepCount: 1, title: 'Step 1' }]
      };

      const devPlan: PredefinedPlan = {
        id: 'plan-1',
        title: 'Updated Title',
        description: 'Updated description',
        steps: [{ stepCount: 1, title: 'Step 1' }]
      };

      const prodSetting = {
        settingName: 'agent-mode-predefined-workplans',
        settingValue: JSON.stringify([prodPlan])
      };

      const devSetting = {
        settingName: 'agent-mode-predefined-workplans',
        settingValue: JSON.stringify([devPlan])
      };

      mockPromise
        .mockResolvedValueOnce({ Item: prodSetting })
        .mockResolvedValueOnce({ Item: devSetting });

      const result = await settingsService.getPlanSyncStatus();

      expect(result['plan-1']).toEqual({
        inSync: false,
        existsInProd: true,
        existsInDev: true,
        changedFields: ['title', 'description']
      });
    });

    it('should detect when steps have changed', async () => {
      const prodPlan: PredefinedPlan = {
        id: 'plan-1',
        title: 'Test Plan',
        steps: [{ stepCount: 1, title: 'Step 1' }]
      };

      const devPlan: PredefinedPlan = {
        id: 'plan-1',
        title: 'Test Plan',
        steps: [
          { stepCount: 1, title: 'Step 1' },
          { stepCount: 2, title: 'Step 2' }
        ]
      };

      const prodSetting = {
        settingName: 'agent-mode-predefined-workplans',
        settingValue: JSON.stringify([prodPlan])
      };

      const devSetting = {
        settingName: 'agent-mode-predefined-workplans',
        settingValue: JSON.stringify([devPlan])
      };

      mockPromise
        .mockResolvedValueOnce({ Item: prodSetting })
        .mockResolvedValueOnce({ Item: devSetting });

      const result = await settingsService.getPlanSyncStatus();

      expect(result['plan-1'].changedFields).toContain('steps');
      expect(result['plan-1'].inSync).toBe(false);
    });

    it('should handle plan only in prod', async () => {
      const prodSetting = {
        settingName: 'agent-mode-predefined-workplans',
        settingValue: JSON.stringify([plan1])
      };

      const devSetting = {
        settingName: 'agent-mode-predefined-workplans',
        settingValue: JSON.stringify([])
      };

      mockPromise
        .mockResolvedValueOnce({ Item: prodSetting })
        .mockResolvedValueOnce({ Item: devSetting });

      const result = await settingsService.getPlanSyncStatus();

      expect(result['plan-1']).toEqual({
        inSync: false,
        existsInProd: true,
        existsInDev: false,
        changedFields: []
      });
    });

    it('should handle plan only in dev', async () => {
      const prodSetting = {
        settingName: 'agent-mode-predefined-workplans',
        settingValue: JSON.stringify([])
      };

      const devSetting = {
        settingName: 'agent-mode-predefined-workplans',
        settingValue: JSON.stringify([plan1])
      };

      mockPromise
        .mockResolvedValueOnce({ Item: prodSetting })
        .mockResolvedValueOnce({ Item: devSetting });

      const result = await settingsService.getPlanSyncStatus();

      expect(result['plan-1']).toEqual({
        inSync: false,
        existsInProd: false,
        existsInDev: true,
        changedFields: []
      });
    });

    it('should handle multiple plans with different sync states', async () => {
      const prodPlans = [plan1, plan2];
      const devPlans = [plan1]; // plan2 missing

      const prodSetting = {
        settingName: 'agent-mode-predefined-workplans',
        settingValue: JSON.stringify(prodPlans)
      };

      const devSetting = {
        settingName: 'agent-mode-predefined-workplans',
        settingValue: JSON.stringify(devPlans)
      };

      mockPromise
        .mockResolvedValueOnce({ Item: prodSetting })
        .mockResolvedValueOnce({ Item: devSetting });

      const result = await settingsService.getPlanSyncStatus();

      expect(result['plan-1'].inSync).toBe(true);
      expect(result['plan-2'].existsInProd).toBe(true);
      expect(result['plan-2'].existsInDev).toBe(false);
    });

    it('should handle missing prod setting', async () => {
      const devSetting = {
        settingName: 'agent-mode-predefined-workplans',
        settingValue: JSON.stringify([plan1])
      };

      mockPromise
        .mockResolvedValueOnce({ Item: undefined })
        .mockResolvedValueOnce({ Item: devSetting });

      const result = await settingsService.getPlanSyncStatus();

      expect(result['plan-1']).toEqual({
        inSync: false,
        existsInProd: false,
        existsInDev: true,
        changedFields: []
      });
    });

    it('should handle missing dev setting', async () => {
      const prodSetting = {
        settingName: 'agent-mode-predefined-workplans',
        settingValue: JSON.stringify([plan1])
      };

      mockPromise
        .mockResolvedValueOnce({ Item: prodSetting })
        .mockResolvedValueOnce({ Item: undefined });

      const result = await settingsService.getPlanSyncStatus();

      expect(result['plan-1']).toEqual({
        inSync: false,
        existsInProd: true,
        existsInDev: false,
        changedFields: []
      });
    });

    it('should handle malformed JSON in prod', async () => {
      const prodSetting = {
        settingName: 'agent-mode-predefined-workplans',
        settingValue: 'invalid-json'
      };

      const devSetting = {
        settingName: 'agent-mode-predefined-workplans',
        settingValue: JSON.stringify([plan1])
      };

      mockPromise
        .mockResolvedValueOnce({ Item: prodSetting })
        .mockResolvedValueOnce({ Item: devSetting });

      const result = await settingsService.getPlanSyncStatus();

      // Should treat prod as empty array
      expect(result['plan-1']).toEqual({
        inSync: false,
        existsInProd: false,
        existsInDev: true,
        changedFields: []
      });
    });

    it('should detect all changed fields correctly', async () => {
      const prodPlan: PredefinedPlan = {
        id: 'plan-1',
        title: 'Title A',
        description: 'Desc A',
        welcomeMessage: 'Welcome A',
        autocomplete: true,
        requireLogin: false,
        showLoginSignup: 'always',
        showInAgentMode: true,
        defaultModel: 'model-a',
        steps: [{ stepCount: 1, title: 'Step 1' }]
      };

      const devPlan: PredefinedPlan = {
        id: 'plan-1',
        title: 'Title B',
        description: 'Desc B',
        welcomeMessage: 'Welcome B',
        autocomplete: false,
        requireLogin: true,
        showLoginSignup: 'never',
        showInAgentMode: false,
        defaultModel: 'model-b',
        steps: [{ stepCount: 1, title: 'Step 2' }]
      };

      const prodSetting = {
        settingName: 'agent-mode-predefined-workplans',
        settingValue: JSON.stringify([prodPlan])
      };

      const devSetting = {
        settingName: 'agent-mode-predefined-workplans',
        settingValue: JSON.stringify([devPlan])
      };

      mockPromise
        .mockResolvedValueOnce({ Item: prodSetting })
        .mockResolvedValueOnce({ Item: devSetting });

      const result = await settingsService.getPlanSyncStatus();

      expect(result['plan-1'].changedFields).toEqual(
        expect.arrayContaining([
          'title',
          'description',
          'welcomeMessage',
          'autocomplete',
          'requireLogin',
          'showLoginSignup',
          'showInAgentMode',
          'defaultModel',
          'steps'
        ])
      );
      expect(result['plan-1'].inSync).toBe(false);
    });
  });
});
