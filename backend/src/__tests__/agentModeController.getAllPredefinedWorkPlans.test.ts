import { Request, Response } from 'express';
import { agentModeController } from '../controllers/agentModeController';
import { workPlanService } from '../services/workPlanService';
import { getUserFromToken } from '../middleware/auth';

// Mock dependencies
jest.mock('../services/workPlanService', () => ({
  workPlanService: {
    getPublicPlansForAgentMode: jest.fn(),
    getWorkPlansByOwner: jest.fn(),
  }
}));

jest.mock('../middleware/auth', () => ({
  getUserFromToken: jest.fn(),
  authenticateToken: jest.fn(),
  isAdmin: jest.fn(),
}));

const mockWorkPlanService = workPlanService as jest.Mocked<typeof workPlanService>;
const mockGetUserFromToken = getUserFromToken as jest.MockedFunction<typeof getUserFromToken>;

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
    // Default: unauthenticated user
    mockGetUserFromToken.mockResolvedValue({ user: null });
  });

  it('should return plans from workPlanService with legacy shape', async () => {
    const mockPlans = [
      {
        planId: 'plan-1',
        title: 'Onboarding',
        description: 'Get started with our platform',
        steps: [{ stepCount: 1, title: 'Step 1', description: 'First step', requiredFunctionCalls: ['function1'] }],
        welcomeMessage: 'Welcome!',
        showInAgentMode: true,
        visibility: 'system' as const,
        isBuiltIn: true,
        createdAt: '2026-01-01',
        updatedAt: '2026-01-01',
      },
      {
        planId: 'plan-3',
        title: 'Content Creation',
        description: 'Create content',
        steps: [{ stepCount: 1, title: 'Create content', requiredFunctionCalls: ['create_content'] }],
        showInAgentMode: true,
        visibility: 'public' as const,
        isBuiltIn: false,
        createdAt: '2026-01-01',
        updatedAt: '2026-01-01',
      }
    ];

    mockWorkPlanService.getPublicPlansForAgentMode.mockResolvedValue(mockPlans);

    const req = mockRequest();
    const res = mockResponse();

    await agentModeController.getAllPredefinedWorkPlans(req, res);

    expect(mockWorkPlanService.getPublicPlansForAgentMode).toHaveBeenCalled();
    // Should map planId to id for legacy compatibility
    const result = (res.json as jest.Mock).mock.calls[0][0];
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('plan-1');
    expect(result[0].title).toBe('Onboarding');
    expect(result[1].id).toBe('plan-3');
    expect(res.status).not.toHaveBeenCalled();
  });

  it('should return empty array when no work plans exist', async () => {
    mockWorkPlanService.getPublicPlansForAgentMode.mockResolvedValue([]);

    const req = mockRequest();
    const res = mockResponse();

    await agentModeController.getAllPredefinedWorkPlans(req, res);

    expect(res.json).toHaveBeenCalledWith([]);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('should include user private plans when authenticated', async () => {
    const publicPlan = {
      planId: 'plan-1',
      title: 'Onboarding',
      description: 'Public plan',
      steps: [{ stepCount: 1, title: 'Step 1', requiredFunctionCalls: [] }],
      showInAgentMode: true,
      visibility: 'system' as const,
      isBuiltIn: true,
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
    };
    const privatePlan = {
      planId: 'plan-private',
      title: 'My Private Plan',
      description: 'Private plan',
      steps: [{ stepCount: 1, title: 'Step 1', requiredFunctionCalls: [] }],
      showInAgentMode: true,
      visibility: 'private' as const,
      isBuiltIn: false,
      ownerId: 'user-123',
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
    };

    mockWorkPlanService.getPublicPlansForAgentMode.mockResolvedValue([publicPlan]);
    mockGetUserFromToken.mockResolvedValue({ user: { userId: 'user-123', email: 'test@example.com' } } as any);
    mockWorkPlanService.getWorkPlansByOwner.mockResolvedValue([privatePlan]);

    const req = mockRequest();
    const res = mockResponse();

    await agentModeController.getAllPredefinedWorkPlans(req, res);

    const result = (res.json as jest.Mock).mock.calls[0][0];
    expect(result).toHaveLength(2);
    // Private plans come first (user's own plans take priority)
    expect(result[0].id).toBe('plan-private');
    expect(result[0].visibility).toBe('private');
    expect(result[1].id).toBe('plan-1');
    expect(result[1].visibility).toBe('system');
  });

  it('should not include private plans for unauthenticated users', async () => {
    mockWorkPlanService.getPublicPlansForAgentMode.mockResolvedValue([]);
    mockGetUserFromToken.mockResolvedValue({ user: null });

    const req = mockRequest();
    const res = mockResponse();

    await agentModeController.getAllPredefinedWorkPlans(req, res);

    expect(mockWorkPlanService.getWorkPlansByOwner).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith([]);
  });

  it('should handle errors gracefully', async () => {
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockWorkPlanService.getPublicPlansForAgentMode.mockRejectedValue(new Error('Database error'));

    const req = mockRequest();
    const res = mockResponse();

    await agentModeController.getAllPredefinedWorkPlans(req, res);

    expect(consoleErrorSpy).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'Failed to get all predefined work plans' });

    consoleErrorSpy.mockRestore();
  });
});
