import { Request, Response } from 'express';
import { agentModeController } from '../controllers/agentModeController';
import { chatbotDb } from '../services/chatbotService';
import { settingsService } from '../services/settingsService';
import { agentModeService } from '../services/agentModeService';
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
    getChatSession: jest.fn(),
    addChatMessage: jest.fn(),
    addMessageToSession: jest.fn().mockResolvedValue({}),
    createOrReuseInteractiveShare: jest.fn().mockResolvedValue('https://example.com/ishare'),
  }
}));

jest.mock('../services/settingsService', () => ({
  settingsService: {
    getSetting: jest.fn()
  }
}));

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    getSupportedModels: jest.fn(),
    getDefaultModel: jest.fn()
  }
}));

jest.mock('../middleware/auth', () => ({
  getUserFromToken: jest.fn(),
  authenticateToken: jest.fn((req, res, next) => next())
}));

jest.mock('uuid', () => ({
  v4: jest.fn(() => 'mock-uuid-123')
}));

jest.mock('crypto', () => ({
  randomBytes: jest.fn(() => ({
    toString: jest.fn(() => 'mock-conversable-token-123')
  }))
}));

jest.mock('../utils/agentModeAlerts', () => ({
  sendAgentModeOncallAlert: jest.fn().mockResolvedValue(undefined)
}));

jest.mock('../services/generateMarketingResponseWorkerService', () => ({
  generateMarketingResponseWorkerService: {
    restartWorker: jest.fn().mockResolvedValue(undefined),
    runInWorker: jest.fn(),
    cancelSession: jest.fn(),
    ensureWorkerReady: jest.fn().mockResolvedValue(undefined),
    isWorkerHealthy: jest.fn().mockResolvedValue(true),
  }
}));

const mockChatbotDb = chatbotDb as jest.Mocked<typeof chatbotDb>;
const mockSettingsService = settingsService as jest.Mocked<typeof settingsService>;
const mockAgentModeService = agentModeService as jest.Mocked<typeof agentModeService>;
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

  const mockRequest = (planTitle: string, headers: Record<string, string> = {}, body: Record<string, any> = {}) => ({
    params: { planTitle },
    headers: {
      'content-type': 'application/json',
      ...headers
    },
    body
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

    // Mock agent mode service methods
    mockAgentModeService.getSupportedModels.mockResolvedValue(['gpt-5-chat', 'gemini-3-pro-preview', 'claude-opus-4']);
    mockAgentModeService.getDefaultModel.mockResolvedValue('gpt-5-chat');

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

    it('should store requireLogin when predefined plan sets it to true', async () => {
      const workPlansWithRequireLogin = [
        {
          title: 'Onboarding',
          steps: [
            {
              stepCount: 1,
              title: 'Step 1',
              description: 'First step'
            }
          ],
          requireLogin: true
        }
      ];
      mockSettingsService.getSetting.mockResolvedValue({
        settingKey: 'agent-mode-predefined-workplans',
        settingValue: JSON.stringify(workPlansWithRequireLogin)
      } as any);

      const req = mockRequest(mockPlanTitle);
      const res = mockResponse();

      await agentModeController.createSessionWithPlan(req, res);

      expect(mockChatbotDb.updateSessionWorkPlan).toHaveBeenCalledWith(
        'test-session-123',
        expect.objectContaining({
          title: 'Onboarding',
          requireLogin: true
        })
      );
    });

    it('should default requireLogin to false when not specified', async () => {
      const workPlansWithoutRequireLogin = [
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
        settingValue: JSON.stringify(workPlansWithoutRequireLogin)
      } as any);

      const req = mockRequest(mockPlanTitle);
      const res = mockResponse();

      await agentModeController.createSessionWithPlan(req, res);

      expect(mockChatbotDb.updateSessionWorkPlan).toHaveBeenCalledWith(
        'test-session-123',
        expect.objectContaining({
          title: 'Onboarding',
          requireLogin: false
        })
      );
    });
  });

  describe('Default model selection', () => {
    beforeEach(() => {
      mockGetUserFromToken.mockResolvedValue({ user: null });
      mockChatbotDb.createChatSession.mockResolvedValue(mockSession as any);
    });

    it('should use work plan default model when specified and valid', async () => {
      const workPlansWithDefaultModel = [
        {
          title: 'Onboarding',
          steps: [{ stepCount: 1, title: 'Step 1' }],
          defaultModel: 'gemini-3-pro-preview'
        }
      ];
      mockSettingsService.getSetting.mockResolvedValue({
        settingKey: 'agent-mode-predefined-workplans',
        settingValue: JSON.stringify(workPlansWithDefaultModel)
      } as any);

      const req = mockRequest(mockPlanTitle);
      const res = mockResponse();

      await agentModeController.createSessionWithPlan(req, res);

      expect(mockAgentModeService.getSupportedModels).toHaveBeenCalled();
      expect(mockChatbotDb.updateSessionLlmModel).toHaveBeenCalledWith(
        'test-session-123',
        'gemini-3-pro-preview'
      );
      expect(mockAgentModeService.getDefaultModel).not.toHaveBeenCalled();
    });

    it('should fall back to global default when work plan model is invalid', async () => {
      const workPlansWithInvalidModel = [
        {
          title: 'Onboarding',
          steps: [{ stepCount: 1, title: 'Step 1' }],
          defaultModel: 'invalid-model-name'
        }
      ];
      mockSettingsService.getSetting.mockResolvedValue({
        settingKey: 'agent-mode-predefined-workplans',
        settingValue: JSON.stringify(workPlansWithInvalidModel)
      } as any);

      const req = mockRequest(mockPlanTitle);
      const res = mockResponse();

      await agentModeController.createSessionWithPlan(req, res);

      expect(mockAgentModeService.getSupportedModels).toHaveBeenCalled();
      expect(mockAgentModeService.getDefaultModel).toHaveBeenCalled();
      expect(mockChatbotDb.updateSessionLlmModel).toHaveBeenCalledWith(
        'test-session-123',
        'gpt-5-chat' // The mocked default model
      );
    });

    it('should use global default when work plan has no default model', async () => {
      const workPlansWithoutDefaultModel = [
        {
          title: 'Onboarding',
          steps: [{ stepCount: 1, title: 'Step 1' }]
        }
      ];
      mockSettingsService.getSetting.mockResolvedValue({
        settingKey: 'agent-mode-predefined-workplans',
        settingValue: JSON.stringify(workPlansWithoutDefaultModel)
      } as any);

      const req = mockRequest(mockPlanTitle);
      const res = mockResponse();

      await agentModeController.createSessionWithPlan(req, res);

      expect(mockAgentModeService.getSupportedModels).not.toHaveBeenCalled();
      expect(mockAgentModeService.getDefaultModel).toHaveBeenCalled();
      expect(mockChatbotDb.updateSessionLlmModel).toHaveBeenCalledWith(
        'test-session-123',
        'gpt-5-chat'
      );
    });

    it('should use global default when work plan default model is empty string', async () => {
      const workPlansWithEmptyModel = [
        {
          title: 'Onboarding',
          steps: [{ stepCount: 1, title: 'Step 1' }],
          defaultModel: ''
        }
      ];
      mockSettingsService.getSetting.mockResolvedValue({
        settingKey: 'agent-mode-predefined-workplans',
        settingValue: JSON.stringify(workPlansWithEmptyModel)
      } as any);

      const req = mockRequest(mockPlanTitle);
      const res = mockResponse();

      await agentModeController.createSessionWithPlan(req, res);

      expect(mockAgentModeService.getSupportedModels).not.toHaveBeenCalled();
      expect(mockAgentModeService.getDefaultModel).toHaveBeenCalled();
      expect(mockChatbotDb.updateSessionLlmModel).toHaveBeenCalledWith(
        'test-session-123',
        'gpt-5-chat'
      );
    });

    it('should handle model validation when supported models list is empty', async () => {
      const workPlansWithDefaultModel = [
        {
          title: 'Onboarding',
          steps: [{ stepCount: 1, title: 'Step 1' }],
          defaultModel: 'some-model'
        }
      ];
      mockSettingsService.getSetting.mockResolvedValue({
        settingKey: 'agent-mode-predefined-workplans',
        settingValue: JSON.stringify(workPlansWithDefaultModel)
      } as any);
      mockAgentModeService.getSupportedModels.mockResolvedValue([]);

      const req = mockRequest(mockPlanTitle);
      const res = mockResponse();

      await agentModeController.createSessionWithPlan(req, res);

      expect(mockAgentModeService.getSupportedModels).toHaveBeenCalled();
      expect(mockAgentModeService.getDefaultModel).toHaveBeenCalled();
      expect(mockChatbotDb.updateSessionLlmModel).toHaveBeenCalledWith(
        'test-session-123',
        'gpt-5-chat'
      );
    });
  });

  describe('startingMessage handling', () => {
    beforeEach(() => {
      mockGetUserFromToken.mockResolvedValue({ user: null });
      mockChatbotDb.createChatSession.mockResolvedValue(mockSession as any);
      // getChatSession is called by generateSessionResponse (fire-and-forget)
      mockChatbotDb.getChatSession = jest.fn().mockResolvedValue({
        ...mockSession,
        messages: []
      });
    });

    it('should return response immediately when startingMessage is provided', async () => {
      const req = mockRequest(mockPlanTitle, {}, { startingMessage: 'firstName is Rui, company is AgentWeb' });
      const res = mockResponse();

      await agentModeController.createSessionWithPlan(req, res);

      // Response should be sent with session data
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'test-session-123',
        conversableToken: 'mock-conversable-token-123'
      }));
    });

    it('should fire-and-forget generateSessionResponse when startingMessage is provided', async () => {
      const req = mockRequest(mockPlanTitle, {}, { startingMessage: 'firstName is Rui, company is AgentWeb' });
      const res = mockResponse();

      await agentModeController.createSessionWithPlan(req, res);

      // Wait for the fire-and-forget promise to start executing
      await new Promise(resolve => setTimeout(resolve, 50));

      // generateSessionResponse calls getChatSession as its first operation
      expect(mockChatbotDb.getChatSession).toHaveBeenCalledWith('test-session-123');
    });

    it('should not call generateSessionResponse when startingMessage is not provided', async () => {
      const req = mockRequest(mockPlanTitle);
      const res = mockResponse();

      await agentModeController.createSessionWithPlan(req, res);

      // Wait to ensure no async call was made
      await new Promise(resolve => setTimeout(resolve, 50));

      // getChatSession should NOT be called (no fire-and-forget)
      expect(mockChatbotDb.getChatSession).not.toHaveBeenCalled();
    });

    it('should not call generateSessionResponse when startingMessage is empty string', async () => {
      const req = mockRequest(mockPlanTitle, {}, { startingMessage: '' });
      const res = mockResponse();

      await agentModeController.createSessionWithPlan(req, res);

      await new Promise(resolve => setTimeout(resolve, 50));

      expect(mockChatbotDb.getChatSession).not.toHaveBeenCalled();
    });

    it('should not call generateSessionResponse when startingMessage is whitespace only', async () => {
      const req = mockRequest(mockPlanTitle, {}, { startingMessage: '   ' });
      const res = mockResponse();

      await agentModeController.createSessionWithPlan(req, res);

      await new Promise(resolve => setTimeout(resolve, 50));

      expect(mockChatbotDb.getChatSession).not.toHaveBeenCalled();
    });

    it('should not call generateSessionResponse when startingMessage is not a string', async () => {
      const req = mockRequest(mockPlanTitle, {}, { startingMessage: 123 });
      const res = mockResponse();

      await agentModeController.createSessionWithPlan(req, res);

      await new Promise(resolve => setTimeout(resolve, 50));

      expect(mockChatbotDb.getChatSession).not.toHaveBeenCalled();
    });

    it('should handle generateSessionResponse failure gracefully', async () => {
      // Make getChatSession throw to simulate generateSessionResponse failure
      mockChatbotDb.getChatSession = jest.fn().mockRejectedValue(new Error('Session not found'));
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      const req = mockRequest(mockPlanTitle, {}, { startingMessage: 'firstName is Rui' });
      const res = mockResponse();

      await agentModeController.createSessionWithPlan(req, res);

      // Response should still be sent successfully
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'test-session-123'
      }));

      // Wait for the fire-and-forget to execute, fail, restart worker, wait 3s, and retry
      await new Promise(resolve => setTimeout(resolve, 4000));

      // First failure should be logged as warning
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('First attempt failed for session test-session-123')
      );

      // Retry failure should be logged as error
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Retry also failed for session test-session-123')
      );

      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }, 10000);

    it('should handle missing req.body gracefully', async () => {
      // Create request without body property
      const req = {
        params: { planTitle: mockPlanTitle },
        headers: { 'content-type': 'application/json' }
      } as unknown as Request;
      const res = mockResponse();

      await agentModeController.createSessionWithPlan(req, res);

      // Should still return response successfully
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'test-session-123'
      }));

      await new Promise(resolve => setTimeout(resolve, 50));

      // No fire-and-forget should have been triggered
      expect(mockChatbotDb.getChatSession).not.toHaveBeenCalled();
    });
  });
});
