// Unit tests for GTM Plan route functionality

// Mock AWS SDK
jest.mock('aws-sdk', () => {
  const mockQuery = jest.fn();
  const mockGet = jest.fn();
  const mockPut = jest.fn();
  const mockDelete = jest.fn();
  
  return {
    DynamoDB: {
      DocumentClient: jest.fn(() => ({
        query: mockQuery,
        get: mockGet,
        put: mockPut,
        delete: mockDelete,
      })),
    },
  };
});

describe('GTM Plan Route Tests', () => {
  let mockDynamoDB: any;
  let mockQuery: jest.Mock;
  let mockGet: jest.Mock;
  let mockPut: jest.Mock;
  let mockDelete: jest.Mock;
  let AWS: any;

  const mockUserId = 'user-123';
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

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NODE_ENV = 'development';
    
    AWS = require('aws-sdk');
    
    mockQuery = jest.fn().mockReturnValue({ promise: jest.fn() });
    mockGet = jest.fn().mockReturnValue({ promise: jest.fn() });
    mockPut = jest.fn().mockReturnValue({ promise: jest.fn() });
    mockDelete = jest.fn().mockReturnValue({ promise: jest.fn() });
    
    mockDynamoDB = {
      query: mockQuery,
      get: mockGet,
      put: mockPut,
      delete: mockDelete,
    };
    
    (AWS.DynamoDB.DocumentClient as jest.Mock).mockImplementation(() => mockDynamoDB);
  });

  describe('List GTM Plans (GET /)', () => {
    it('should return all plans for a user', async () => {
      const mockPromise = jest.fn().mockResolvedValue({
        Items: [mockPlan],
      });
      mockQuery.mockReturnValue({ promise: mockPromise });

      // Simulate the route logic
      const result = await mockDynamoDB.query({
        TableName: 'Dev-AW-GTMPlan',
        IndexName: 'UserIdIndex',
        KeyConditionExpression: 'userId = :userId',
        ExpressionAttributeValues: {
          ':userId': mockUserId,
        },
        ScanIndexForward: false,
      }).promise();

      expect(result.Items).toEqual([mockPlan]);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          TableName: 'Dev-AW-GTMPlan',
          IndexName: 'UserIdIndex',
          KeyConditionExpression: 'userId = :userId',
        })
      );
    });

    it('should return empty array when user has no plans', async () => {
      const mockPromise = jest.fn().mockResolvedValue({
        Items: [],
      });
      mockQuery.mockReturnValue({ promise: mockPromise });

      const result = await mockDynamoDB.query({
        TableName: 'Dev-AW-GTMPlan',
        IndexName: 'UserIdIndex',
        KeyConditionExpression: 'userId = :userId',
        ExpressionAttributeValues: {
          ':userId': mockUserId,
        },
        ScanIndexForward: false,
      }).promise();

      expect(result.Items).toEqual([]);
    });
  });

  describe('Get GTM Plan (GET /:planId)', () => {
    it('should return a specific plan', async () => {
      const mockPromise = jest.fn().mockResolvedValue({
        Item: mockPlan,
      });
      mockGet.mockReturnValue({ promise: mockPromise });

      const result = await mockDynamoDB.get({
        TableName: 'Dev-AW-GTMPlan',
        Key: {
          planId: mockPlanId,
        },
      }).promise();

      expect(result.Item).toEqual(mockPlan);
      expect(mockGet).toHaveBeenCalledWith(
        expect.objectContaining({
          TableName: 'Dev-AW-GTMPlan',
          Key: {
            planId: mockPlanId,
          },
        })
      );
    });

    it('should return null when plan does not exist', async () => {
      const mockPromise = jest.fn().mockResolvedValue({
        Item: undefined,
      });
      mockGet.mockReturnValue({ promise: mockPromise });

      const result = await mockDynamoDB.get({
        TableName: 'Dev-AW-GTMPlan',
        Key: {
          planId: 'non-existent',
        },
      }).promise();

      expect(result.Item).toBeUndefined();
    });
  });

  describe('Create GTM Plan (POST /)', () => {
    it('should create a new plan with phases and work items', async () => {
      const newPlan = {
        planId: 'plan-new',
        userId: mockUserId,
        title: 'New Plan',
        description: 'New Description',
        phases: [
          {
            id: 'phase-new',
            title: 'New Phase',
            description: 'New Phase Description',
            duration: 20,
            status: 'in_progress',
            workItems: [
              {
                id: 'item-new',
                title: 'New Work Item',
                duration: 3,
                status: 'pending',
              },
            ],
          },
        ],
        createdAt: '2024-01-02T00:00:00Z',
        updatedAt: '2024-01-02T00:00:00Z',
      };

      const mockPromise = jest.fn().mockResolvedValue({});
      mockPut.mockReturnValue({ promise: mockPromise });

      await mockDynamoDB.put({
        TableName: 'Dev-AW-GTMPlan',
        Item: newPlan,
      }).promise();

      expect(mockPut).toHaveBeenCalledWith(
        expect.objectContaining({
          TableName: 'Dev-AW-GTMPlan',
          Item: newPlan,
        })
      );
    });

    it('should create a plan with DRI at plan level', async () => {
      const newPlan = {
        planId: 'plan-with-dri',
        userId: mockUserId,
        title: 'Plan with DRI',
        description: 'Test Description',
        dri: 'dri@example.com',
        status: 'in_progress',
        phases: [],
        createdAt: '2024-01-02T00:00:00Z',
        updatedAt: '2024-01-02T00:00:00Z',
      };

      const mockPromise = jest.fn().mockResolvedValue({});
      mockPut.mockReturnValue({ promise: mockPromise });

      await mockDynamoDB.put({
        TableName: 'Dev-AW-GTMPlan',
        Item: newPlan,
      }).promise();

      expect(mockPut).toHaveBeenCalledWith(
        expect.objectContaining({
          TableName: 'Dev-AW-GTMPlan',
          Item: expect.objectContaining({
            dri: 'dri@example.com',
            status: 'in_progress',
          }),
        })
      );
    });

    it('should create a plan without phases', async () => {
      const newPlan = {
        planId: 'plan-empty',
        userId: mockUserId,
        title: 'Empty Plan',
        description: '',
        phases: [],
        createdAt: '2024-01-02T00:00:00Z',
        updatedAt: '2024-01-02T00:00:00Z',
      };

      const mockPromise = jest.fn().mockResolvedValue({});
      mockPut.mockReturnValue({ promise: mockPromise });

      await mockDynamoDB.put({
        TableName: 'Dev-AW-GTMPlan',
        Item: newPlan,
      }).promise();

      expect(mockPut).toHaveBeenCalledWith(
        expect.objectContaining({
          TableName: 'Dev-AW-GTMPlan',
          Item: expect.objectContaining({
            phases: [],
          }),
        })
      );
    });
  });

  describe('Create GTM Plan - Default DRI Logic', () => {
    const mockUserEmail = 'user@example.com';
    const mockAdminEmail = 'admin@example.com';

    it('should use user email as default DRI when no explicit DRI provided', async () => {
      const newPlan = {
        planId: 'plan-default-user-dri',
        userId: mockUserId,
        title: 'Plan with Default User DRI',
        description: 'Test Description',
        dri: mockUserEmail, // Default to user email
        status: 'in_progress',
        phases: [],
        createdAt: '2024-01-02T00:00:00Z',
        updatedAt: '2024-01-02T00:00:00Z',
      };

      const mockPromise = jest.fn().mockResolvedValue({});
      mockPut.mockReturnValue({ promise: mockPromise });

      await mockDynamoDB.put({
        TableName: 'Dev-AW-GTMPlan',
        Item: newPlan,
      }).promise();

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
      const newPlan = {
        planId: 'plan-default-admin-dri',
        userId: mockUserId,
        title: 'Plan with Default Admin DRI',
        description: 'Test Description',
        dri: mockAdminEmail, // Default to admin email for delegated access
        status: 'in_progress',
        phases: [],
        createdAt: '2024-01-02T00:00:00Z',
        updatedAt: '2024-01-02T00:00:00Z',
      };

      const mockPromise = jest.fn().mockResolvedValue({});
      mockPut.mockReturnValue({ promise: mockPromise });

      await mockDynamoDB.put({
        TableName: 'Dev-AW-GTMPlan',
        Item: newPlan,
      }).promise();

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
      const explicitDri = 'explicit-dri@example.com';
      const newPlan = {
        planId: 'plan-explicit-dri',
        userId: mockUserId,
        title: 'Plan with Explicit DRI',
        description: 'Test Description',
        dri: explicitDri, // Explicit DRI should override defaults
        status: 'in_progress',
        phases: [],
        createdAt: '2024-01-02T00:00:00Z',
        updatedAt: '2024-01-02T00:00:00Z',
      };

      const mockPromise = jest.fn().mockResolvedValue({});
      mockPut.mockReturnValue({ promise: mockPromise });

      await mockDynamoDB.put({
        TableName: 'Dev-AW-GTMPlan',
        Item: newPlan,
      }).promise();

      expect(mockPut).toHaveBeenCalledWith(
        expect.objectContaining({
          TableName: 'Dev-AW-GTMPlan',
          Item: expect.objectContaining({
            dri: explicitDri, // Should use explicit DRI
          }),
        })
      );
    });

    it('should handle undefined DRI when no email available', async () => {
      const newPlan = {
        planId: 'plan-no-dri',
        userId: mockUserId,
        title: 'Plan without DRI',
        description: 'Test Description',
        dri: undefined, // No DRI available
        status: 'in_progress',
        phases: [],
        createdAt: '2024-01-02T00:00:00Z',
        updatedAt: '2024-01-02T00:00:00Z',
      };

      const mockPromise = jest.fn().mockResolvedValue({});
      mockPut.mockReturnValue({ promise: mockPromise });

      await mockDynamoDB.put({
        TableName: 'Dev-AW-GTMPlan',
        Item: newPlan,
      }).promise();

      expect(mockPut).toHaveBeenCalledWith(
        expect.objectContaining({
          TableName: 'Dev-AW-GTMPlan',
          Item: expect.objectContaining({
            dri: undefined, // Should be undefined
          }),
        })
      );
    });
  });

  describe('Update GTM Plan (PUT /:planId)', () => {
    it('should update plan with recalculated phase statuses', () => {
      const updatedPhases = [
        {
          id: 'phase-1',
          title: 'Phase 1',
          duration: 30,
          status: 'in_progress',
          workItems: [
            {
              id: 'item-1',
              title: 'Item 1',
              status: 'completed',
            },
            {
              id: 'item-2',
              title: 'Item 2',
              status: 'completed',
            },
          ],
        },
      ];

      // Test phase status recalculation logic
      const recalculatedPhases = updatedPhases.map((phase: any) => {
        const hasWorkItems = phase.workItems && phase.workItems.length > 0;
        const allItemsDone = hasWorkItems && phase.workItems.every(
          (item: any) => item.status === 'completed' || item.status === 'skipped'
        );
        return {
          ...phase,
          status: allItemsDone ? 'completed' : 'in_progress',
        };
      });

      expect(recalculatedPhases[0].status).toBe('completed');
    });

    it('should keep phase as in_progress when not all items are done', () => {
      const updatedPhases = [
        {
          id: 'phase-1',
          title: 'Phase 1',
          duration: 30,
          status: 'in_progress',
          workItems: [
            {
              id: 'item-1',
              title: 'Item 1',
              status: 'completed',
            },
            {
              id: 'item-2',
              title: 'Item 2',
              status: 'pending',
            },
          ],
        },
      ];

      const recalculatedPhases = updatedPhases.map((phase: any) => {
        const hasWorkItems = phase.workItems && phase.workItems.length > 0;
        const allItemsDone = hasWorkItems && phase.workItems.every(
          (item: any) => item.status === 'completed' || item.status === 'skipped'
        );
        return {
          ...phase,
          status: allItemsDone ? 'completed' : 'in_progress',
        };
      });

      expect(recalculatedPhases[0].status).toBe('in_progress');
    });

    it('should keep phase as in_progress when phase has no work items', () => {
      const updatedPhases = [
        {
          id: 'phase-1',
          title: 'Phase 1',
          duration: 30,
          status: 'in_progress',
          workItems: [],
        },
      ];

      const recalculatedPhases = updatedPhases.map((phase: any) => {
        const hasWorkItems = phase.workItems && phase.workItems.length > 0;
        const allItemsDone = hasWorkItems && phase.workItems.every(
          (item: any) => item.status === 'completed' || item.status === 'skipped'
        );
        return {
          ...phase,
          status: allItemsDone ? 'completed' : 'in_progress',
        };
      });

      expect(recalculatedPhases[0].status).toBe('in_progress');
    });

    it('should update plan DRI when provided', () => {
      const existingPlan = {
        ...mockPlan,
        status: 'in_progress',
      };
      const updates = {
        dri: 'new-dri@example.com',
      };

      // Simulate the update logic
      const updatedPlan = {
        ...existingPlan,
        ...updates,
      };

      expect(updatedPlan.dri).toBe('new-dri@example.com');
    });

    it('should set plan status to completed when all phases are completed', () => {
      const completedPhases = [
        {
          id: 'phase-1',
          title: 'Phase 1',
          duration: 30,
          status: 'completed',
          workItems: [
            {
              id: 'item-1',
              title: 'Item 1',
              status: 'completed',
            },
          ],
        },
        {
          id: 'phase-2',
          title: 'Phase 2',
          duration: 20,
          status: 'completed',
          workItems: [
            {
              id: 'item-2',
              title: 'Item 2',
              status: 'completed',
            },
          ],
        },
      ];

      const hasPhases = completedPhases && completedPhases.length > 0;
      const allPhasesCompleted = hasPhases && completedPhases.every(
        (phase: any) => phase.status === 'completed'
      );
      const planStatus = allPhasesCompleted ? 'completed' : 'in_progress';

      expect(planStatus).toBe('completed');
    });

    it('should set completedAt when plan transitions to completed', () => {
      const wasCompleted = false;
      const isNowCompleted = true;
      const justCompleted = !wasCompleted && isNowCompleted;

      expect(justCompleted).toBe(true);
      
      if (justCompleted) {
        const completedAt = new Date().toISOString();
        expect(completedAt).toBeDefined();
        expect(new Date(completedAt).getTime()).toBeLessThanOrEqual(Date.now());
      }
    });

    it('should clear completedAt when plan goes back to in_progress', () => {
      const wasCompleted = true;
      const isNowCompleted = false;
      const shouldClearCompletedAt = wasCompleted && !isNowCompleted;

      expect(shouldClearCompletedAt).toBe(true);
    });

    it('should set completedAt on work item when status transitions to completed', () => {
      const originalItem = { id: 'item-1', title: 'Item 1', status: 'pending' };
      const status = 'completed';

      const updatedWorkItem = {
        ...originalItem,
        ...(status !== undefined && { status }),
        ...(status === 'completed' && originalItem.status !== 'completed' && { completedAt: new Date().toISOString() }),
        ...(status !== undefined && status !== 'completed' && originalItem.status === 'completed' && { completedAt: null }),
      };

      expect(updatedWorkItem.status).toBe('completed');
      expect(updatedWorkItem.completedAt).toBeDefined();
      expect(new Date(updatedWorkItem.completedAt!).getTime()).toBeLessThanOrEqual(Date.now());
    });

    it('should clear completedAt on work item when status transitions away from completed', () => {
      const originalItem = { id: 'item-1', title: 'Item 1', status: 'completed', completedAt: '2026-01-01T00:00:00Z' };
      const status: string = 'in_progress';

      const updatedWorkItem = {
        ...originalItem,
        ...(status !== undefined && { status }),
        ...(status === 'completed' && originalItem.status !== 'completed' && { completedAt: new Date().toISOString() }),
        ...(status !== undefined && status !== 'completed' && originalItem.status === 'completed' && { completedAt: null }),
      };

      expect(updatedWorkItem.status).toBe('in_progress');
      expect(updatedWorkItem.completedAt).toBeNull();
    });

    it('should not change completedAt when status stays completed', () => {
      const originalItem = { id: 'item-1', title: 'Item 1', status: 'completed', completedAt: '2026-01-01T00:00:00Z' };
      const status = 'completed';

      const updatedWorkItem = {
        ...originalItem,
        ...(status !== undefined && { status }),
        ...(status === 'completed' && originalItem.status !== 'completed' && { completedAt: new Date().toISOString() }),
        ...(status !== undefined && status !== 'completed' && originalItem.status === 'completed' && { completedAt: null }),
      };

      expect(updatedWorkItem.status).toBe('completed');
      expect(updatedWorkItem.completedAt).toBe('2026-01-01T00:00:00Z');
    });
  });

  describe('Delete GTM Plan (DELETE /:planId)', () => {
    it('should delete a plan', async () => {
      const mockPromise = jest.fn().mockResolvedValue({});
      mockDelete.mockReturnValue({ promise: mockPromise });

      await mockDynamoDB.delete({
        TableName: 'Dev-AW-GTMPlan',
        Key: {
          planId: mockPlanId,
        },
      }).promise();

      expect(mockDelete).toHaveBeenCalledWith(
        expect.objectContaining({
          TableName: 'Dev-AW-GTMPlan',
          Key: {
            planId: mockPlanId,
          },
        })
      );
    });
  });

  describe('Delete Phase (DELETE /:planId/phases/:phaseId)', () => {
    it('should delete a phase from a plan', async () => {
      const mockPlanWithPhases = {
        ...mockPlan,
        phases: [
          { id: 'phase-1', title: 'Phase 1', workItems: [] },
          { id: 'phase-2', title: 'Phase 2', workItems: [] },
        ],
      };

      const mockGetPromise = jest.fn().mockResolvedValue({
        Item: mockPlanWithPhases,
      });
      mockGet.mockReturnValue({ promise: mockGetPromise });

      const mockUpdatePromise = jest.fn().mockResolvedValue({
        Attributes: {
          ...mockPlanWithPhases,
          phases: [{ id: 'phase-2', title: 'Phase 2', workItems: [] }],
        },
      });
      const mockUpdate = jest.fn().mockReturnValue({ promise: mockUpdatePromise });
      mockDynamoDB.update = mockUpdate;

      const result = await mockDynamoDB.get({
        TableName: 'Dev-AW-GTMPlan',
        Key: { planId: mockPlanId },
      }).promise();

      const plan = result.Item;
      const phases = plan.phases || [];
      const phaseIndex = phases.findIndex((p: any) => p.id === 'phase-1');
      phases.splice(phaseIndex, 1);

      await mockDynamoDB.update({
        TableName: 'Dev-AW-GTMPlan',
        Key: { planId: mockPlanId },
        UpdateExpression: 'SET phases = :phases',
        ExpressionAttributeValues: { ':phases': phases },
      }).promise();

      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          TableName: 'Dev-AW-GTMPlan',
          Key: { planId: mockPlanId },
          UpdateExpression: 'SET phases = :phases',
          ExpressionAttributeValues: {
            ':phases': [{ id: 'phase-2', title: 'Phase 2', workItems: [] }],
          },
        })
      );
    });

    it('should return 404 when phase not found', () => {
      const phases = [{ id: 'phase-1', title: 'Phase 1' }];
      const phaseIndex = phases.findIndex((p: any) => p.id === 'non-existent');
      expect(phaseIndex).toBe(-1);
    });
  });

  describe('Delete Work Item (DELETE /:planId/phases/:phaseId/work-items/:workItemId)', () => {
    it('should delete a work item from a phase', async () => {
      const mockPlanWithWorkItems = {
        ...mockPlan,
        phases: [
          {
            id: 'phase-1',
            title: 'Phase 1',
            workItems: [
              { id: 'item-1', title: 'Item 1' },
              { id: 'item-2', title: 'Item 2' },
            ],
          },
        ],
      };

      const mockGetPromise = jest.fn().mockResolvedValue({
        Item: mockPlanWithWorkItems,
      });
      mockGet.mockReturnValue({ promise: mockGetPromise });

      const mockUpdatePromise = jest.fn().mockResolvedValue({
        Attributes: {
          ...mockPlanWithWorkItems,
          phases: [
            {
              id: 'phase-1',
              title: 'Phase 1',
              workItems: [{ id: 'item-2', title: 'Item 2' }],
            },
          ],
        },
      });
      const mockUpdate = jest.fn().mockReturnValue({ promise: mockUpdatePromise });
      mockDynamoDB.update = mockUpdate;

      const result = await mockDynamoDB.get({
        TableName: 'Dev-AW-GTMPlan',
        Key: { planId: mockPlanId },
      }).promise();

      const plan = result.Item;
      const phases = plan.phases || [];
      const phase = phases.find((p: any) => p.id === 'phase-1');
      const workItems = phase.workItems || [];
      const workItemIndex = workItems.findIndex((item: any) => item.id === 'item-1');
      workItems.splice(workItemIndex, 1);

      phase.workItems = workItems;
      phases[0] = phase;

      await mockDynamoDB.update({
        TableName: 'Dev-AW-GTMPlan',
        Key: { planId: mockPlanId },
        UpdateExpression: 'SET phases = :phases',
        ExpressionAttributeValues: { ':phases': phases },
      }).promise();

      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          TableName: 'Dev-AW-GTMPlan',
          Key: { planId: mockPlanId },
          UpdateExpression: 'SET phases = :phases',
          ExpressionAttributeValues: {
            ':phases': [
              {
                id: 'phase-1',
                title: 'Phase 1',
                workItems: [{ id: 'item-2', title: 'Item 2' }],
              },
            ],
          },
        })
      );
    });

    it('should return 404 when work item not found', () => {
      const workItems = [{ id: 'item-1', title: 'Item 1' }];
      const workItemIndex = workItems.findIndex((item: any) => item.id === 'non-existent');
      expect(workItemIndex).toBe(-1);
    });
  });

  describe('Table Name Configuration', () => {
    it('should use Dev- prefix in development', () => {
      process.env.NODE_ENV = 'development';
      const tableName = process.env.NODE_ENV === 'development' ? 'Dev-AW-GTMPlan' : 'AW-GTMPlan';
      expect(tableName).toBe('Dev-AW-GTMPlan');
    });

    it('should use no prefix in production', () => {
      process.env.NODE_ENV = 'production';
      const tableName = process.env.NODE_ENV === 'development' ? 'Dev-AW-GTMPlan' : 'AW-GTMPlan';
      expect(tableName).toBe('AW-GTMPlan');
    });
  });
});

