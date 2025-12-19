import { Request, Response } from 'express';
import { agentModeController } from '../controllers/agentModeController';
import { chatbotDb } from '../services/chatbotService';
import { settingsService } from '../services/settingsService';
import { getUserFromToken } from '../middleware/auth';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';

// Mock dependencies
jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    createChatSession: jest.fn(),
    updateSessionWorkPlan: jest.fn(),
    updateSessionInteractiveShareMetadata: jest.fn(),
    updateSessionLlmModel: jest.fn(),
  }
}));

jest.mock('../services/settingsService', () => ({
  settingsService: {
    getSetting: jest.fn()
  }
}));

jest.mock('../middleware/auth', () => ({
  getUserFromToken: jest.fn()
}));

jest.mock('uuid', () => ({
  v4: jest.fn(() => 'mock-uuid-123')
}));

jest.mock('crypto', () => ({
  randomBytes: jest.fn(() => ({
    toString: jest.fn(() => 'mock-conversable-token-123')
  }))
}));

const mockChatbotDb = chatbotDb as jest.Mocked<typeof chatbotDb>;
const mockSettingsService = settingsService as jest.Mocked<typeof settingsService>;
const mockGetUserFromToken = getUserFromToken as jest.MockedFunction<typeof getUserFromToken>;

describe('AgentModeController - createSessionWithPlan', () => {
  const mockPlanTitle = 'Onboarding';
  const mockWorkPlans = [
    {
      title: 'Onboarding',
      steps: [
        {
          stepCount: 1,
          title: 'Step 1',
          description: 'First step',
          requiredFunctionCalls: ['function1']
        },
        {
          stepCount: 2,
          title: 'Step 2',
          description: 'Second step'
        }
      ],
      welcomeMessage: 'Welcome to onboarding!'
    }
  ];

  const mockSession = {
    sessionId: 'test-session-123',
    userId: 'test-user-123',
    title: 'New Chat Session',
    messages: [],
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    portalType: 'agent' as const,
    pageIdentifier: `plan-${mockPlanTitle}`
  };

  const mockRequest = (planTitle: string, headers: Record<string, string> = {}) => ({
    params: { planTitle },
    headers: {
      'content-type': 'application/json',
      ...headers
    }
  } as unknown as Request);

  const mockResponse = () => {
    const res: any = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    return res as Response;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CUSTOMER_FRONTEND_URL = 'http://localhost:5174';
    
    // Default mock for settings
    mockSettingsService.getSetting.mockResolvedValue({
      settingKey: 'agent-mode-predefined-workplans',
      settingValue: JSON.stringify(mockWorkPlans)
    } as any);
    
    // Mock updateSessionLlmModel to return session with llmModel
    mockChatbotDb.updateSessionLlmModel = jest.fn().mockImplementation((sessionId, llmModel) => {
      return Promise.resolve({
        ...mockSession,
        sessionId,
        llmModel,
      } as any);
    });
  });

  describe('User ID handling', () => {
    it('should use authenticated user ID when token is valid', async () => {
      const authenticatedUser = {
        user: {
          userId: 'authenticated-user-123',
          email: 'user@example.com',
          isAdmin: false,
          roles: ['customer'] as ('partner' | 'customer' | 'free')[]
        }
      };
      mockGetUserFromToken.mockResolvedValue(authenticatedUser);
      mockChatbotDb.createChatSession.mockResolvedValue({
        ...mockSession,
        userId: 'authenticated-user-123'
      } as any);

      const req = mockRequest(mockPlanTitle, {
        'authorization': 'Bearer valid-token'
      });
      const res = mockResponse();

      await agentModeController.createSessionWithPlan(req, res);

      expect(mockGetUserFromToken).toHaveBeenCalledWith(req);
      expect(mockChatbotDb.createChatSession).toHaveBeenCalledWith(
        'authenticated-user-123',
        undefined,
        'agent',
        `plan-${mockPlanTitle}`,
        undefined,
        undefined,
        undefined,
        undefined,
        'predefined-work-plan'
      );
      expect(res.json).toHaveBeenCalled();
    });

    it('should use anonymous user ID when no token is provided', async () => {
      mockGetUserFromToken.mockResolvedValue({ user: null });
      mockChatbotDb.createChatSession.mockResolvedValue({
        ...mockSession,
        userId: 'anon_mock-uuid-123'
      } as any);

      const req = mockRequest(mockPlanTitle);
      const res = mockResponse();

      await agentModeController.createSessionWithPlan(req, res);

      expect(mockGetUserFromToken).toHaveBeenCalledWith(req);
      expect(mockChatbotDb.createChatSession).toHaveBeenCalledWith(
        'anon_mock-uuid-123',
        undefined,
        'agent',
        `plan-${mockPlanTitle}`,
        undefined,
        undefined,
        undefined,
        undefined,
        'predefined-work-plan'
      );
      expect(res.json).toHaveBeenCalled();
    });

    it('should use anonymous user ID when token is invalid', async () => {
      mockGetUserFromToken.mockResolvedValue({ user: null });
      mockChatbotDb.createChatSession.mockResolvedValue({
        ...mockSession,
        userId: 'anon_mock-uuid-123'
      } as any);

      const req = mockRequest(mockPlanTitle, {
        'authorization': 'Bearer invalid-token'
      });
      const res = mockResponse();

      await agentModeController.createSessionWithPlan(req, res);

      expect(mockGetUserFromToken).toHaveBeenCalledWith(req);
      expect(mockChatbotDb.createChatSession).toHaveBeenCalledWith(
        'anon_mock-uuid-123',
        undefined,
        'agent',
        `plan-${mockPlanTitle}`,
        undefined,
        undefined,
        undefined,
        undefined,
        'predefined-work-plan'
      );
      expect(res.json).toHaveBeenCalled();
    });

    it('should use anonymous user ID when user is not found', async () => {
      mockGetUserFromToken.mockResolvedValue({ user: null });
      mockChatbotDb.createChatSession.mockResolvedValue({
        ...mockSession,
        userId: 'anon_mock-uuid-123'
      } as any);

      const req = mockRequest(mockPlanTitle, {
        'authorization': 'Bearer token-for-nonexistent-user'
      });
      const res = mockResponse();

      await agentModeController.createSessionWithPlan(req, res);

      expect(mockGetUserFromToken).toHaveBeenCalledWith(req);
      expect(mockChatbotDb.createChatSession).toHaveBeenCalledWith(
        'anon_mock-uuid-123',
        undefined,
        'agent',
        `plan-${mockPlanTitle}`,
        undefined,
        undefined,
        undefined,
        undefined,
        'predefined-work-plan'
      );
      expect(res.json).toHaveBeenCalled();
    });

    it('should handle delegate access tokens correctly', async () => {
      const delegateUser = {
        user: {
          userId: 'target-user-123',
          email: 'target@example.com',
          isAdmin: false,
          roles: ['customer'] as ('partner' | 'customer' | 'free')[]
        },
        decoded: {
          userId: 'admin-user-123',
          email: 'admin@example.com',
          isAdmin: true,
          delegateAccess: {
            adminUserId: 'admin-user-123',
            adminEmail: 'admin@example.com',
            targetUserId: 'target-user-123',
            targetEmail: 'target@example.com'
          }
        } as any,
        adminUser: {
          userId: 'admin-user-123',
          email: 'admin@example.com'
        }
      };
      mockGetUserFromToken.mockResolvedValue(delegateUser);
      mockChatbotDb.createChatSession.mockResolvedValue({
        ...mockSession,
        userId: 'target-user-123'
      } as any);

      const req = mockRequest(mockPlanTitle, {
        'authorization': 'Bearer delegate-token'
      });
      const res = mockResponse();

      await agentModeController.createSessionWithPlan(req, res);

      expect(mockGetUserFromToken).toHaveBeenCalledWith(req);
      expect(mockChatbotDb.createChatSession).toHaveBeenCalledWith(
        'target-user-123',
        undefined,
        'agent',
        `plan-${mockPlanTitle}`,
        undefined,
        undefined,
        undefined,
        undefined,
        'predefined-work-plan'
      );
      expect(res.json).toHaveBeenCalled();
    });
  });

  describe('Session creation', () => {
    beforeEach(() => {
      mockGetUserFromToken.mockResolvedValue({ user: null });
      mockChatbotDb.createChatSession.mockResolvedValue(mockSession as any);
    });

    it('should create session with work plan', async () => {
      const req = mockRequest(mockPlanTitle);
      const res = mockResponse();

      await agentModeController.createSessionWithPlan(req, res);

      expect(mockChatbotDb.createChatSession).toHaveBeenCalled();
      expect(mockChatbotDb.updateSessionWorkPlan).toHaveBeenCalledWith(
        'test-session-123',
        expect.objectContaining({
          title: 'Onboarding',
          steps: expect.arrayContaining([
            expect.objectContaining({
              stepCount: 1,
              title: 'Step 1',
              description: 'First step',
              status: 'pending',
              requiredFunctionCalls: ['function1']
            }),
            expect.objectContaining({
              stepCount: 2,
              title: 'Step 2',
              description: 'Second step',
              status: 'pending'
            })
          ]),
          welcomeMessage: 'Welcome to onboarding!',
          autocomplete: false,
          showLoginSignup: 'after_plan_completed'
        })
      );
      expect(mockChatbotDb.updateSessionInteractiveShareMetadata).toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith({
        sessionId: 'test-session-123',
        redirectUrl: expect.stringContaining('/plan/Onboarding/test-session-123'),
        workPlan: expect.objectContaining({
          title: 'Onboarding',
          welcomeMessage: 'Welcome to onboarding!'
        }),
        conversableToken: 'mock-conversable-token-123',
        userId: 'test-user-123'
      });
    });

    it('should return 400 when planTitle is missing', async () => {
      const req = mockRequest('');
      const res = mockResponse();

      await agentModeController.createSessionWithPlan(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'Plan title is required' });
      expect(mockChatbotDb.createChatSession).not.toHaveBeenCalled();
    });

    it('should return 404 when no predefined work plans found', async () => {
      mockSettingsService.getSetting.mockResolvedValue(null);

      const req = mockRequest(mockPlanTitle);
      const res = mockResponse();

      await agentModeController.createSessionWithPlan(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ error: 'No predefined work plans found' });
      expect(mockChatbotDb.createChatSession).not.toHaveBeenCalled();
    });

    it('should return 404 when work plan not found', async () => {
      const req = mockRequest('NonExistentPlan');
      const res = mockResponse();

      await agentModeController.createSessionWithPlan(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ error: 'Work plan "NonExistentPlan" not found' });
      expect(mockChatbotDb.createChatSession).not.toHaveBeenCalled();
    });

    it('should handle case-insensitive plan title matching', async () => {
      const req = mockRequest('ONBOARDING');
      const res = mockResponse();

      await agentModeController.createSessionWithPlan(req, res);

      expect(mockChatbotDb.createChatSession).toHaveBeenCalled();
      expect(res.json).toHaveBeenCalled();
    });

    it('should handle errors gracefully', async () => {
      mockChatbotDb.createChatSession.mockRejectedValue(new Error('Database error'));

      const req = mockRequest(mockPlanTitle);
      const res = mockResponse();

      await agentModeController.createSessionWithPlan(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: 'Failed to create session with plan' });
    });

    it('should store autocomplete when predefined plan has autocomplete enabled', async () => {
      // Update mock work plans to include autocomplete: true
      const workPlansWithAutocomplete = [
        {
          title: 'Onboarding',
          steps: [
            {
              stepCount: 1,
              title: 'Step 1',
              description: 'First step',
              requiredFunctionCalls: ['function1']
            },
            {
              stepCount: 2,
              title: 'Step 2',
              description: 'Second step'
            }
          ],
          welcomeMessage: 'Welcome to onboarding!',
          autocomplete: true
        }
      ];
      mockSettingsService.getSetting.mockResolvedValue({
        settingKey: 'agent-mode-predefined-workplans',
        settingValue: JSON.stringify(workPlansWithAutocomplete)
      } as any);

      const req = mockRequest(mockPlanTitle);
      const res = mockResponse();

      await agentModeController.createSessionWithPlan(req, res);

      expect(mockChatbotDb.updateSessionWorkPlan).toHaveBeenCalledWith(
        'test-session-123',
        expect.objectContaining({
          title: 'Onboarding',
          autocomplete: true
        })
      );
    });

    it('should default autocomplete to false when not specified in predefined plan', async () => {
      // Work plan without autocomplete field
      const workPlansWithoutAutocomplete = [
        {
          title: 'Onboarding',
          steps: [
            {
              stepCount: 1,
              title: 'Step 1',
              description: 'First step'
            }
          ],
          welcomeMessage: 'Welcome!'
          // autocomplete is not specified
        }
      ];
      mockSettingsService.getSetting.mockResolvedValue({
        settingKey: 'agent-mode-predefined-workplans',
        settingValue: JSON.stringify(workPlansWithoutAutocomplete)
      } as any);

      const req = mockRequest(mockPlanTitle);
      const res = mockResponse();

      await agentModeController.createSessionWithPlan(req, res);

      expect(mockChatbotDb.updateSessionWorkPlan).toHaveBeenCalledWith(
        'test-session-123',
        expect.objectContaining({
          title: 'Onboarding',
          autocomplete: false
        })
      );
    });

    it('should store showLoginSignup when predefined plan sets it to always', async () => {
      const workPlansWithLoginSignup = [
        {
          title: 'Onboarding',
          steps: [
            {
              stepCount: 1,
              title: 'Step 1',
              description: 'First step'
            }
          ],
          showLoginSignup: 'always'
        }
      ];
      mockSettingsService.getSetting.mockResolvedValue({
        settingKey: 'agent-mode-predefined-workplans',
        settingValue: JSON.stringify(workPlansWithLoginSignup)
      } as any);

      const req = mockRequest(mockPlanTitle);
      const res = mockResponse();

      await agentModeController.createSessionWithPlan(req, res);

      expect(mockChatbotDb.updateSessionWorkPlan).toHaveBeenCalledWith(
        'test-session-123',
        expect.objectContaining({
          title: 'Onboarding',
          showLoginSignup: 'always'
        })
      );
    });

    it('should default showLoginSignup to after_plan_completed when not specified', async () => {
      const workPlansWithoutLoginSignup = [
        {
          title: 'Onboarding',
          steps: [
            {
              stepCount: 1,
              title: 'Step 1',
              description: 'First step'
            }
          ]
        }
      ];
      mockSettingsService.getSetting.mockResolvedValue({
        settingKey: 'agent-mode-predefined-workplans',
        settingValue: JSON.stringify(workPlansWithoutLoginSignup)
      } as any);

      const req = mockRequest(mockPlanTitle);
      const res = mockResponse();

      await agentModeController.createSessionWithPlan(req, res);

      expect(mockChatbotDb.updateSessionWorkPlan).toHaveBeenCalledWith(
        'test-session-123',
        expect.objectContaining({
          title: 'Onboarding',
          showLoginSignup: 'after_plan_completed'
        })
      );
    });
  });
});
