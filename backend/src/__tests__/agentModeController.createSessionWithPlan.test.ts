import { Request, Response } from 'express';
import { agentModeController } from '../controllers/agentModeController';
import { chatbotDb } from '../services/chatbotService';
import { workPlanService } from '../services/workPlanService';
import { agentModeService } from '../services/agentModeService';
import { getUserFromToken } from '../middleware/auth';
import { userDb } from '../services/db';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';

// Mock dependencies
jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    createChatSession: jest.fn(),
    updateSessionWorkPlan: jest.fn(),
    updateSessionInteractiveShareMetadata: jest.fn(),
    updateSessionWorkPlanInputRequest: jest.fn().mockResolvedValue(undefined),
    updateSessionLlmModel: jest.fn(),
    getChatSession: jest.fn(),
    addChatMessage: jest.fn(),
    addMessageToSession: jest.fn().mockResolvedValue({}),
    addAssociatedSkills: jest.fn().mockResolvedValue(undefined),
    createOrReuseInteractiveShare: jest.fn().mockResolvedValue('https://example.com/ishare'),
  }
}));

jest.mock('../services/workPlanService', () => ({
  workPlanService: {
    getWorkPlansByVisibility: jest.fn(),
    getWorkPlansByOwner: jest.fn(),
    getWorkPlansByOrg: jest.fn(),
  }
}));

jest.mock('../services/db', () => ({
  userDb: { getUserById: jest.fn() },
}));

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    getSupportedModels: jest.fn(),
    getDefaultModel: jest.fn(),
    // ENG-903: registry doubles - the plan pin is resolved with the shared pin rules.
    resolveGenerationModel: jest.fn(),
    isModelSelectableBy: jest.fn(),
    getModelDisplayName: jest.fn(),
  },
  // ENG-1802: the controller now imports the real title-normalization helper
  // directly (not through the agentModeService object above), so this module
  // mock must still provide it -- pull in the real implementation rather than
  // stubbing it, since it's a pure string helper the title-matching tests
  // below rely on behaving correctly.
  normalizeWorkPlanTitleForMatch: jest.requireActual('../services/agentModeService').normalizeWorkPlanTitleForMatch,
}));

jest.mock('../middleware/auth', () => ({
  getUserFromToken: jest.fn(),
  authenticateToken: jest.fn((req, res, next) => next())
}));

jest.mock('uuid', () => ({
  v4: jest.fn(() => 'mock-uuid-123')
}));

jest.mock('crypto', () => ({
  ...jest.requireActual('crypto'),
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
const mockWorkPlanService = workPlanService as jest.Mocked<typeof workPlanService>;
const mockAgentModeService = agentModeService as jest.Mocked<typeof agentModeService>;
const mockGetUserFromToken = getUserFromToken as jest.MockedFunction<typeof getUserFromToken>;
const mockUserDb = userDb as jest.Mocked<typeof userDb>;

describe('AgentModeController - createSessionWithPlan', () => {
  const mockPlanTitle = 'Onboarding';
  const mockWorkPlans = [
    {
      planId: 'plan-123',
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
      visibility: 'system' as const,
      isBuiltIn: true,
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z'
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

    // Default mock for work plan service - return mockWorkPlans for 'system', empty array for 'public'
    mockWorkPlanService.getWorkPlansByVisibility.mockImplementation((visibility: string) => {
      if (visibility === 'system') {
        return Promise.resolve(mockWorkPlans);
      }
      return Promise.resolve([]);
    });

    // Default: no private plans for authenticated users
    mockWorkPlanService.getWorkPlansByOwner.mockResolvedValue([]);
    mockWorkPlanService.getWorkPlansByOrg.mockResolvedValue([]);
    mockUserDb.getUserById.mockResolvedValue(undefined);

    // Mock agent mode service methods
    mockAgentModeService.getSupportedModels.mockResolvedValue(['gpt-5-chat', 'gemini-3-pro-preview', 'claude-opus-4']);
    mockAgentModeService.getDefaultModel.mockResolvedValue('gpt-5-chat');
    // Registry: three served ids + one honoured alias; admin-only / internal-only / live ids.
    const REG = new Set(['gpt-5-chat', 'gemini-3-pro-preview', 'claude-opus-4', 'admin-only-model', 'internal-judge', 'live-voice']);
    (mockAgentModeService.resolveGenerationModel as jest.Mock).mockImplementation((m: string) => {
      const n = m === 'legacy-alias' ? 'gemini-3-pro-preview' : m;
      return REG.has(n) ? { model: n, fellBack: false, requestedModel: m } : { model: 'gpt-5-chat', fellBack: true, requestedModel: m };
    });
    (mockAgentModeService.isModelSelectableBy as jest.Mock).mockImplementation((m: string, admin: boolean) => {
      if (m === 'internal-judge' || m === 'live-voice') return false;
      if (m === 'admin-only-model') return admin;
      return true;
    });

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

    // ENG-1331: this route was the only predefined-plan session-creation path that
    // dropped expectedAssetCount on the floor — its sibling instantiation path
    // (agentModeService.ts applyPredefinedWorkPlan) already carried it through. A
    // template step declaring expectedAssetCount had nothing to enforce once a
    // session was created via this route, which is confirmed (by pageIdentifier
    // pattern) to be the exact route the production incident session used.
    it('carries expectedAssetCount and expectedAssetCountTools from the template step into the session work plan (ENG-1331)', async () => {
      mockWorkPlanService.getWorkPlansByVisibility.mockImplementation((visibility: string) =>
        Promise.resolve(
          visibility === 'system'
            ? [
                {
                  ...mockWorkPlans[0],
                  steps: [
                    { stepCount: 1, title: 'Step 1', description: 'First step', requiredFunctionCalls: ['function1'] },
                    {
                      stepCount: 2,
                      title: 'Render Sizes',
                      description: 'Render the matrix',
                      expectedAssetCount: 12,
                      expectedAssetCountTools: ['playwright_browser_take_screenshot'],
                    },
                  ],
                },
              ]
            : []
        )
      );
      const req = mockRequest(mockPlanTitle);
      const res = mockResponse();

      await agentModeController.createSessionWithPlan(req, res);

      expect(mockChatbotDb.updateSessionWorkPlan).toHaveBeenCalledWith(
        'test-session-123',
        expect.objectContaining({
          steps: expect.arrayContaining([
            expect.objectContaining({
              stepCount: 2,
              title: 'Render Sizes',
              expectedAssetCount: 12,
              expectedAssetCountTools: ['playwright_browser_take_screenshot'],
            }),
          ]),
        })
      );
    });

    it('omits expectedAssetCount and expectedAssetCountTools when the template step does not declare them', async () => {
      const req = mockRequest(mockPlanTitle);
      const res = mockResponse();

      await agentModeController.createSessionWithPlan(req, res);

      const call = mockChatbotDb.updateSessionWorkPlan.mock.calls.find((c) => c[0] === 'test-session-123');
      const steps = (call?.[1] as any)?.steps ?? [];
      for (const step of steps) {
        expect(step).not.toHaveProperty('expectedAssetCount');
        expect(step).not.toHaveProperty('expectedAssetCountTools');
      }
    });

    // ENG-508/ENG-867: the Founder LinkedIn audit plan carries the "LinkedIn Profile
    // Reader" skill on its profile-extraction step. Creating a session from the plan
    // must auto-install that skill, because tool filtering is computed at the start of
    // each message — if the skill were not installed upfront, linkedin_outreach would
    // be unavailable and the model would fall back to the stale you_search_web cache.
    it('auto-installs a step skillId so the authenticated LinkedIn tool is available (ENG-508)', async () => {
      const PROFILE_READER_ID = '73ad4f6b-813d-4c56-bb9f-9e7abd89ab04';
      mockWorkPlanService.getWorkPlansByVisibility.mockImplementation((visibility: string) =>
        Promise.resolve(
          visibility === 'system'
            ? [
                {
                  ...mockWorkPlans[0],
                  steps: [
                    { stepCount: 1, title: 'ICP Info Collection', description: 'First step' },
                    {
                      stepCount: 2,
                      title: 'Scoring + Report',
                      description: 'Extract Profile Data (authenticated, live)',
                      requiredFunctionCalls: ['create_html_file', 'linkedin_outreach'],
                      skillIds: [PROFILE_READER_ID],
                    },
                  ],
                },
              ]
            : []
        ) as any
      );

      const req = mockRequest(mockPlanTitle);
      const res = mockResponse();

      await agentModeController.createSessionWithPlan(req, res);

      expect(mockChatbotDb.addAssociatedSkills).toHaveBeenCalledWith(
        'test-session-123',
        expect.arrayContaining([PROFILE_READER_ID])
      );
    });

    it('should return 400 when planTitle is missing', async () => {
      const req = mockRequest('');
      const res = mockResponse();

      await agentModeController.createSessionWithPlan(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'Plan title is required' });
      expect(mockChatbotDb.createChatSession).not.toHaveBeenCalled();
    });

    it('should return 404 when no work plans exist', async () => {
      mockWorkPlanService.getWorkPlansByVisibility.mockResolvedValue([]);

      const req = mockRequest(mockPlanTitle);
      const res = mockResponse();

      await agentModeController.createSessionWithPlan(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ error: 'Work plan "Onboarding" not found' });
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

    // ENG-1802: the URL param match used to be `.toLowerCase()` only, so a
    // template stored with an underscore-joined title (the common shape) never
    // resolved from a naturally-typed, spaced :planTitle URL param. Switched to
    // normalizeWorkPlanTitleForMatch, the same separator/case normalization
    // applyPredefinedWorkPlan already uses (ENG-1794).
    it('resolves a stored underscore-joined title against a spaced, mixed-case :planTitle param (ENG-1802)', async () => {
      const underscoredPlans = [
        {
          planId: 'plan-underscored',
          title: 'Founder_Linkedin_Sales_Readiness_Audit',
          steps: [{ stepCount: 1, title: 'Step 1' }],
          welcomeMessage: 'Welcome!',
          visibility: 'system' as const,
          isBuiltIn: true,
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        },
      ];
      mockWorkPlanService.getWorkPlansByVisibility.mockImplementation((visibility: string) => {
        if (visibility === 'system') return Promise.resolve(underscoredPlans);
        return Promise.resolve([]);
      });
      mockChatbotDb.createChatSession.mockResolvedValue({
        ...mockSession,
        pageIdentifier: 'plan-Founder Linkedin Sales Readiness Audit',
      } as any);

      const req = mockRequest('Founder LinkedIn Sales Readiness Audit');
      const res = mockResponse();

      await agentModeController.createSessionWithPlan(req, res);

      expect(res.status).not.toHaveBeenCalledWith(404);
      expect(mockChatbotDb.createChatSession).toHaveBeenCalled();
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
          planId: 'plan-autocomplete',
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
          autocomplete: true,
          visibility: 'system' as const,
          isBuiltIn: true,
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z'
        }
      ];
      mockWorkPlanService.getWorkPlansByVisibility.mockImplementation((visibility: string) => {
        if (visibility === 'system') {
          return Promise.resolve(workPlansWithAutocomplete);
        }
        return Promise.resolve([]);
      });

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
          planId: 'plan-no-autocomplete',
          title: 'Onboarding',
          steps: [
            {
              stepCount: 1,
              title: 'Step 1',
              description: 'First step'
            }
          ],
          welcomeMessage: 'Welcome!',
          visibility: 'system' as const,
          isBuiltIn: true,
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z'
          // autocomplete is not specified
        }
      ];
      mockWorkPlanService.getWorkPlansByVisibility.mockImplementation((visibility: string) => {
        if (visibility === 'system') {
          return Promise.resolve(workPlansWithoutAutocomplete);
        }
        return Promise.resolve([]);
      });

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
          planId: 'plan-login-signup',
          title: 'Onboarding',
          steps: [
            {
              stepCount: 1,
              title: 'Step 1',
              description: 'First step'
            }
          ],
          showLoginSignup: 'always',
          visibility: 'system' as const,
          isBuiltIn: true,
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z'
        }
      ];
      mockWorkPlanService.getWorkPlansByVisibility.mockImplementation((visibility: string) => {
        if (visibility === 'system') {
          return Promise.resolve(workPlansWithLoginSignup);
        }
        return Promise.resolve([]);
      });

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
          planId: 'plan-no-login-signup',
          title: 'Onboarding',
          steps: [
            {
              stepCount: 1,
              title: 'Step 1',
              description: 'First step'
            }
          ],
          visibility: 'system' as const,
          isBuiltIn: true,
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z'
        }
      ];
      mockWorkPlanService.getWorkPlansByVisibility.mockImplementation((visibility: string) => {
        if (visibility === 'system') {
          return Promise.resolve(workPlansWithoutLoginSignup);
        }
        return Promise.resolve([]);
      });

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
          planId: 'plan-require-login',
          title: 'Onboarding',
          steps: [
            {
              stepCount: 1,
              title: 'Step 1',
              description: 'First step'
            }
          ],
          requireLogin: true,
          visibility: 'system' as const,
          isBuiltIn: true,
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z'
        }
      ];
      mockWorkPlanService.getWorkPlansByVisibility.mockImplementation((visibility: string) => {
        if (visibility === 'system') {
          return Promise.resolve(workPlansWithRequireLogin);
        }
        return Promise.resolve([]);
      });

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
          planId: 'plan-no-require-login',
          title: 'Onboarding',
          steps: [
            {
              stepCount: 1,
              title: 'Step 1',
              description: 'First step'
            }
          ],
          visibility: 'system' as const,
          isBuiltIn: true,
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z'
        }
      ];
      mockWorkPlanService.getWorkPlansByVisibility.mockImplementation((visibility: string) => {
        if (visibility === 'system') {
          return Promise.resolve(workPlansWithoutRequireLogin);
        }
        return Promise.resolve([]);
      });

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
          planId: 'plan-default-model',
          title: 'Onboarding',
          steps: [{ stepCount: 1, title: 'Step 1' }],
          defaultModel: 'gemini-3-pro-preview',
          visibility: 'system' as const,
          isBuiltIn: true,
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z'
        }
      ];
      mockWorkPlanService.getWorkPlansByVisibility.mockImplementation((visibility: string) => {
        if (visibility === 'system') {
          return Promise.resolve(workPlansWithDefaultModel);
        }
        return Promise.resolve([]);
      });

      const req = mockRequest(mockPlanTitle);
      const res = mockResponse();

      await agentModeController.createSessionWithPlan(req, res);

      expect(mockChatbotDb.updateSessionLlmModel).toHaveBeenCalledWith(
        'test-session-123',
        'gemini-3-pro-preview', undefined, 'system',
      );
      expect(mockAgentModeService.getDefaultModel).not.toHaveBeenCalled();
    });

    const planWithModel = (defaultModel: any, visibility: 'system' | 'private' = 'system') => {
      const plans = [{
        planId: 'plan-pinned',
        title: 'Onboarding',
        steps: [{ stepCount: 1, title: 'Step 1' }],
        defaultModel,
        visibility,
        isBuiltIn: true,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z'
      }];
      mockWorkPlanService.getWorkPlansByVisibility.mockImplementation((v: string) =>
        Promise.resolve(v === 'system' && visibility === 'system' ? plans : []));
    };

    // ENG-903 FAIL-LOUD: an explicit plan pin that cannot be served is a 422 with NO session.
    it.each([
      ['retired / unserved', 'retired-model-9', 'not_served'],
      ['non-string', ['gpt-5-chat'], 'not_served'],
      ['internalOnly', 'internal-judge', 'not_selectable'],
      ['live-voice', 'live-voice', 'not_selectable'],
    ])('returns 422 model_unavailable (%s) before any session or side effect', async (_label, model, reason) => {
      planWithModel(model);
      const res = mockResponse();
      mockGetUserFromToken.mockResolvedValue({ user: { userId: 'u-1', email: 'a@b.c' } } as any);
      mockUserDb.getUserById.mockResolvedValue({ userId: 'u-1', isAdmin: false } as any);

      await agentModeController.createSessionWithPlan(mockRequest(mockPlanTitle, {}, { startingMessage: 'go' }), res);

      expect(res.status).toHaveBeenCalledWith(422);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'model_unavailable', reason }));
      expect(String((res.json as jest.Mock).mock.calls[0][0].error)).toContain('nothing was sent to a different model');
      expect(String((res.json as jest.Mock).mock.calls[0][0].error)).not.toContain('you selected');
      expect(mockChatbotDb.createChatSession).not.toHaveBeenCalled();
      expect(mockChatbotDb.updateSessionWorkPlan).not.toHaveBeenCalled();
      expect(mockChatbotDb.addAssociatedSkills).not.toHaveBeenCalled();
      expect(mockChatbotDb.updateSessionLlmModel).not.toHaveBeenCalled();
      expect(mockChatbotDb.updateSessionInteractiveShareMetadata).not.toHaveBeenCalled();
    });

    it('anonymous caller: 422 body names no model, display name or reason', async () => {
      planWithModel('admin-only-model');
      mockGetUserFromToken.mockResolvedValue({ user: null });
      const res = mockResponse();
      await agentModeController.createSessionWithPlan(mockRequest(mockPlanTitle), res);
      expect(res.status).toHaveBeenCalledWith(422);
      expect((res.json as jest.Mock).mock.calls[0][0]).toEqual({
        error: "This work plan can't start right now because its model is unavailable.",
        code: 'model_unavailable',
      });
      expect(mockChatbotDb.createChatSession).not.toHaveBeenCalled();
    });

    it.each([['pinned', 'gpt-5-chat'], ['unpinned', undefined]])('%s plan: a FAILED model write returns 503 and writes no plan/skills/share', async (_l, model) => {
      planWithModel(model);
      mockChatbotDb.updateSessionLlmModel.mockRejectedValueOnce(new Error('ddb down'));
      const res = mockResponse();
      await agentModeController.createSessionWithPlan(mockRequest(mockPlanTitle, {}, { startingMessage: 'go' }), res);
      expect(res.status).toHaveBeenCalledWith(503);
      expect((res.json as jest.Mock).mock.calls[0][0]).toMatchObject({ code: 'model_save_failed' });
      expect((res.json as jest.Mock).mock.calls[0][0].sessionId).toBeUndefined();
      expect(mockChatbotDb.updateSessionWorkPlan).not.toHaveBeenCalled();
      expect(mockChatbotDb.addAssociatedSkills).not.toHaveBeenCalled();
      expect(mockChatbotDb.updateSessionInteractiveShareMetadata).not.toHaveBeenCalled();
    });

    describe('session cleanup (deleteSession)', () => {
      let errSpy: jest.SpyInstance;
      let del: jest.Mock;
      beforeEach(() => {
        errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        del = jest.fn().mockResolvedValue(undefined);
        (mockChatbotDb as any).deleteSession = del;
        mockChatbotDb.createChatSession.mockResolvedValue({ ...mockSession, sessionId: 'new-sess-1' } as any);
      });
      afterEach(() => { errSpy.mockRestore(); });

      it('model-save failure: deleteSession called exactly once with the NEW session id; 503', async () => {
        planWithModel('gpt-5-chat');
        mockChatbotDb.updateSessionLlmModel.mockRejectedValueOnce(new Error('ddb down'));
        const res = mockResponse();
        await agentModeController.createSessionWithPlan(mockRequest(mockPlanTitle), res);
        expect(res.status).toHaveBeenCalledWith(503);
        expect(del).toHaveBeenCalledTimes(1);
        expect(del).toHaveBeenCalledWith('new-sess-1');
      });

      it('refused launch (422) creates no session and deletes nothing; success deletes nothing', async () => {
        planWithModel('retired-model-9');
        const refused = mockResponse();
        await agentModeController.createSessionWithPlan(mockRequest(mockPlanTitle), refused);
        expect(refused.status).toHaveBeenCalledWith(422);
        expect(mockChatbotDb.createChatSession).not.toHaveBeenCalled();
        planWithModel('gpt-5-chat');
        await agentModeController.createSessionWithPlan(mockRequest(mockPlanTitle), mockResponse());
        expect(del).not.toHaveBeenCalled();
      });

      it('a rejecting deleteSession still returns 503 and logs the session id', async () => {
        planWithModel('gpt-5-chat');
        mockChatbotDb.updateSessionLlmModel.mockRejectedValueOnce(new Error('ddb down'));
        del.mockRejectedValueOnce(new Error('delete down'));
        const res = mockResponse();
        await agentModeController.createSessionWithPlan(mockRequest(mockPlanTitle), res);
        expect(res.status).toHaveBeenCalledWith(503);
        const logged = errSpy.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
        expect(logged).toContain('new-sess-1');
        expect(logged).toMatch(/delete/i);
      });

      it('non-sequential stepCount: no session is created and no model is written (422/4xx-5xx, nothing to clean)', async () => {
        mockWorkPlanService.getWorkPlansByVisibility.mockImplementation((v: string) =>
          Promise.resolve(v === 'system' ? [{ ...mockWorkPlans[0], defaultModel: 'gpt-5-chat', steps: [{ stepCount: 1, title: 'a' }, { stepCount: 4, title: 'b' }] }] : []));
        const res = mockResponse();
        await agentModeController.createSessionWithPlan(mockRequest(mockPlanTitle), res);
        expect(mockChatbotDb.createChatSession).not.toHaveBeenCalled();
        expect(mockChatbotDb.updateSessionLlmModel).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(422);
        expect((res.json as jest.Mock).mock.calls[0][0]).toEqual({
          error: 'This work plan is misconfigured and cannot be started right now.',
          code: 'workplan_invalid',
        });
      });

      // Every write AFTER createChatSession must remove the just-created session on failure.
      const withInputStep = () => mockWorkPlanService.getWorkPlansByVisibility.mockImplementation((v: string) =>
        Promise.resolve(v === 'system' ? [{
          ...mockWorkPlans[0], defaultModel: 'gpt-5-chat',
          steps: [{ stepCount: 1, title: 'a', inputRequest: { title: 'T', prompt: 'P', fields: [] } }, { stepCount: 2, title: 'b' }],
        }] : []));

      it.each([
        ['updateSessionWorkPlanInputRequest', () => { withInputStep(); mockChatbotDb.updateSessionWorkPlanInputRequest.mockRejectedValueOnce(new Error('ddb down')); }],
        ['updateSessionInteractiveShareMetadata', () => { planWithModel('gpt-5-chat'); mockChatbotDb.updateSessionInteractiveShareMetadata.mockRejectedValueOnce(new Error('ddb down')); }],
        ['getDefaultModel (unpinned)', () => { planWithModel(undefined); mockAgentModeService.getDefaultModel.mockRejectedValueOnce(new Error('registry down')); }],
      ])('later write %s failing deletes exactly the new session and sends no success body', async (_n, arrange) => {
        arrange();
        const res = mockResponse();
        await agentModeController.createSessionWithPlan(mockRequest(mockPlanTitle), res);
        expect((res.status as jest.Mock).mock.calls[0][0]).toBeGreaterThanOrEqual(500);
        expect(del).toHaveBeenCalledTimes(1);
        expect(del).toHaveBeenCalledWith('new-sess-1');
        expect(res.json).not.toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'new-sess-1' }));
      });

      it('plan write failing after the model write removes the new session (best effort) and returns a failure', async () => {
        planWithModel('gpt-5-chat');
        mockChatbotDb.updateSessionWorkPlan.mockRejectedValueOnce(new Error('ddb down'));
        const res = mockResponse();
        await agentModeController.createSessionWithPlan(mockRequest(mockPlanTitle), res);
        expect((res.status as jest.Mock).mock.calls[0][0]).toBeGreaterThanOrEqual(500);
        expect(del).toHaveBeenCalledTimes(1);
        expect(del).toHaveBeenCalledWith('new-sess-1');
      });
    });

    it('the model write precedes the plan write', async () => {
      planWithModel('gpt-5-chat');
      await agentModeController.createSessionWithPlan(mockRequest(mockPlanTitle), mockResponse());
      expect(mockChatbotDb.updateSessionLlmModel.mock.invocationCallOrder[0])
        .toBeLessThan(mockChatbotDb.updateSessionWorkPlan.mock.invocationCallOrder[0]);
    });

    it('adminOnly plan model: non-admin signed-in user gets 422, an admin launches on it', async () => {
      planWithModel('admin-only-model');
      mockGetUserFromToken.mockResolvedValue({ user: { userId: 'u-1', email: 'a@b.c' } } as any);
      mockUserDb.getUserById.mockResolvedValue({ userId: 'u-1', isAdmin: false } as any);
      const denied = mockResponse();
      await agentModeController.createSessionWithPlan(mockRequest(mockPlanTitle), denied);
      expect(denied.status).toHaveBeenCalledWith(422);
      expect(mockChatbotDb.createChatSession).not.toHaveBeenCalled();

      mockUserDb.getUserById.mockResolvedValue({ userId: 'u-1', isAdmin: true } as any);
      const ok = mockResponse();
      await agentModeController.createSessionWithPlan(mockRequest(mockPlanTitle), ok);
      expect(ok.status).not.toHaveBeenCalledWith(422);
      expect(mockChatbotDb.updateSessionLlmModel).toHaveBeenCalledWith('test-session-123', 'admin-only-model', undefined, 'system');
    });

    it('honours a legacy alias by storing the canonical id', async () => {
      planWithModel('legacy-alias');
      await agentModeController.createSessionWithPlan(mockRequest(mockPlanTitle), mockResponse());
      expect(mockChatbotDb.updateSessionLlmModel).toHaveBeenCalledWith('test-session-123', 'gemini-3-pro-preview', undefined, 'system');
      expect(mockAgentModeService.getDefaultModel).not.toHaveBeenCalled();
    });

    it('whitespace-only plan model is no pin (account default)', async () => {
      planWithModel('   ');
      await agentModeController.createSessionWithPlan(mockRequest(mockPlanTitle), mockResponse());
      expect(mockChatbotDb.updateSessionLlmModel).toHaveBeenCalledWith('test-session-123', 'gpt-5-chat', undefined, 'system');
    });

    it('should use global default when work plan has no default model', async () => {
      const workPlansWithoutDefaultModel = [
        {
          planId: 'plan-no-default-model',
          title: 'Onboarding',
          steps: [{ stepCount: 1, title: 'Step 1' }],
          visibility: 'system' as const,
          isBuiltIn: true,
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z'
        }
      ];
      mockWorkPlanService.getWorkPlansByVisibility.mockImplementation((visibility: string) => {
        if (visibility === 'system') {
          return Promise.resolve(workPlansWithoutDefaultModel);
        }
        return Promise.resolve([]);
      });

      const req = mockRequest(mockPlanTitle);
      const res = mockResponse();

      await agentModeController.createSessionWithPlan(req, res);

      expect(mockAgentModeService.getDefaultModel).toHaveBeenCalled();
      expect(mockChatbotDb.updateSessionLlmModel).toHaveBeenCalledWith(
        'test-session-123',
        'gpt-5-chat', undefined, 'system',
      );
    });

    it('should use global default when work plan default model is empty string', async () => {
      const workPlansWithEmptyModel = [
        {
          planId: 'plan-empty-model',
          title: 'Onboarding',
          steps: [{ stepCount: 1, title: 'Step 1' }],
          defaultModel: '',
          visibility: 'system' as const,
          isBuiltIn: true,
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z'
        }
      ];
      mockWorkPlanService.getWorkPlansByVisibility.mockImplementation((visibility: string) => {
        if (visibility === 'system') {
          return Promise.resolve(workPlansWithEmptyModel);
        }
        return Promise.resolve([]);
      });

      const req = mockRequest(mockPlanTitle);
      const res = mockResponse();

      await agentModeController.createSessionWithPlan(req, res);

      expect(mockAgentModeService.getDefaultModel).toHaveBeenCalled();
      expect(mockChatbotDb.updateSessionLlmModel).toHaveBeenCalledWith(
        'test-session-123',
        'gpt-5-chat', undefined, 'system',
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

      // Wait for the fire-and-forget to execute, fail, pass the health check (mocked
      // healthy by default), wait the short retry backoff, and retry.
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

    // The blast-radius bug: restartWorker() SIGKILLs a worker process SHARED by every
    // concurrent session, and its exit handler rejects every OTHER session's in-flight
    // turn too — not just this one. Restarting unconditionally on any single session's
    // transient failure (a rate limit, a bad tool call, anything unrelated to the worker
    // process itself) took down every concurrent user for one unrelated hiccup. Fixed:
    // ping the worker first: only restart when it's genuinely unresponsive.
    it('does NOT restart the worker when it responds healthy — a single session\'s transient failure must not affect concurrent sessions', async () => {
      mockChatbotDb.getChatSession = jest.fn().mockRejectedValue(new Error('Session not found'));
      jest.spyOn(console, 'warn').mockImplementation(() => {});
      jest.spyOn(console, 'error').mockImplementation(() => {});
      const { generateMarketingResponseWorkerService } = jest.requireMock('../services/generateMarketingResponseWorkerService');
      generateMarketingResponseWorkerService.isWorkerHealthy.mockResolvedValue(true);

      const req = mockRequest(mockPlanTitle, {}, { startingMessage: 'firstName is Rui' });
      const res = mockResponse();
      await agentModeController.createSessionWithPlan(req, res);

      // No restart (and no 3s restart-path wait) to wait out — just the shorter
      // healthy-path retry backoff.
      await new Promise(resolve => setTimeout(resolve, 1500));

      expect(generateMarketingResponseWorkerService.isWorkerHealthy).toHaveBeenCalled();
      expect(generateMarketingResponseWorkerService.restartWorker).not.toHaveBeenCalled();

      (console.warn as jest.Mock).mockRestore();
      (console.error as jest.Mock).mockRestore();
    });

    it('DOES restart the worker when it fails to respond — the genuinely-unresponsive case is unchanged', async () => {
      mockChatbotDb.getChatSession = jest.fn().mockRejectedValue(new Error('Session not found'));
      jest.spyOn(console, 'warn').mockImplementation(() => {});
      jest.spyOn(console, 'error').mockImplementation(() => {});
      const { generateMarketingResponseWorkerService } = jest.requireMock('../services/generateMarketingResponseWorkerService');
      // Once, not a standing override: clearMocks (jest.config.js) only resets call
      // history between tests, not implementations — a plain mockResolvedValue(false)
      // here would leak "unhealthy" into every later test in this file.
      generateMarketingResponseWorkerService.isWorkerHealthy.mockResolvedValueOnce(false);

      const req = mockRequest(mockPlanTitle, {}, { startingMessage: 'firstName is Rui' });
      const res = mockResponse();
      await agentModeController.createSessionWithPlan(req, res);

      await new Promise(resolve => setTimeout(resolve, 4000));

      expect(generateMarketingResponseWorkerService.isWorkerHealthy).toHaveBeenCalled();
      expect(generateMarketingResponseWorkerService.restartWorker).toHaveBeenCalled();

      (console.warn as jest.Mock).mockRestore();
      (console.error as jest.Mock).mockRestore();
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

  describe('Org-shared private work plan access', () => {
    const orgId = 'org-123';
    const ownerUserId = 'owner-user-456';
    const orgMemberUserId = 'member-user-789';

    const orgPrivatePlan = {
      planId: 'org-private-plan-1',
      title: 'Org Private Plan',
      ownerId: ownerUserId,
      orgId,
      visibility: 'private' as const,
      isBuiltIn: false,
      steps: [{ stepCount: 1, title: 'Step 1', description: 'Do thing' }],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };

    beforeEach(() => {
      mockChatbotDb.createChatSession.mockResolvedValue(mockSession as any);
      mockWorkPlanService.getWorkPlansByVisibility.mockResolvedValue([]);
    });

    it('allows an org member to create a session with another member\'s private plan', async () => {
      mockGetUserFromToken.mockResolvedValue({
        user: { userId: orgMemberUserId, email: 'member@org.com', isAdmin: false, roles: ['customer'] as any }
      });
      mockUserDb.getUserById.mockResolvedValue({ userId: orgMemberUserId, orgId } as any);
      mockWorkPlanService.getWorkPlansByOwner.mockResolvedValue([]);
      mockWorkPlanService.getWorkPlansByOrg.mockResolvedValue([orgPrivatePlan]);

      const req = mockRequest('Org Private Plan', { authorization: 'Bearer member-token' });
      const res = mockResponse();

      await agentModeController.createSessionWithPlan(req, res);

      expect(res.status).not.toHaveBeenCalledWith(403);
      expect(mockChatbotDb.createChatSession).toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'test-session-123' }));
    });

    it('denies an unauthenticated user from using a private plan even if title matches', async () => {
      mockGetUserFromToken.mockResolvedValue({ user: null });
      // Private plan is NOT loaded for unauthenticated users (the controller only loads
      // private plans inside the `if (result.user)` block), so 404 is expected.
      const req = mockRequest('Org Private Plan');
      const res = mockResponse();

      await agentModeController.createSessionWithPlan(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(mockChatbotDb.createChatSession).not.toHaveBeenCalled();
    });
  });

  // ENG-2655: private plans resolve only for their owner / org members (defence in depth on top of the candidate sets).
  describe('private plan access (ENG-2655)', () => {
    const privatePlan = (over: Record<string, unknown>) => ({
      ...mockWorkPlans[0], planId: 'priv-1', title: 'Secret Plan', visibility: 'private' as const, isBuiltIn: false, ...over,
    }) as any;
    const signedIn = () => mockGetUserFromToken.mockResolvedValue({
      user: { userId: 'viewer', email: 'v@example.com', isAdmin: false, roles: ['customer'] as ('partner' | 'customer' | 'free')[] },
    });
    beforeEach(() => {
      signedIn();
      mockChatbotDb.createChatSession.mockResolvedValue({ ...mockSession, userId: 'viewer' } as any);
    });

    it("404s another account's private plan for a signed-in non-owner and creates no session", async () => {
      const res = mockResponse();
      await agentModeController.createSessionWithPlan(mockRequest('Secret Plan'), res);
      expect(res.status).toHaveBeenCalledWith(404);
      expect(mockChatbotDb.createChatSession).not.toHaveBeenCalled();
    });

    it('defence in depth: 403s a private plan found in the system/public lists, no session created', async () => {
      mockWorkPlanService.getWorkPlansByVisibility.mockImplementation(async (v: string) =>
        v === 'public' ? [privatePlan({ ownerId: undefined })] : []);
      const res = mockResponse();
      await agentModeController.createSessionWithPlan(mockRequest('Secret Plan'), res);
      expect(res.status).toHaveBeenCalledWith(403);
      expect(mockChatbotDb.createChatSession).not.toHaveBeenCalled();
    });

    it('launches the caller\'s own private plan', async () => {
      mockWorkPlanService.getWorkPlansByOwner.mockResolvedValue([privatePlan({ ownerId: 'viewer' })]);
      const res = mockResponse();
      await agentModeController.createSessionWithPlan(mockRequest('Secret Plan'), res);
      expect(res.status).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ sessionId: expect.any(String) }));
    });

    it("launches an org member's private plan for a member of that org", async () => {
      mockUserDb.getUserById.mockResolvedValue({ userId: 'viewer', orgId: 'org-1' } as any);
      mockWorkPlanService.getWorkPlansByOrg.mockResolvedValue([privatePlan({ ownerId: 'mate' })]);
      const res = mockResponse();
      await agentModeController.createSessionWithPlan(mockRequest('Secret Plan'), res);
      expect(res.status).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ sessionId: expect.any(String) }));
    });

    it('launches a system plan for an anonymous caller', async () => {
      mockGetUserFromToken.mockResolvedValue({ user: null });
      mockChatbotDb.createChatSession.mockResolvedValue({ ...mockSession, userId: 'anon_mock-uuid-123' } as any);
      const res = mockResponse();
      await agentModeController.createSessionWithPlan(mockRequest(mockPlanTitle), res);
      expect(res.status).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ sessionId: expect.any(String) }));
    });
  });
});
