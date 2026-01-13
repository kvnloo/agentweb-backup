import { Request, Response } from 'express';
import { agentModeController } from '../controllers/agentModeController';
import { settingsService } from '../services/settingsService';

// Mock dependencies
jest.mock('../services/settingsService', () => ({
  settingsService: {
    getSetting: jest.fn()
  }
}));

const mockSettingsService = settingsService as jest.Mocked<typeof settingsService>;

describe('AgentModeController - getAllPredefinedWorkPlans', () => {
  const mockRequest = () => ({} as Request);

  const mockResponse = () => {
    const res: any = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    return res as Response;
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return all predefined work plans', async () => {
    const mockWorkPlans = [
      {
        id: 'plan-1',
        title: 'Onboarding',
        description: 'Get started with our platform',
        steps: [
          {
            stepCount: 1,
            title: 'Step 1',
            description: 'First step',
            requiredFunctionCalls: ['function1']
          }
        ],
        welcomeMessage: 'Welcome!'
      },
      {
        id: 'plan-2',
        title: 'Marketing Strategy',
        description: 'Create a marketing strategy',
        steps: [
          {
            stepCount: 1,
            title: 'Analyze market',
            requiredFunctionCalls: ['analyze_market']
          }
        ]
      }
    ];

    mockSettingsService.getSetting.mockResolvedValue({
      settingKey: 'agent-mode-predefined-workplans',
      settingValue: JSON.stringify(mockWorkPlans)
    } as any);

    const req = mockRequest();
    const res = mockResponse();

    await agentModeController.getAllPredefinedWorkPlans(req, res);

    expect(mockSettingsService.getSetting).toHaveBeenCalledWith('agent-mode-predefined-workplans');
    expect(res.json).toHaveBeenCalledWith(mockWorkPlans);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('should return empty array when no work plans exist', async () => {
    mockSettingsService.getSetting.mockResolvedValue(null);

    const req = mockRequest();
    const res = mockResponse();

    await agentModeController.getAllPredefinedWorkPlans(req, res);

    expect(mockSettingsService.getSetting).toHaveBeenCalledWith('agent-mode-predefined-workplans');
    expect(res.json).toHaveBeenCalledWith([]);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('should return empty array when setting value is empty', async () => {
    mockSettingsService.getSetting.mockResolvedValue({
      settingKey: 'agent-mode-predefined-workplans',
      settingValue: null
    } as any);

    const req = mockRequest();
    const res = mockResponse();

    await agentModeController.getAllPredefinedWorkPlans(req, res);

    expect(res.json).toHaveBeenCalledWith([]);
  });

  it('should handle errors gracefully', async () => {
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockSettingsService.getSetting.mockRejectedValue(new Error('Database error'));

    const req = mockRequest();
    const res = mockResponse();

    await agentModeController.getAllPredefinedWorkPlans(req, res);

    expect(consoleErrorSpy).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'Failed to get all predefined work plans' });

    consoleErrorSpy.mockRestore();
  });
});
