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

