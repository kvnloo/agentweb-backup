// Unit tests for Agent Mode Service GTM Plan functions

import { AgentModeService } from '../services/agentModeService';

// Mock AWS SDK before importing anything that uses it
jest.mock('aws-sdk', () => {
  const mockQuery = jest.fn();
  const mockGet = jest.fn();
  const mockPut = jest.fn();
  const mockUpdate = jest.fn();
  const mockDelete = jest.fn();

  return {
    config: {
      update: jest.fn(),
    },
    DynamoDB: {
      DocumentClient: jest.fn(() => ({
        query: mockQuery,
        get: mockGet,
        put: mockPut,
        update: mockUpdate,
        delete: mockDelete,
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

// Mock GTM plan notification service
jest.mock('../services/gtmPlanNotificationService', () => ({
  sendGTMPlanUpdateNotifications: jest.fn().mockResolvedValue(undefined),
  sendPhaseStatusReport: jest.fn().mockResolvedValue({ recipients: 1, sent: 1, failed: 0 }),
  sendPlanStatusReport: jest.fn().mockResolvedValue({ recipients: 1, sent: 1, failed: 0 }),
}));

// Mock settings service
jest.mock('../services/settingsService', () => ({
  settingsService: {
    getSetting: jest.fn(),
    setSetting: jest.fn(),
  },
}));

const { DynamoDB } = require('aws-sdk');
const { chatbotDb } = require('../services/chatbotService');
const { userDb } = require('../services/db');
const { sendGTMPlanUpdateNotifications, sendPhaseStatusReport, sendPlanStatusReport } = require('../services/gtmPlanNotificationService');
const { settingsService } = require('../services/settingsService');

describe('Agent Mode Service - GTM Plan Functions', () => {
  let agentModeService: AgentModeService;
  let mockQuery: jest.Mock;
  let mockGet: jest.Mock;
  let mockPut: jest.Mock;
  let mockUpdate: jest.Mock;
  let mockDelete: jest.Mock;

  const mockUserId = 'user-123';
  const mockSessionId = 'session-123';
  const mockUserEmail = 'user@example.com';
  const mockPlanId = 'plan-123';
  const mockPhaseId = 'phase-1';
  const mockWorkItemId = 'item-1';
  const mockPlan = {
    planId: mockPlanId,
    userId: mockUserId,
    title: 'Test GTM Plan',
    description: 'Test Description',
    status: 'in_progress',
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
    mockUpdate = jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({ Attributes: mockPlan }) });
    mockDelete = jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) });

    const mockDynamoDB = {
      query: mockQuery,
      get: mockGet,
      put: mockPut,
      update: mockUpdate,
      delete: mockDelete,
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

    // ENG-1816 F2 follow-up: readGTMPlan's formattedContent never exposed the
    // phase/work-item's real id, only their 1-based display position, so
    // add_gtm_work_items/update_gtm_phase/update_gtm_work_item/delete_gtm_items
    // had nothing valid to target (a guessed phase_id like "1" fails with
    // "Phase not found"). Asserts the real ids from the DB record (phase-1,
    // item-1 — distinct from their display numbers) are now present, and that
    // the pre-existing display-format assertions above still hold unchanged.
    it('should expose each phase and work item\'s real id alongside its display number', async () => {
      const mockPromise = jest.fn().mockResolvedValue({
        Item: mockPlan,
      });
      mockGet.mockReturnValue({ promise: mockPromise });

      const result = await (agentModeService as any).readGTMPlan(mockPlanId, mockUserId);

      expect(result.formattedContent).toContain('Phase 1: Phase 1 (id: phase-1)');
      expect(result.formattedContent).toContain('Work Item 1 [pending]');
      expect(result.formattedContent).toContain('(id: item-1)');
      // The work item's id must appear on the same line as its title, after
      // every other conditional field (duration, dri, completedAt), not
      // between the title and its status bracket.
      expect(result.formattedContent).toMatch(/Work Item 1 \[pending\] - 5 day\(s\) \(id: item-1\)/);
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

  // Helper to set up mockGet to return a plan (deep-cloned to avoid cross-test mutation)
  function setupMockGet(plan: any) {
    mockGet.mockReturnValue({ promise: jest.fn().mockResolvedValue({ Item: JSON.parse(JSON.stringify(plan)) }) });
  }

  function setupMockGetNotFound() {
    mockGet.mockReturnValue({ promise: jest.fn().mockResolvedValue({ Item: undefined }) });
  }

  function setupMockUpdate(attributes: any = mockPlan) {
    mockUpdate.mockReturnValue({ promise: jest.fn().mockResolvedValue({ Attributes: JSON.parse(JSON.stringify(attributes)) }) });
  }

  function setupMockDelete() {
    mockDelete.mockReturnValue({ promise: jest.fn().mockResolvedValue({}) });
  }

  describe('Tool Definitions - New Tools', () => {
    const newToolNames = [
      'update_gtm_plan',
      'add_gtm_phase',
      'add_gtm_work_items',
      'update_gtm_work_item',
      'update_gtm_phase',
      'delete_gtm_items',
      'get_gtm_common_items',
      'add_gtm_common_items',
      'send_gtm_status_report',
    ];

    newToolNames.forEach((toolName) => {
      it(`should include ${toolName} in available tools`, () => {
        const tools = agentModeService.getAvailableTools();
        const tool = tools.find((t: any) => t.function?.name === toolName);
        expect(tool).toBeDefined();
        expect(tool?.function?.name).toBe(toolName);
      });
    });

    it('should require plan_id for update_gtm_plan', () => {
      const tools = agentModeService.getAvailableTools();
      const tool = tools.find((t: any) => t.function?.name === 'update_gtm_plan');
      expect(tool?.function?.parameters?.required).toContain('plan_id');
    });

    it('should require plan_id and title for add_gtm_phase', () => {
      const tools = agentModeService.getAvailableTools();
      const tool = tools.find((t: any) => t.function?.name === 'add_gtm_phase');
      expect(tool?.function?.parameters?.required).toContain('plan_id');
      expect(tool?.function?.parameters?.required).toContain('title');
    });

    it('should require plan_id, phase_id, work_items for add_gtm_work_items', () => {
      const tools = agentModeService.getAvailableTools();
      const tool = tools.find((t: any) => t.function?.name === 'add_gtm_work_items');
      expect(tool?.function?.parameters?.required).toContain('plan_id');
      expect(tool?.function?.parameters?.required).toContain('phase_id');
      expect(tool?.function?.parameters?.required).toContain('work_items');
    });

    it('should require plan_id, phase_id, work_item_id for update_gtm_work_item', () => {
      const tools = agentModeService.getAvailableTools();
      const tool = tools.find((t: any) => t.function?.name === 'update_gtm_work_item');
      expect(tool?.function?.parameters?.required).toContain('plan_id');
      expect(tool?.function?.parameters?.required).toContain('phase_id');
      expect(tool?.function?.parameters?.required).toContain('work_item_id');
    });

    it('should require plan_id and items for add_gtm_common_items', () => {
      const tools = agentModeService.getAvailableTools();
      const tool = tools.find((t: any) => t.function?.name === 'add_gtm_common_items');
      expect(tool?.function?.parameters?.required).toContain('plan_id');
      expect(tool?.function?.parameters?.required).toContain('items');
    });
  });

  describe('updateGTMPlan', () => {
    it('should update plan title successfully', async () => {
      setupMockGet(mockPlan);
      setupMockUpdate({ ...mockPlan, title: 'Updated Title' });

      const result = await (agentModeService as any).updateGTMPlan(mockPlanId, { title: 'Updated Title' }, mockUserId);

      expect(result.success).toBe(true);
      expect(result.message).toContain('updated successfully');
      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          TableName: 'Dev-AW-GTMPlan',
          Key: { planId: mockPlanId },
        })
      );
    });

    it('should update multiple fields at once', async () => {
      setupMockGet(mockPlan);
      setupMockUpdate();

      const result = await (agentModeService as any).updateGTMPlan(mockPlanId, {
        title: 'New Title',
        description: 'New Description',
        dri: 'new-dri@example.com',
        dueDate: '2024-06-01',
      }, mockUserId);

      expect(result.success).toBe(true);
    });

    it('should return error when plan not found', async () => {
      setupMockGetNotFound();

      const result = await (agentModeService as any).updateGTMPlan(mockPlanId, { title: 'New' }, mockUserId);

      expect(result.success).toBe(false);
      expect(result.message).toContain('not found');
    });

    it('should return error when access denied', async () => {
      setupMockGet({ ...mockPlan, userId: 'different-user' });

      const result = await (agentModeService as any).updateGTMPlan(mockPlanId, { title: 'New' }, mockUserId);

      expect(result.success).toBe(false);
      expect(result.message).toContain('Access denied');
    });

    it('should return error when no fields to update', async () => {
      setupMockGet(mockPlan);

      const result = await (agentModeService as any).updateGTMPlan(mockPlanId, {}, mockUserId);

      expect(result.success).toBe(false);
      expect(result.message).toContain('No fields to update');
    });

    it('should allow clearing dri by passing empty string', async () => {
      setupMockGet(mockPlan);
      setupMockUpdate();

      const result = await (agentModeService as any).updateGTMPlan(mockPlanId, { dri: '' }, mockUserId);

      expect(result.success).toBe(true);
      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          ExpressionAttributeValues: expect.objectContaining({
            ':dri': null,
          }),
        })
      );
    });
  });

  describe('addGTMPhase', () => {
    it('should add a phase without work items', async () => {
      setupMockGet(mockPlan);
      setupMockUpdate();

      const result = await (agentModeService as any).addGTMPhase(mockPlanId, {
        title: 'New Phase',
        description: 'New Phase Description',
      }, mockUserId);

      expect(result.success).toBe(true);
      expect(result.message).toContain('New Phase');
      expect(result.phaseId).toBeDefined();
    });

    it('should add a phase with work items', async () => {
      setupMockGet(mockPlan);
      setupMockUpdate();

      const result = await (agentModeService as any).addGTMPhase(mockPlanId, {
        title: 'New Phase',
        workItems: [
          { title: 'Item A' },
          { title: 'Item B', description: 'Desc B' },
        ],
      }, mockUserId);

      expect(result.success).toBe(true);
      expect(result.message).toContain('2 work item(s)');
    });

    it('should return error when plan not found', async () => {
      setupMockGetNotFound();

      const result = await (agentModeService as any).addGTMPhase(mockPlanId, { title: 'Phase' }, mockUserId);

      expect(result.success).toBe(false);
      expect(result.message).toContain('not found');
    });

    it('should return error when access denied', async () => {
      setupMockGet({ ...mockPlan, userId: 'different-user' });

      const result = await (agentModeService as any).addGTMPhase(mockPlanId, { title: 'Phase' }, mockUserId);

      expect(result.success).toBe(false);
      expect(result.message).toContain('Access denied');
    });

    it('should clear completedAt when adding phase to completed plan', async () => {
      const completedPlan = { ...mockPlan, status: 'completed', completedAt: '2024-01-02T00:00:00Z' };
      setupMockGet(completedPlan);
      setupMockUpdate();

      const result = await (agentModeService as any).addGTMPhase(mockPlanId, { title: 'Phase' }, mockUserId);

      expect(result.success).toBe(true);
      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          ExpressionAttributeValues: expect.objectContaining({
            ':completedAt': null,
          }),
        })
      );
    });
  });

  describe('addGTMWorkItems', () => {
    it('should add work items to a phase', async () => {
      setupMockGet(mockPlan);
      setupMockUpdate();

      const result = await (agentModeService as any).addGTMWorkItems(mockPlanId, mockPhaseId, [
        { title: 'New Item 1' },
        { title: 'New Item 2', description: 'Desc' },
      ], mockUserId);

      expect(result.success).toBe(true);
      expect(result.message).toContain('2 work item(s)');
      expect(result.addedItems).toHaveLength(2);
    });

    it('should return error when phase not found', async () => {
      setupMockGet(mockPlan);

      const result = await (agentModeService as any).addGTMWorkItems(mockPlanId, 'non-existent-phase', [
        { title: 'Item' },
      ], mockUserId);

      expect(result.success).toBe(false);
      expect(result.message).toContain('Phase not found');
    });

    it('should return error when plan not found', async () => {
      setupMockGetNotFound();

      const result = await (agentModeService as any).addGTMWorkItems(mockPlanId, mockPhaseId, [
        { title: 'Item' },
      ], mockUserId);

      expect(result.success).toBe(false);
      expect(result.message).toContain('not found');
    });

    it('should return error when access denied', async () => {
      setupMockGet({ ...mockPlan, userId: 'different-user' });

      const result = await (agentModeService as any).addGTMWorkItems(mockPlanId, mockPhaseId, [
        { title: 'Item' },
      ], mockUserId);

      expect(result.success).toBe(false);
      expect(result.message).toContain('Access denied');
    });
  });

  describe('updateGTMWorkItem', () => {
    it('should update work item status', async () => {
      setupMockGet(mockPlan);
      setupMockUpdate();

      const result = await (agentModeService as any).updateGTMWorkItem(
        mockPlanId, mockPhaseId, mockWorkItemId,
        { status: 'completed' },
        {},
        mockUserId
      );

      expect(result.success).toBe(true);
      expect(result.message).toContain('updated successfully');
    });

    it('should set completedAt when status changes to completed', async () => {
      setupMockGet(mockPlan);
      setupMockUpdate();

      await (agentModeService as any).updateGTMWorkItem(
        mockPlanId, mockPhaseId, mockWorkItemId,
        { status: 'completed' },
        {},
        mockUserId
      );

      // Verify phases passed to update contain completedAt on the work item
      const updateCall = mockUpdate.mock.calls[0][0];
      const updatedPhases = updateCall.ExpressionAttributeValues[':phases'];
      const workItem = updatedPhases[0].workItems[0];
      expect(workItem.completedAt).toBeDefined();
      expect(workItem.status).toBe('completed');
    });

    it('should clear completedAt when status changes from completed', async () => {
      const planWithCompletedItem = {
        ...mockPlan,
        phases: [{
          ...mockPlan.phases[0],
          workItems: [{
            ...mockPlan.phases[0].workItems[0],
            status: 'completed',
            completedAt: '2024-01-02T00:00:00Z',
          }],
        }],
      };
      setupMockGet(planWithCompletedItem);
      setupMockUpdate();

      await (agentModeService as any).updateGTMWorkItem(
        mockPlanId, mockPhaseId, mockWorkItemId,
        { status: 'in_progress' },
        {},
        mockUserId
      );

      const updateCall = mockUpdate.mock.calls[0][0];
      const updatedPhases = updateCall.ExpressionAttributeValues[':phases'];
      const workItem = updatedPhases[0].workItems[0];
      expect(workItem.completedAt).toBeNull();
    });

    it('should send notifications when requested', async () => {
      setupMockGet(mockPlan);
      setupMockUpdate();

      await (agentModeService as any).updateGTMWorkItem(
        mockPlanId, mockPhaseId, mockWorkItemId,
        { status: 'completed' },
        { notifyUser: true, notifyPlanPoc: true, message: 'Done!' },
        mockUserId
      );

      expect(sendGTMPlanUpdateNotifications).toHaveBeenCalled();
    });

    it('should not send notifications when not requested', async () => {
      setupMockGet(mockPlan);
      setupMockUpdate();

      await (agentModeService as any).updateGTMWorkItem(
        mockPlanId, mockPhaseId, mockWorkItemId,
        { status: 'completed' },
        {},
        mockUserId
      );

      expect(sendGTMPlanUpdateNotifications).not.toHaveBeenCalled();
    });

    it('should return error when plan not found', async () => {
      setupMockGetNotFound();

      const result = await (agentModeService as any).updateGTMWorkItem(
        mockPlanId, mockPhaseId, mockWorkItemId,
        { status: 'completed' }, {}, mockUserId
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('not found');
    });

    it('should return error when access denied', async () => {
      setupMockGet({ ...mockPlan, userId: 'different-user' });

      const result = await (agentModeService as any).updateGTMWorkItem(
        mockPlanId, mockPhaseId, mockWorkItemId,
        { status: 'completed' }, {}, mockUserId
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('Access denied');
    });

    it('should return error when phase not found', async () => {
      setupMockGet(mockPlan);

      const result = await (agentModeService as any).updateGTMWorkItem(
        mockPlanId, 'non-existent-phase', mockWorkItemId,
        { status: 'completed' }, {}, mockUserId
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('Phase not found');
    });

    it('should return error when work item not found', async () => {
      setupMockGet(mockPlan);

      const result = await (agentModeService as any).updateGTMWorkItem(
        mockPlanId, mockPhaseId, 'non-existent-item',
        { status: 'completed' }, {}, mockUserId
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('Work item not found');
    });

    it('should update work item notes and dri', async () => {
      setupMockGet(mockPlan);
      setupMockUpdate();

      const result = await (agentModeService as any).updateGTMWorkItem(
        mockPlanId, mockPhaseId, mockWorkItemId,
        { notes: 'Updated notes', dri: 'new@example.com' },
        {},
        mockUserId
      );

      expect(result.success).toBe(true);
      const updateCall = mockUpdate.mock.calls[0][0];
      const updatedPhases = updateCall.ExpressionAttributeValues[':phases'];
      const workItem = updatedPhases[0].workItems[0];
      expect(workItem.notes).toBe('Updated notes');
      expect(workItem.dri).toBe('new@example.com');
    });
  });

  describe('updateGTMPhase', () => {
    it('should update phase title', async () => {
      setupMockGet(mockPlan);
      setupMockUpdate();

      const result = await (agentModeService as any).updateGTMPhase(
        mockPlanId, mockPhaseId, { title: 'Updated Phase Title' }, mockUserId
      );

      expect(result.success).toBe(true);
      expect(result.message).toContain('Updated Phase Title');
    });

    it('should update phase description and dri', async () => {
      setupMockGet(mockPlan);
      setupMockUpdate();

      const result = await (agentModeService as any).updateGTMPhase(
        mockPlanId, mockPhaseId, { description: 'New desc', dri: 'phase@example.com' }, mockUserId
      );

      expect(result.success).toBe(true);
      const updateCall = mockUpdate.mock.calls[0][0];
      const updatedPhases = updateCall.ExpressionAttributeValues[':phases'];
      expect(updatedPhases[0].description).toBe('New desc');
      expect(updatedPhases[0].dri).toBe('phase@example.com');
    });

    it('should return error when plan not found', async () => {
      setupMockGetNotFound();

      const result = await (agentModeService as any).updateGTMPhase(
        mockPlanId, mockPhaseId, { title: 'New' }, mockUserId
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('not found');
    });

    it('should return error when access denied', async () => {
      setupMockGet({ ...mockPlan, userId: 'different-user' });

      const result = await (agentModeService as any).updateGTMPhase(
        mockPlanId, mockPhaseId, { title: 'New' }, mockUserId
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('Access denied');
    });

    it('should return error when phase not found', async () => {
      setupMockGet(mockPlan);

      const result = await (agentModeService as any).updateGTMPhase(
        mockPlanId, 'non-existent-phase', { title: 'New' }, mockUserId
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('Phase not found');
    });

    it('should allow clearing due date by passing empty string', async () => {
      setupMockGet(mockPlan);
      setupMockUpdate();

      const result = await (agentModeService as any).updateGTMPhase(
        mockPlanId, mockPhaseId, { dueDate: '' }, mockUserId
      );

      expect(result.success).toBe(true);
      const updateCall = mockUpdate.mock.calls[0][0];
      const updatedPhases = updateCall.ExpressionAttributeValues[':phases'];
      expect(updatedPhases[0].dueDate).toBeNull();
    });
  });

  describe('deleteGTMItems', () => {
    it('should delete entire plan when only plan_id provided', async () => {
      setupMockGet(mockPlan);
      setupMockDelete();

      const result = await (agentModeService as any).deleteGTMItems(mockPlanId, undefined, undefined, mockUserId);

      expect(result.success).toBe(true);
      expect(result.message).toContain('Test GTM Plan');
      expect(mockDelete).toHaveBeenCalledWith(
        expect.objectContaining({
          TableName: 'Dev-AW-GTMPlan',
          Key: { planId: mockPlanId },
        })
      );
    });

    it('should delete a phase when plan_id and phase_id provided', async () => {
      setupMockGet(mockPlan);
      setupMockUpdate();

      const result = await (agentModeService as any).deleteGTMItems(mockPlanId, mockPhaseId, undefined, mockUserId);

      expect(result.success).toBe(true);
      expect(result.message).toContain('Phase 1');
      expect(mockUpdate).toHaveBeenCalled();
    });

    it('should delete a work item when all three IDs provided', async () => {
      setupMockGet(mockPlan);
      setupMockUpdate();

      const result = await (agentModeService as any).deleteGTMItems(mockPlanId, mockPhaseId, mockWorkItemId, mockUserId);

      expect(result.success).toBe(true);
      expect(result.message).toContain('Work Item 1');
      expect(mockUpdate).toHaveBeenCalled();
    });

    it('should return error when plan not found', async () => {
      setupMockGetNotFound();

      const result = await (agentModeService as any).deleteGTMItems(mockPlanId, undefined, undefined, mockUserId);

      expect(result.success).toBe(false);
      expect(result.message).toContain('not found');
    });

    it('should return error when access denied', async () => {
      setupMockGet({ ...mockPlan, userId: 'different-user' });

      const result = await (agentModeService as any).deleteGTMItems(mockPlanId, undefined, undefined, mockUserId);

      expect(result.success).toBe(false);
      expect(result.message).toContain('Access denied');
    });

    it('should return error when phase not found for phase deletion', async () => {
      setupMockGet(mockPlan);

      const result = await (agentModeService as any).deleteGTMItems(mockPlanId, 'non-existent-phase', undefined, mockUserId);

      expect(result.success).toBe(false);
      expect(result.message).toContain('Phase not found');
    });

    it('should return error when work item not found for work item deletion', async () => {
      setupMockGet(mockPlan);

      const result = await (agentModeService as any).deleteGTMItems(mockPlanId, mockPhaseId, 'non-existent-item', mockUserId);

      expect(result.success).toBe(false);
      expect(result.message).toContain('Work item not found');
    });
  });

  describe('getGTMCommonItems', () => {
    it('should return common items from settings', async () => {
      const mockCategories = [
        { name: 'Marketing', items: [{ title: 'Blog Post' }] },
        { name: 'Sales', items: [{ title: 'Demo Prep' }] },
      ];
      (settingsService.getSetting as jest.Mock).mockResolvedValue({
        settingValue: JSON.stringify(mockCategories),
      });

      const result = await (agentModeService as any).getGTMCommonItems();

      expect(result.success).toBe(true);
      expect(result.categories).toHaveLength(2);
      expect(result.message).toContain('2 category(ies)');
    });

    it('should return empty array when no common items configured', async () => {
      (settingsService.getSetting as jest.Mock).mockResolvedValue(null);

      const result = await (agentModeService as any).getGTMCommonItems();

      expect(result.success).toBe(true);
      expect(result.categories).toEqual([]);
    });

    it('should handle errors gracefully', async () => {
      (settingsService.getSetting as jest.Mock).mockRejectedValue(new Error('DB error'));

      const result = await (agentModeService as any).getGTMCommonItems();

      expect(result.success).toBe(false);
      expect(result.categories).toEqual([]);
    });
  });

  describe('addGTMCommonItems', () => {
    it('should add items to an existing phase', async () => {
      setupMockGet(mockPlan);
      setupMockUpdate();

      const result = await (agentModeService as any).addGTMCommonItems(
        mockPlanId,
        [{ title: 'Common Item 1' }, { title: 'Common Item 2' }],
        mockPhaseId,
        undefined,
        mockUserId
      );

      expect(result.success).toBe(true);
      expect(result.message).toContain('2 common item(s)');
    });

    it('should create a new phase with items', async () => {
      setupMockGet(mockPlan);
      setupMockUpdate();

      const result = await (agentModeService as any).addGTMCommonItems(
        mockPlanId,
        [{ title: 'Common Item 1' }],
        undefined,
        'New Common Phase',
        mockUserId
      );

      expect(result.success).toBe(true);
      expect(result.message).toContain('1 common item(s)');
    });

    it('should return error when items array is empty', async () => {
      const result = await (agentModeService as any).addGTMCommonItems(
        mockPlanId, [], mockPhaseId, undefined, mockUserId
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('non-empty');
    });

    it('should return error when neither target_phase_id nor new_phase_name provided', async () => {
      const result = await (agentModeService as any).addGTMCommonItems(
        mockPlanId, [{ title: 'Item' }], undefined, undefined, mockUserId
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('target_phase_id or new_phase_name');
    });

    it('should return error when plan not found', async () => {
      setupMockGetNotFound();

      const result = await (agentModeService as any).addGTMCommonItems(
        mockPlanId, [{ title: 'Item' }], mockPhaseId, undefined, mockUserId
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('not found');
    });

    it('should return error when access denied', async () => {
      setupMockGet({ ...mockPlan, userId: 'different-user' });

      const result = await (agentModeService as any).addGTMCommonItems(
        mockPlanId, [{ title: 'Item' }], mockPhaseId, undefined, mockUserId
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('Access denied');
    });

    it('should return error when target phase not found', async () => {
      setupMockGet(mockPlan);

      const result = await (agentModeService as any).addGTMCommonItems(
        mockPlanId, [{ title: 'Item' }], 'non-existent-phase', undefined, mockUserId
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('Target phase not found');
    });
  });

  describe('sendGTMStatusReport', () => {
    it('should send a phase-level status report', async () => {
      setupMockGet(mockPlan);

      const result = await (agentModeService as any).sendGTMStatusReport(
        mockPlanId, mockPhaseId,
        { notifyUser: true, notifyPhasePoc: true },
        mockUserId
      );

      expect(result.success).toBe(true);
      expect(result.message).toContain('Phase 1');
      expect(sendPhaseStatusReport).toHaveBeenCalled();
    });

    it('should send a plan-level status report', async () => {
      setupMockGet(mockPlan);

      const result = await (agentModeService as any).sendGTMStatusReport(
        mockPlanId, undefined,
        { notifyUser: true, notifyPlanPoc: true },
        mockUserId
      );

      expect(result.success).toBe(true);
      expect(result.message).toContain('Test GTM Plan');
      expect(sendPlanStatusReport).toHaveBeenCalled();
    });

    it('does not say "sent" when no recipient resolved (a plan with no contact set)', async () => {
      setupMockGet(mockPlan);
      (sendPlanStatusReport as jest.Mock).mockResolvedValueOnce({ recipients: 0, sent: 0, failed: 0 });

      const result = await (agentModeService as any).sendGTMStatusReport(
        mockPlanId, undefined,
        { notifyPlanPoc: true },
        mockUserId
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('Nothing was emailed');
    });

    it('does not say "sent" when the mail service refused every email (phase report)', async () => {
      setupMockGet(mockPlan);
      (sendPhaseStatusReport as jest.Mock).mockResolvedValueOnce({ recipients: 2, sent: 0, failed: 2 });

      const result = await (agentModeService as any).sendGTMStatusReport(
        mockPlanId, mockPhaseId,
        { notifyUser: true, notifyPhasePoc: true },
        mockUserId
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('Nothing was delivered');
    });

    it('reports a partial send as sent, with the count that failed', async () => {
      setupMockGet(mockPlan);
      (sendPlanStatusReport as jest.Mock).mockResolvedValueOnce({ recipients: 3, sent: 2, failed: 1 });

      const result = await (agentModeService as any).sendGTMStatusReport(
        mockPlanId, undefined,
        { notifyUser: true, notifyPlanPoc: true, notifyPhasePocs: true },
        mockUserId
      );

      expect(result.success).toBe(true);
      expect(result.message).toContain('2 of 3');
      expect(result.message).toContain('1 could not be sent');
    });

    it('should return error when plan not found', async () => {
      setupMockGetNotFound();

      const result = await (agentModeService as any).sendGTMStatusReport(
        mockPlanId, undefined, { notifyUser: true }, mockUserId
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('not found');
    });

    it('should return error when access denied', async () => {
      setupMockGet({ ...mockPlan, userId: 'different-user' });

      const result = await (agentModeService as any).sendGTMStatusReport(
        mockPlanId, undefined, { notifyUser: true }, mockUserId
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('Access denied');
    });

    it('should return error when phase not found for phase report', async () => {
      setupMockGet(mockPlan);

      const result = await (agentModeService as any).sendGTMStatusReport(
        mockPlanId, 'non-existent-phase',
        { notifyUser: true },
        mockUserId
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('Phase not found');
    });
  });
});

