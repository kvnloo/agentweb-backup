// Unit tests for Agent Mode Service GTM Plan functions

import { AgentModeService } from '../services/agentModeService';

// Mock AWS SDK before importing anything that uses it
jest.mock('aws-sdk', () => {
  const mockQuery = jest.fn();
  const mockGet = jest.fn();
  const mockPut = jest.fn();
  
  return {
    config: {
      update: jest.fn(),
    },
    DynamoDB: {
      DocumentClient: jest.fn(() => ({
        query: mockQuery,
        get: mockGet,
        put: mockPut,
      })),
    },
    SecretsManager: jest.fn(() => ({
      getSecretValue: jest.fn().mockReturnValue({
        promise: jest.fn().mockResolvedValue({ SecretString: '{}' }),
      }),
    })),
    S3: jest.fn(() => ({
      upload: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({ Location: 'https://mock-s3-url.com/file', Key: 'mock-key' }) }),
      getObject: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
    })),
  };
});

// Mock db module
jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn(),
    updateUser: jest.fn(),
  },
  taskDb: {
    getTasksWithKnowledgeBase: jest.fn(),
  },
}));

// Mock chatbotService module
jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    addMessageToSession: jest.fn(),
    getChatSession: jest.fn(),
  },
}));

// Mock secretsManager module
jest.mock('../utils/secretsManager', () => ({
  getSecret: jest.fn().mockResolvedValue('mock-secret'),
  getGCSPPrivateKey: jest.fn().mockResolvedValue('mock-private-key'),
}));

const { DynamoDB } = require('aws-sdk');
const { chatbotDb } = require('../services/chatbotService');
const { userDb } = require('../services/db');

describe('Agent Mode Service - GTM Plan Functions', () => {
  let agentModeService: AgentModeService;
  let mockQuery: jest.Mock;
  let mockGet: jest.Mock;
  let mockPut: jest.Mock;

  const mockUserId = 'user-123';
  const mockSessionId = 'session-123';
  const mockUserEmail = 'user@example.com';
  const mockPlanId = 'plan-123';
  const mockPlan = {
    planId: mockPlanId,
    userId: mockUserId,
    title: 'Test GTM Plan',
    description: 'Test Description',
    phases: [
      {
        id: 'phase-1',
        title: 'Phase 1',
        description: 'Phase 1 Description',
        duration: 30,
        status: 'in_progress',
        workItems: [
          {
            id: 'item-1',
            title: 'Work Item 1',
            description: 'Work Item Description',
            duration: 5,
            status: 'pending',
          },
        ],
      },
    ],
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    process.env.NODE_ENV = 'development';

    mockQuery = jest.fn().mockReturnValue({ promise: jest.fn() });
    mockGet = jest.fn().mockReturnValue({ promise: jest.fn() });
    mockPut = jest.fn().mockReturnValue({ promise: jest.fn() });

    const mockDynamoDB = {
      query: mockQuery,
      get: mockGet,
      put: mockPut,
    };

    (DynamoDB.DocumentClient as jest.Mock).mockImplementation(() => mockDynamoDB);

    // Mock chatbotDb.getChatSession to return a session without delegateInfo by default
    (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({
      sessionId: mockSessionId,
      userId: mockUserId,
    });

    // Mock userDb.getUserById to return user with email
    (userDb.getUserById as jest.Mock).mockResolvedValue({
      userId: mockUserId,
      email: mockUserEmail,
    });

    agentModeService = new AgentModeService();
    await agentModeService.initialize();
  });

  describe('Tool Definition', () => {
    it('should include list_gtm_plans in available tools', () => {
      const tools = agentModeService.getAvailableTools();
      const tool = tools.find(
        (t: any) => t.function?.name === 'list_gtm_plans'
      );

      expect(tool).toBeDefined();
      expect(tool?.function?.name).toBe('list_gtm_plans');
    });

    it('should include read_gtm_plan in available tools', () => {
      const tools = agentModeService.getAvailableTools();
      const tool = tools.find(
        (t: any) => t.function?.name === 'read_gtm_plan'
      );

      expect(tool).toBeDefined();
      expect(tool?.function?.name).toBe('read_gtm_plan');
    });

    it('should include create_gtm_plan in available tools', () => {
      const tools = agentModeService.getAvailableTools();
      const tool = tools.find(
        (t: any) => t.function?.name === 'create_gtm_plan'
      );

      expect(tool).toBeDefined();
      expect(tool?.function?.name).toBe('create_gtm_plan');
    });

    it('should have correct parameters for create_gtm_plan', () => {
      const tools = agentModeService.getAvailableTools();
      const tool = tools.find(
        (t: any) => t.function?.name === 'create_gtm_plan'
      );

      expect(tool?.function?.parameters?.properties?.title).toBeDefined();
      expect(tool?.function?.parameters?.properties?.phases).toBeDefined();
      expect(tool?.function?.parameters?.required).toContain('title');
    });
  });

  describe('listGTMPlans', () => {
    it('should list all GTM plans for a user', async () => {
      const mockPromise = jest.fn().mockResolvedValue({
        Items: [mockPlan],
      });
      mockQuery.mockReturnValue({ promise: mockPromise });

      const result = await (agentModeService as any).listGTMPlans(mockUserId);

      expect(result.success).toBe(true);
      expect(result.plans).toHaveLength(1);
      expect(result.plans[0]).toEqual({
        planId: mockPlanId,
        title: 'Test GTM Plan',
        description: 'Test Description',
        phaseCount: 1,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      });
      expect(mockQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          TableName: 'Dev-AW-GTMPlan',
          IndexName: 'UserIdIndex',
        })
      );
    });

    it('should return empty array when user has no plans', async () => {
      const mockPromise = jest.fn().mockResolvedValue({
        Items: [],
      });
      mockQuery.mockReturnValue({ promise: mockPromise });

      const result = await (agentModeService as any).listGTMPlans(mockUserId);

      expect(result.success).toBe(true);
      expect(result.plans).toEqual([]);
      expect(result.totalPlans).toBe(0);
    });
  });

  describe('readGTMPlan', () => {
    it('should read a specific GTM plan', async () => {
      const mockPromise = jest.fn().mockResolvedValue({
        Item: mockPlan,
      });
      mockGet.mockReturnValue({ promise: mockPromise });

      const result = await (agentModeService as any).readGTMPlan(mockPlanId, mockUserId);

      expect(result.success).toBe(true);
      expect(result.exists).toBe(true);
      expect(result.plan).toEqual(mockPlan);
      expect(result.formattedContent).toContain('GTM Plan: Test GTM Plan');
      expect(mockGet).toHaveBeenCalledWith(
        expect.objectContaining({
          TableName: 'Dev-AW-GTMPlan',
          Key: {
            planId: mockPlanId,
          },
        })
      );
    });

    it('should return error when plan does not exist', async () => {
      const mockPromise = jest.fn().mockResolvedValue({
        Item: undefined,
      });
      mockGet.mockReturnValue({ promise: mockPromise });

      const result = await (agentModeService as any).readGTMPlan('non-existent', mockUserId);

      expect(result.success).toBe(false);
      expect(result.exists).toBe(false);
      expect(result.message).toContain('not found');
    });

    it('should return error when plan belongs to different user', async () => {
      const mockPromise = jest.fn().mockResolvedValue({
        Item: { ...mockPlan, userId: 'different-user' },
      });
      mockGet.mockReturnValue({ promise: mockPromise });

      const result = await (agentModeService as any).readGTMPlan(mockPlanId, mockUserId);

      expect(result.success).toBe(false);
      expect(result.exists).toBe(false);
      expect(result.message).toContain('Access denied');
    });

    it('should format plan content for LLM consumption', async () => {
      const mockPromise = jest.fn().mockResolvedValue({
        Item: mockPlan,
      });
      mockGet.mockReturnValue({ promise: mockPromise });

      const result = await (agentModeService as any).readGTMPlan(mockPlanId, mockUserId);

      expect(result.formattedContent).toContain('GTM Plan: Test GTM Plan');
      expect(result.formattedContent).toContain('Phase 1: Phase 1');
      expect(result.formattedContent).toContain('Work Item 1 [pending]');
      expect(result.formattedContent).toContain('5 day(s)');
    });
  });

  describe('createGTMPlan', () => {
    it('should create a new GTM plan with phases and work items', async () => {
      const title = 'New Plan';
      const description = 'New Description';
      const phases = [
        {
          title: 'New Phase',
          description: 'New Phase Description',
          duration: 20,
          workItems: [
            {
              title: 'New Work Item',
              description: 'New Work Item Description',
              duration: 3,
            },
          ],
        },
      ];

      const mockPromise = jest.fn().mockResolvedValue({});
      mockPut.mockReturnValue({ promise: mockPromise });

      const result = await (agentModeService as any).createGTMPlan(title, description, undefined, phases, mockUserId, mockSessionId);

      expect(result.success).toBe(true);
      expect(result.message).toContain('created successfully');
      expect(result.plan.title).toBe('New Plan');
      expect(result.plan.description).toBe('New Description');
      expect(result.plan.phaseCount).toBe(1);
      expect(result.plan.phases).toHaveLength(1);
      expect(result.plan.phases[0].title).toBe('New Phase');
      expect(result.plan.phases[0].workItems).toHaveLength(1);
      expect(result.plan.phases[0].workItems[0].title).toBe('New Work Item');
      expect(result.plan.phases[0].workItems[0].status).toBe('pending');
      expect(mockPut).toHaveBeenCalledWith(
        expect.objectContaining({
          TableName: 'Dev-AW-GTMPlan',
          Item: expect.objectContaining({
            title: 'New Plan',
            description: 'New Description',
            phases: expect.arrayContaining([
              expect.objectContaining({
                title: 'New Phase',
                workItems: expect.arrayContaining([
                  expect.objectContaining({
                    title: 'New Work Item',
                    status: 'pending',
                  }),
                ]),
              }),
            ]),
          }),
        })
      );
    });

    it('should create a plan without phases', async () => {
      const title = 'Empty Plan';
      const description = '';
      const phases: any[] = [];

      const mockPromise = jest.fn().mockResolvedValue({});
      mockPut.mockReturnValue({ promise: mockPromise });

      const result = await (agentModeService as any).createGTMPlan(title, description, undefined, phases, mockUserId, mockSessionId);

      expect(result.success).toBe(true);
      expect(result.plan.title).toBe('Empty Plan');
      expect(result.plan.phaseCount).toBe(0);
    });

    it('should set work items to pending status by default', async () => {
      const phases = [
        {
          title: 'Phase 1',
          duration: 10,
          workItems: [
            {
              title: 'Item 1',
              duration: 2,
            },
          ],
        },
      ];

      const mockPromise = jest.fn().mockResolvedValue({});
      mockPut.mockReturnValue({ promise: mockPromise });

      const result = await (agentModeService as any).createGTMPlan('Test Plan', '', undefined, phases, mockUserId);

      expect(result.plan.phases[0].workItems[0].status).toBe('pending');
    });

    it('should calculate phase status correctly based on work items', async () => {
      const phases = [
        {
          title: 'Phase 1',
          duration: 10,
          workItems: [
            {
              title: 'Item 1',
            },
            {
              title: 'Item 2',
            },
          ],
        },
      ];

      const mockPromise = jest.fn().mockResolvedValue({});
      mockPut.mockReturnValue({ promise: mockPromise });

      const result = await (agentModeService as any).createGTMPlan('Test Plan', '', undefined, phases, mockUserId);

      // Phase should be in_progress when items are pending
      expect(result.plan.phases[0].status).toBe('in_progress');
    });

    it('should handle optional work item duration', async () => {
      const phases = [
        {
          title: 'Phase 1',
          duration: 10,
          workItems: [
            {
              title: 'Item 1',
              // No duration provided
            },
            {
              title: 'Item 2',
              duration: 5,
            },
          ],
        },
      ];

      const mockPromise = jest.fn().mockResolvedValue({});
      mockPut.mockReturnValue({ promise: mockPromise });

      const result = await (agentModeService as any).createGTMPlan('Test Plan', '', undefined, phases, mockUserId);

      expect(result.plan.phases[0].workItems[0].duration).toBeUndefined();
      expect(result.plan.phases[0].workItems[1].duration).toBe(5);
    });

    it('should create a plan with DRI at plan level', async () => {
      const title = 'Plan with DRI';
      const description = 'Test Description';
      const dri = 'plan-dri@example.com';
      const phases: any[] = [];

      const mockPromise = jest.fn().mockResolvedValue({});
      mockPut.mockReturnValue({ promise: mockPromise });

      const result = await (agentModeService as any).createGTMPlan(title, description, dri, phases, mockUserId);

      expect(result.success).toBe(true);
      expect(mockPut).toHaveBeenCalledWith(
        expect.objectContaining({
          TableName: 'Dev-AW-GTMPlan',
          Item: expect.objectContaining({
            dri: 'plan-dri@example.com',
            status: 'in_progress',
          }),
        })
      );
    });

    it('should create a plan with DRI at phase level', async () => {
      const title = 'Plan with Phase DRI';
      const description = 'Test Description';
      const phases = [
        {
          title: 'Phase 1',
          duration: 10,
          dri: 'phase-dri@example.com',
          workItems: [],
        },
      ];

      const mockPromise = jest.fn().mockResolvedValue({});
      mockPut.mockReturnValue({ promise: mockPromise });

      const result = await (agentModeService as any).createGTMPlan(title, description, undefined, phases, mockUserId, mockSessionId);

      expect(result.success).toBe(true);
      expect(result.plan.phases[0].dri).toBe('phase-dri@example.com');
    });

    it('should create a plan with DRI at work item level', async () => {
      const title = 'Plan with Item DRI';
      const description = 'Test Description';
      const phases = [
        {
          title: 'Phase 1',
          duration: 10,
          workItems: [
            {
              title: 'Item 1',
              dri: 'item-dri@example.com',
            },
          ],
        },
      ];

      const mockPromise = jest.fn().mockResolvedValue({});
      mockPut.mockReturnValue({ promise: mockPromise });

      const result = await (agentModeService as any).createGTMPlan(title, description, undefined, phases, mockUserId, mockSessionId);

      expect(result.success).toBe(true);
      expect(result.plan.phases[0].workItems[0].dri).toBe('item-dri@example.com');
    });

    it('should set plan status to completed when all phases are completed', async () => {
      const phases = [
        {
          title: 'Phase 1',
          duration: 10,
          workItems: [
            {
              title: 'Item 1',
              status: 'completed',
            },
          ],
        },
      ];

      // Mock the plan creation to simulate completed phases
      const mockPlan = {
        planId: 'plan-123',
        userId: mockUserId,
        title: 'Completed Plan',
        description: '',
        dri: undefined,
        status: 'completed',
        phases: [
          {
            id: 'phase-1',
            title: 'Phase 1',
            duration: 10,
            status: 'completed',
            workItems: [
              {
                id: 'item-1',
                title: 'Item 1',
                status: 'completed',
              },
            ],
          },
        ],
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      };

      const hasPhases = mockPlan.phases && mockPlan.phases.length > 0;
      const allPhasesCompleted = hasPhases && mockPlan.phases.every(
        (phase: any) => phase.status === 'completed'
      );
      const planStatus = allPhasesCompleted ? 'completed' : 'in_progress';

      expect(planStatus).toBe('completed');
    });

    it('should include DRI in formatted output for read_gtm_plan', async () => {
      const planWithDri = {
        ...mockPlan,
        dri: 'plan-dri@example.com',
        phases: [
          {
            ...mockPlan.phases[0],
            dri: 'phase-dri@example.com',
            workItems: [
              {
                ...mockPlan.phases[0].workItems[0],
                dri: 'item-dri@example.com',
              },
            ],
          },
        ],
      };

      const mockPromise = jest.fn().mockResolvedValue({
        Item: planWithDri,
      });
      mockGet.mockReturnValue({ promise: mockPromise });

      const result = await (agentModeService as any).readGTMPlan(mockPlanId, mockUserId);

      expect(result.success).toBe(true);
      expect(result.formattedContent).toContain('DRI (Plan Level): plan-dri@example.com');
      expect(result.formattedContent).toContain('DRI: phase-dri@example.com');
      expect(result.formattedContent).toContain('DRI: item-dri@example.com');
    });

    it('should include plan status and completedAt in formatted output', async () => {
      const completedPlan = {
        ...mockPlan,
        status: 'completed',
        completedAt: '2024-01-02T12:00:00Z',
        phases: [
          {
            ...mockPlan.phases[0],
            status: 'completed',
            workItems: [
              {
                ...mockPlan.phases[0].workItems[0],
                status: 'completed',
              },
            ],
          },
        ],
      };

      const mockPromise = jest.fn().mockResolvedValue({
        Item: completedPlan,
      });
      mockGet.mockReturnValue({ promise: mockPromise });

      const result = await (agentModeService as any).readGTMPlan(mockPlanId, mockUserId);

      expect(result.success).toBe(true);
      expect(result.formattedContent).toContain('Status: completed');
      expect(result.formattedContent).toContain('Completed: 2024-01-02T12:00:00Z');
    });
  });

  describe('createGTMPlan - Default DRI Logic', () => {
    const mockAdminUserId = 'admin-456';
    const mockAdminEmail = 'admin@example.com';

    it('should use user email as default DRI when no delegateInfo present', async () => {
      const title = 'Plan with Default User DRI';
      const description = 'Test Description';
      const phases: any[] = [];

      // Mock session without delegateInfo
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({
        sessionId: mockSessionId,
        userId: mockUserId,
      });

      // Mock user with email
      (userDb.getUserById as jest.Mock).mockResolvedValue({
        userId: mockUserId,
        email: mockUserEmail,
      });

      const mockPromise = jest.fn().mockResolvedValue({});
      mockPut.mockReturnValue({ promise: mockPromise });

      const result = await (agentModeService as any).createGTMPlan(
        title,
        description,
        undefined, // No explicit DRI
        phases,
        mockUserId,
        mockSessionId
      );

      expect(result.success).toBe(true);
      expect(mockPut).toHaveBeenCalledWith(
        expect.objectContaining({
          TableName: 'Dev-AW-GTMPlan',
          Item: expect.objectContaining({
            dri: mockUserEmail, // Should default to user email
          }),
        })
      );
    });

    it('should use admin email as default DRI when delegateInfo present', async () => {
      const title = 'Plan with Default Admin DRI';
      const description = 'Test Description';
      const phases: any[] = [];

      // Mock session with delegateInfo
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({
        sessionId: mockSessionId,
        userId: mockUserId,
        delegateInfo: {
          adminUserId: mockAdminUserId,
          adminEmail: mockAdminEmail,
          isDelegated: true,
        },
      });

      const mockPromise = jest.fn().mockResolvedValue({});
      mockPut.mockReturnValue({ promise: mockPromise });

      const result = await (agentModeService as any).createGTMPlan(
        title,
        description,
        undefined, // No explicit DRI
        phases,
        mockUserId,
        mockSessionId
      );

      expect(result.success).toBe(true);
      expect(mockPut).toHaveBeenCalledWith(
        expect.objectContaining({
          TableName: 'Dev-AW-GTMPlan',
          Item: expect.objectContaining({
            dri: mockAdminEmail, // Should default to admin email
          }),
        })
      );
    });

    it('should use explicit DRI when provided, overriding defaults', async () => {
      const title = 'Plan with Explicit DRI';
      const description = 'Test Description';
      const explicitDri = 'explicit-dri@example.com';
      const phases: any[] = [];

      // Mock session with delegateInfo
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({
        sessionId: mockSessionId,
        userId: mockUserId,
        delegateInfo: {
          adminUserId: mockAdminUserId,
          adminEmail: mockAdminEmail,
          isDelegated: true,
        },
      });

      const mockPromise = jest.fn().mockResolvedValue({});
      mockPut.mockReturnValue({ promise: mockPromise });

      const result = await (agentModeService as any).createGTMPlan(
        title,
        description,
        explicitDri, // Explicit DRI provided
        phases,
        mockUserId,
        mockSessionId
      );

      expect(result.success).toBe(true);
      expect(mockPut).toHaveBeenCalledWith(
        expect.objectContaining({
          TableName: 'Dev-AW-GTMPlan',
          Item: expect.objectContaining({
            dri: explicitDri, // Should use explicit DRI, not default
          }),
        })
      );
    });

    it('should handle missing user email gracefully', async () => {
      const title = 'Plan without User Email';
      const description = 'Test Description';
      const phases: any[] = [];

      // Mock session without delegateInfo
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({
        sessionId: mockSessionId,
        userId: mockUserId,
      });

      // Mock user without email
      (userDb.getUserById as jest.Mock).mockResolvedValue({
        userId: mockUserId,
        email: undefined,
      });

      const mockPromise = jest.fn().mockResolvedValue({});
      mockPut.mockReturnValue({ promise: mockPromise });

      const result = await (agentModeService as any).createGTMPlan(
        title,
        description,
        undefined,
        phases,
        mockUserId,
        mockSessionId
      );

      expect(result.success).toBe(true);
      expect(mockPut).toHaveBeenCalledWith(
        expect.objectContaining({
          TableName: 'Dev-AW-GTMPlan',
          Item: expect.objectContaining({
            dri: undefined, // Should be undefined when no email available
          }),
        })
      );
    });

    it('should handle missing admin email in delegateInfo gracefully', async () => {
      const title = 'Plan without Admin Email';
      const description = 'Test Description';
      const phases: any[] = [];

      // Mock session with delegateInfo but no admin email
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({
        sessionId: mockSessionId,
        userId: mockUserId,
        delegateInfo: {
          adminUserId: mockAdminUserId,
          adminEmail: undefined,
          isDelegated: true,
        },
      });

      // Mock user with email as fallback
      (userDb.getUserById as jest.Mock).mockResolvedValue({
        userId: mockUserId,
        email: mockUserEmail,
      });

      const mockPromise = jest.fn().mockResolvedValue({});
      mockPut.mockReturnValue({ promise: mockPromise });

      const result = await (agentModeService as any).createGTMPlan(
        title,
        description,
        undefined,
        phases,
        mockUserId,
        mockSessionId
      );

      expect(result.success).toBe(true);
      expect(mockPut).toHaveBeenCalledWith(
        expect.objectContaining({
          TableName: 'Dev-AW-GTMPlan',
          Item: expect.objectContaining({
            dri: mockUserEmail, // Should fall back to user email when admin email not available
          }),
        })
      );
    });

    it('should not use admin email when isDelegated is false', async () => {
      const title = 'Plan with Non-Delegated Session';
      const description = 'Test Description';
      const phases: any[] = [];

      // Mock session with delegateInfo but isDelegated is false
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({
        sessionId: mockSessionId,
        userId: mockUserId,
        delegateInfo: {
          adminUserId: mockAdminUserId,
          adminEmail: mockAdminEmail,
          isDelegated: false,
        },
      });

      // Mock user with email
      (userDb.getUserById as jest.Mock).mockResolvedValue({
        userId: mockUserId,
        email: mockUserEmail,
      });

      const mockPromise = jest.fn().mockResolvedValue({});
      mockPut.mockReturnValue({ promise: mockPromise });

      const result = await (agentModeService as any).createGTMPlan(
        title,
        description,
        undefined,
        phases,
        mockUserId,
        mockSessionId
      );

      expect(result.success).toBe(true);
      expect(mockPut).toHaveBeenCalledWith(
        expect.objectContaining({
          TableName: 'Dev-AW-GTMPlan',
          Item: expect.objectContaining({
            dri: mockUserEmail, // Should use user email, not admin email
          }),
        })
      );
    });

    it('should handle session fetch error gracefully', async () => {
      const title = 'Plan with Session Fetch Error';
      const description = 'Test Description';
      const phases: any[] = [];

      // Mock session fetch to return null (error case)
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(null);

      // Mock user with email
      (userDb.getUserById as jest.Mock).mockResolvedValue({
        userId: mockUserId,
        email: mockUserEmail,
      });

      const mockPromise = jest.fn().mockResolvedValue({});
      mockPut.mockReturnValue({ promise: mockPromise });

      const result = await (agentModeService as any).createGTMPlan(
        title,
        description,
        undefined,
        phases,
        mockUserId,
        mockSessionId
      );

      expect(result.success).toBe(true);
      // Should fall back to user email lookup
      expect(mockPut).toHaveBeenCalledWith(
        expect.objectContaining({
          TableName: 'Dev-AW-GTMPlan',
          Item: expect.objectContaining({
            dri: mockUserEmail,
          }),
        })
      );
    });

    it('should handle user fetch error gracefully', async () => {
      const title = 'Plan with User Fetch Error';
      const description = 'Test Description';
      const phases: any[] = [];

      // Mock session without delegateInfo
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({
        sessionId: mockSessionId,
        userId: mockUserId,
      });

      // Mock user fetch to return null (error case)
      (userDb.getUserById as jest.Mock).mockResolvedValue(null);

      const mockPromise = jest.fn().mockResolvedValue({});
      mockPut.mockReturnValue({ promise: mockPromise });

      const result = await (agentModeService as any).createGTMPlan(
        title,
        description,
        undefined,
        phases,
        mockUserId,
        mockSessionId
      );

      expect(result.success).toBe(true);
      expect(mockPut).toHaveBeenCalledWith(
        expect.objectContaining({
          TableName: 'Dev-AW-GTMPlan',
          Item: expect.objectContaining({
            dri: undefined, // Should be undefined when user fetch fails
          }),
        })
      );
    });
  });
});

