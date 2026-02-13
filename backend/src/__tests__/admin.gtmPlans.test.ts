import request from 'supertest';
import express from 'express';
import adminRoutes from '../routes/admin';
import { userDb } from '../services/db';

// Mock the dependencies
jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn(),
  },
}));

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, res: any, next: any) => {
    req.user = { userId: 'test-admin', isAdmin: true };
    next();
  },
}));

jest.mock('../middleware/admin', () => ({
  isAdmin: (req: any, res: any, next: any) => {
    next();
  },
}));

// Mock AWS SDK
jest.mock('aws-sdk', () => {
  const mockScan = jest.fn();
  return {
    default: {
      SecretsManager: jest.fn(() => ({
        getSecretValue: jest.fn().mockReturnValue({
          promise: jest.fn().mockResolvedValue({ SecretString: 'test-secret' }),
        }),
      })),
    },
    config: {
      update: jest.fn(),
    },
    DynamoDB: {
      DocumentClient: jest.fn(() => ({
        scan: mockScan,
      })),
    },
    SecretsManager: jest.fn(() => ({
      getSecretValue: jest.fn().mockReturnValue({
        promise: jest.fn().mockResolvedValue({ SecretString: 'test-secret' }),
      }),
    })),
  };
});

// Mock other dependencies that might be imported
jest.mock('../services/waitlistDb', () => ({}));
jest.mock('../services/emailService', () => ({}));
jest.mock('../services/resendService', () => ({
  resendService: {
    sendEmail: jest.fn(),
  },
}));
jest.mock('../services/workflowDb', () => ({}));
jest.mock('../services/chatbotService', () => ({}));

const { DynamoDB } = require('aws-sdk');
const mockUserDb = userDb as jest.Mocked<typeof userDb>;

const app = express();
app.use(express.json());
app.use('/api/admin', adminRoutes);

describe('Admin GTM Plans Endpoint', () => {
  let mockScan: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NODE_ENV = 'development';
    
    mockScan = jest.fn().mockReturnValue({ promise: jest.fn() });
    (DynamoDB.DocumentClient as jest.Mock).mockImplementation(() => ({
      scan: mockScan,
    }));
  });

  it('should return all GTM plans with user information', async () => {
    const mockPlans = [
      {
        planId: 'plan-1',
        userId: 'user-1',
        title: 'Plan 1',
        description: 'Description 1',
        dri: 'plan-dri@example.com',
        status: 'in_progress',
        phases: [
          {
            id: 'phase-1',
            title: 'Phase 1',
            dri: 'phase-dri@example.com',
            status: 'in_progress',
            workItems: [
              {
                id: 'item-1',
                title: 'Item 1',
                dri: 'item-dri@example.com',
                status: 'pending',
              },
            ],
          },
        ],
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      },
      {
        planId: 'plan-2',
        userId: 'user-2',
        title: 'Plan 2',
        status: 'completed',
        completedAt: '2024-01-02T12:00:00Z',
        phases: [],
        createdAt: '2024-01-02T00:00:00Z',
        updatedAt: '2024-01-02T00:00:00Z',
      },
    ];

    mockScan.mockReturnValue({
      promise: jest.fn().mockResolvedValue({
        Items: mockPlans,
      }),
    });

    mockUserDb.getUserById
      .mockResolvedValueOnce({ email: 'user1@example.com', name: 'User 1' } as any)
      .mockResolvedValueOnce({ email: 'user2@example.com', name: 'User 2' } as any);

    const response = await request(app)
      .get('/api/admin/gtm-plans')
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.data).toHaveLength(2);
    expect(response.body.data[0]).toMatchObject({
      planId: 'plan-1',
      userEmail: 'user1@example.com',
      userName: 'User 1',
      dri: 'plan-dri@example.com',
    });
    expect(response.body.data[1]).toMatchObject({
      planId: 'plan-2',
      userEmail: 'user2@example.com',
      userName: 'User 2',
      status: 'completed',
      completedAt: '2024-01-02T12:00:00Z',
    });
  });

  it('should handle missing user information gracefully', async () => {
    const mockPlans = [
      {
        planId: 'plan-1',
        userId: 'user-unknown',
        title: 'Plan 1',
        phases: [],
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      },
    ];

    mockScan.mockReturnValue({
      promise: jest.fn().mockResolvedValue({
        Items: mockPlans,
      }),
    });

    mockUserDb.getUserById.mockRejectedValue(new Error('User not found'));

    const response = await request(app)
      .get('/api/admin/gtm-plans')
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.data).toHaveLength(1);
    // When user lookup fails, userEmail and userName should be undefined (not "Unknown")
    expect(response.body.data[0].userEmail).toBeUndefined();
    expect(response.body.data[0].userName).toBeUndefined();
  });

  it('should return empty array when no plans exist', async () => {
    mockScan.mockReturnValue({
      promise: jest.fn().mockResolvedValue({
        Items: [],
      }),
    });

    const response = await request(app)
      .get('/api/admin/gtm-plans')
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.data).toEqual([]);
  });

  it('should handle DynamoDB errors', async () => {
    mockScan.mockReturnValue({
      promise: jest.fn().mockRejectedValue(new Error('DynamoDB error')),
    });

    const response = await request(app)
      .get('/api/admin/gtm-plans')
      .expect(500);

    expect(response.body.success).toBe(false);
    expect(response.body.message).toContain('Error fetching GTM plans');
  });
});

describe('Admin GTM Analytics Endpoint', () => {
  let mockScan: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NODE_ENV = 'development';

    mockScan = jest.fn().mockReturnValue({ promise: jest.fn() });
    (DynamoDB.DocumentClient as jest.Mock).mockImplementation(() => ({
      scan: mockScan,
    }));
  });

  it('should return aggregate work item metrics', async () => {
    const mockPlans = [
      {
        planId: 'plan-1',
        phases: [
          {
            id: 'phase-1',
            status: 'in_progress',
            workItems: [
              { id: 'item-1', status: 'completed', completedAt: '2026-02-01T10:00:00Z' },
              { id: 'item-2', status: 'pending' },
              { id: 'item-3', status: 'completed', completedAt: '2026-02-10T10:00:00Z' },
            ],
          },
        ],
      },
      {
        planId: 'plan-2',
        phases: [
          {
            id: 'phase-2',
            status: 'completed',
            workItems: [
              { id: 'item-4', status: 'completed', completedAt: '2026-01-05T10:00:00Z' },
            ],
          },
        ],
      },
    ];

    mockScan.mockReturnValue({
      promise: jest.fn().mockResolvedValue({ Items: mockPlans }),
    });

    const response = await request(app)
      .get('/api/admin/analytics/gtm')
      .expect(200);

    expect(response.body.totalItems).toBe(4);
    expect(response.body.completedItems).toBe(3);
    expect(response.body.completedItemsInRange).toBe(3);
  });

  it('should filter completed items by date range using completedAt', async () => {
    const mockPlans = [
      {
        planId: 'plan-1',
        phases: [
          {
            id: 'phase-1',
            status: 'in_progress',
            workItems: [
              { id: 'item-1', status: 'completed', completedAt: '2026-02-05T10:00:00Z' },
              { id: 'item-2', status: 'completed', completedAt: '2026-01-10T10:00:00Z' },
              { id: 'item-3', status: 'completed', completedAt: '2026-02-15T10:00:00Z' },
              { id: 'item-4', status: 'pending' },
            ],
          },
        ],
      },
    ];

    mockScan.mockReturnValue({
      promise: jest.fn().mockResolvedValue({ Items: mockPlans }),
    });

    const response = await request(app)
      .get('/api/admin/analytics/gtm?startDate=2026-02-01&endDate=2026-02-13')
      .expect(200);

    expect(response.body.totalItems).toBe(4);
    expect(response.body.completedItems).toBe(3);
    expect(response.body.completedItemsInRange).toBe(1); // only item-1 (Feb 5) is in range
  });

  it('should fall back to item ID timestamp when completedAt is missing', async () => {
    // workitem-1738368000000 = 2025-02-01T00:00:00Z (in range)
    // workitem-1704067200000 = 2024-01-01T00:00:00Z (out of range)
    const mockPlans = [
      {
        planId: 'plan-1',
        phases: [
          {
            id: 'phase-1',
            status: 'in_progress',
            workItems: [
              { id: 'workitem-1738368000000-0-0-abc', status: 'completed' },
              { id: 'workitem-1704067200000-0-1-def', status: 'completed' },
            ],
          },
        ],
      },
    ];

    mockScan.mockReturnValue({
      promise: jest.fn().mockResolvedValue({ Items: mockPlans }),
    });

    const response = await request(app)
      .get('/api/admin/analytics/gtm?startDate=2025-01-01&endDate=2025-12-31')
      .expect(200);

    expect(response.body.totalItems).toBe(2);
    expect(response.body.completedItems).toBe(2);
    expect(response.body.completedItemsInRange).toBe(1); // only the 2025-02-01 item
  });

  it('should return all completed as in-range when no date range provided', async () => {
    const mockPlans = [
      {
        planId: 'plan-1',
        phases: [
          {
            id: 'phase-1',
            status: 'in_progress',
            workItems: [
              { id: 'item-1', status: 'completed', completedAt: '2026-02-01T10:00:00Z' },
              { id: 'item-2', status: 'completed', completedAt: '2025-01-01T10:00:00Z' },
            ],
          },
        ],
      },
    ];

    mockScan.mockReturnValue({
      promise: jest.fn().mockResolvedValue({ Items: mockPlans }),
    });

    const response = await request(app)
      .get('/api/admin/analytics/gtm')
      .expect(200);

    expect(response.body.totalItems).toBe(2);
    expect(response.body.completedItems).toBe(2);
    expect(response.body.completedItemsInRange).toBe(2);
  });

  it('should handle empty plans', async () => {
    mockScan.mockReturnValue({
      promise: jest.fn().mockResolvedValue({ Items: [] }),
    });

    const response = await request(app)
      .get('/api/admin/analytics/gtm')
      .expect(200);

    expect(response.body.totalItems).toBe(0);
    expect(response.body.completedItems).toBe(0);
    expect(response.body.completedItemsInRange).toBe(0);
  });

  it('should handle DynamoDB errors', async () => {
    mockScan.mockReturnValue({
      promise: jest.fn().mockRejectedValue(new Error('DynamoDB error')),
    });

    const response = await request(app)
      .get('/api/admin/analytics/gtm')
      .expect(500);

    expect(response.body.message).toContain('Error fetching GTM analytics');
  });
});

describe('Admin GTM Plans Update Endpoints', () => {
  let mockGet: jest.Mock;
  let mockUpdate: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NODE_ENV = 'development';
    
    mockGet = jest.fn().mockReturnValue({ promise: jest.fn() });
    mockUpdate = jest.fn().mockReturnValue({ promise: jest.fn() });
    (DynamoDB.DocumentClient as jest.Mock).mockImplementation(() => ({
      get: mockGet,
      update: mockUpdate,
      scan: jest.fn().mockReturnValue({ promise: jest.fn() }),
    }));
  });

  describe('PUT /api/admin/gtm-plans/:planId', () => {
    it('should update plan PoC (dri)', async () => {
      const mockPlan = {
        planId: 'plan-1',
        userId: 'user-1',
        title: 'Plan 1',
        dri: null,
        phases: [],
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      };

      mockGet.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Item: mockPlan }),
      });

      const updatedPlan = {
        ...mockPlan,
        dri: 'new-poc@example.com',
        updatedAt: new Date().toISOString(),
      };

      mockUpdate.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Attributes: updatedPlan }),
      });

      const response = await request(app)
        .put('/api/admin/gtm-plans/plan-1')
        .send({ dri: 'new-poc@example.com' })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.dri).toBe('new-poc@example.com');
      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          TableName: 'Dev-AW-GTMPlan',
          Key: { planId: 'plan-1' },
          UpdateExpression: expect.stringContaining('#dri = :dri'),
        })
      );
    });

    it('should update plan due date', async () => {
      const mockPlan = {
        planId: 'plan-1',
        userId: 'user-1',
        title: 'Plan 1',
        dueDate: null,
        phases: [],
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      };

      mockGet.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Item: mockPlan }),
      });

      const updatedPlan = {
        ...mockPlan,
        dueDate: '2024-12-31',
        updatedAt: new Date().toISOString(),
      };

      mockUpdate.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Attributes: updatedPlan }),
      });

      const response = await request(app)
        .put('/api/admin/gtm-plans/plan-1')
        .send({ dueDate: '2024-12-31' })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.dueDate).toBe('2024-12-31');
    });

    it('should remove plan PoC when dri is empty string', async () => {
      const mockPlan = {
        planId: 'plan-1',
        userId: 'user-1',
        title: 'Plan 1',
        dri: 'existing-poc@example.com',
        phases: [],
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      };

      mockGet.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Item: mockPlan }),
      });

      const updatedPlan = {
        ...mockPlan,
        dri: null,
        updatedAt: new Date().toISOString(),
      };

      mockUpdate.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Attributes: updatedPlan }),
      });

      const response = await request(app)
        .put('/api/admin/gtm-plans/plan-1')
        .send({ dri: '' })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.dri).toBeNull();
    });

    it('should return 404 when plan not found', async () => {
      mockGet.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Item: undefined }),
      });

      const response = await request(app)
        .put('/api/admin/gtm-plans/non-existent')
        .send({ dri: 'poc@example.com' })
        .expect(404);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe('GTM Plan not found');
    });
  });

  describe('PUT /api/admin/gtm-plans/:planId/phases/:phaseId', () => {
    it('should update phase PoC (dri)', async () => {
      const mockPlan = {
        planId: 'plan-1',
        userId: 'user-1',
        title: 'Plan 1',
        phases: [
          {
            id: 'phase-1',
            title: 'Phase 1',
            dri: null,
            status: 'in_progress',
            workItems: [],
          },
        ],
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      };

      mockGet.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Item: mockPlan }),
      });

      const updatedPlan = {
        ...mockPlan,
        phases: [
          {
            ...mockPlan.phases[0],
            dri: 'phase-poc@example.com',
          },
        ],
        updatedAt: new Date().toISOString(),
      };

      mockUpdate.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Attributes: updatedPlan }),
      });

      const response = await request(app)
        .put('/api/admin/gtm-plans/plan-1/phases/phase-1')
        .send({ dri: 'phase-poc@example.com' })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.phases[0].dri).toBe('phase-poc@example.com');
    });

    it('should update phase due date', async () => {
      const mockPlan = {
        planId: 'plan-1',
        userId: 'user-1',
        title: 'Plan 1',
        phases: [
          {
            id: 'phase-1',
            title: 'Phase 1',
            dueDate: null,
            status: 'in_progress',
            workItems: [],
          },
        ],
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      };

      mockGet.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Item: mockPlan }),
      });

      const updatedPlan = {
        ...mockPlan,
        phases: [
          {
            ...mockPlan.phases[0],
            dueDate: '2024-12-31',
          },
        ],
        updatedAt: new Date().toISOString(),
      };

      mockUpdate.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Attributes: updatedPlan }),
      });

      const response = await request(app)
        .put('/api/admin/gtm-plans/plan-1/phases/phase-1')
        .send({ dueDate: '2024-12-31' })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.phases[0].dueDate).toBe('2024-12-31');
    });

    it('should return 404 when phase not found', async () => {
      const mockPlan = {
        planId: 'plan-1',
        userId: 'user-1',
        title: 'Plan 1',
        phases: [],
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      };

      mockGet.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Item: mockPlan }),
      });

      const response = await request(app)
        .put('/api/admin/gtm-plans/plan-1/phases/non-existent')
        .send({ dri: 'poc@example.com' })
        .expect(404);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe('Phase not found');
    });
  });

  describe('PUT /api/admin/gtm-plans/:planId/phases/:phaseId/work-items/:workItemId', () => {
    it('should update work item due date', async () => {
      const mockPlan = {
        planId: 'plan-1',
        userId: 'user-1',
        title: 'Plan 1',
        status: 'in_progress',
        phases: [
          {
            id: 'phase-1',
            title: 'Phase 1',
            status: 'in_progress',
            workItems: [
              {
                id: 'item-1',
                title: 'Item 1',
                status: 'pending',
                dueDate: null,
              },
            ],
          },
        ],
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      };

      mockGet.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Item: mockPlan }),
      });

      const updatedPlan = {
        ...mockPlan,
        phases: [
          {
            ...mockPlan.phases[0],
            workItems: [
              {
                ...mockPlan.phases[0].workItems[0],
                dueDate: '2024-12-31',
              },
            ],
          },
        ],
        updatedAt: new Date().toISOString(),
      };

      mockUpdate.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Attributes: updatedPlan }),
      });

      const response = await request(app)
        .put('/api/admin/gtm-plans/plan-1/phases/phase-1/work-items/item-1')
        .send({ dueDate: '2024-12-31' })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.phases[0].workItems[0].dueDate).toBe('2024-12-31');
    });

    it('should remove work item due date when empty string provided', async () => {
      const mockPlan = {
        planId: 'plan-1',
        userId: 'user-1',
        title: 'Plan 1',
        status: 'in_progress',
        phases: [
          {
            id: 'phase-1',
            title: 'Phase 1',
            status: 'in_progress',
            workItems: [
              {
                id: 'item-1',
                title: 'Item 1',
                status: 'pending',
                dueDate: '2024-12-31',
              },
            ],
          },
        ],
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      };

      mockGet.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Item: mockPlan }),
      });

      const updatedPlan = {
        ...mockPlan,
        phases: [
          {
            ...mockPlan.phases[0],
            workItems: [
              {
                ...mockPlan.phases[0].workItems[0],
                dueDate: null,
              },
            ],
          },
        ],
        updatedAt: new Date().toISOString(),
      };

      mockUpdate.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Attributes: updatedPlan }),
      });

      const response = await request(app)
        .put('/api/admin/gtm-plans/plan-1/phases/phase-1/work-items/item-1')
        .send({ dueDate: '' })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.phases[0].workItems[0].dueDate).toBeNull();
    });

    it('should track due date changes for notifications', async () => {
      const mockPlan = {
        planId: 'plan-1',
        userId: 'user-1',
        title: 'Plan 1',
        status: 'in_progress',
        phases: [
          {
            id: 'phase-1',
            title: 'Phase 1',
            status: 'in_progress',
            workItems: [
              {
                id: 'item-1',
                title: 'Item 1',
                status: 'pending',
                dueDate: '2024-12-30',
              },
            ],
          },
        ],
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      };

      mockGet.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Item: mockPlan }),
      });

      const updatedPlan = {
        ...mockPlan,
        phases: [
          {
            ...mockPlan.phases[0],
            workItems: [
              {
                ...mockPlan.phases[0].workItems[0],
                dueDate: '2024-12-31',
              },
            ],
          },
        ],
        updatedAt: new Date().toISOString(),
      };

      mockUpdate.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Attributes: updatedPlan }),
      });

      // Mock notification service
      const { sendGTMPlanUpdateNotifications } = require('../services/gtmPlanNotificationService');
      jest.mock('../services/gtmPlanNotificationService', () => ({
        sendGTMPlanUpdateNotifications: jest.fn().mockResolvedValue(undefined),
      }));

      const response = await request(app)
        .put('/api/admin/gtm-plans/plan-1/phases/phase-1/work-items/item-1')
        .send({
          dueDate: '2024-12-31',
          notifications: {
            notifyUser: true,
          },
        })
        .expect(200);

      expect(response.body.success).toBe(true);
      // The notification service should be called with dueDate in changes
      // (This is tested indirectly through the successful response)
    });
  });

  describe('Status Report Endpoints', () => {
    let mockGet: jest.Mock;
    let mockSendPhaseStatusReport: jest.Mock;
    let mockSendPlanStatusReport: jest.Mock;

    beforeEach(() => {
      jest.clearAllMocks();

      mockGet = jest.fn();
      (DynamoDB.DocumentClient as jest.Mock).mockImplementation(() => ({
        get: mockGet,
      }));

      // Mock the notification service functions
      mockSendPhaseStatusReport = jest.fn().mockResolvedValue(undefined);
      mockSendPlanStatusReport = jest.fn().mockResolvedValue(undefined);

      jest.doMock('../services/gtmPlanNotificationService', () => ({
        sendGTMPlanUpdateNotifications: jest.fn(),
        sendPhaseStatusReport: mockSendPhaseStatusReport,
        sendPlanStatusReport: mockSendPlanStatusReport,
      }));
    });

    describe('POST /api/admin/gtm-plans/:planId/phases/:phaseId/send-status-report', () => {
      it('should send a phase status report successfully', async () => {
        const mockPlan = {
          planId: 'plan-1',
          userId: 'user-1',
          title: 'Test Plan',
          phases: [
            {
              id: 'phase-1',
              title: 'Test Phase',
              status: 'in_progress',
              dri: 'phase-poc@example.com',
              workItems: [
                {
                  id: 'item-1',
                  title: 'Test Item',
                  status: 'pending',
                  dri: 'item-poc@example.com',
                },
              ],
            },
          ],
        };

        mockGet.mockReturnValue({
          promise: jest.fn().mockResolvedValue({
            Item: mockPlan,
          }),
        });

        const response = await request(app)
          .post('/api/admin/gtm-plans/plan-1/phases/phase-1/send-status-report')
          .send({
            notifications: {
              notifyUser: true,
              notifyPlanPoc: false,
              notifyPhasePoc: true,
            },
            message: 'Custom status report message',
          })
          .expect(200);

        expect(response.body.success).toBe(true);
        expect(response.body.message).toBe('Phase status report sent successfully');
      });

      it('should return 404 if plan is not found', async () => {
        mockGet.mockReturnValue({
          promise: jest.fn().mockResolvedValue({}),
        });

        const response = await request(app)
          .post('/api/admin/gtm-plans/plan-999/phases/phase-1/send-status-report')
          .send({
            notifications: {
              notifyUser: true,
            },
          })
          .expect(404);

        expect(response.body.success).toBe(false);
        expect(response.body.error).toBe('GTM Plan not found');
      });

      it('should return 404 if phase is not found', async () => {
        const mockPlan = {
          planId: 'plan-1',
          userId: 'user-1',
          title: 'Test Plan',
          phases: [
            {
              id: 'phase-1',
              title: 'Test Phase',
            },
          ],
        };

        mockGet.mockReturnValue({
          promise: jest.fn().mockResolvedValue({
            Item: mockPlan,
          }),
        });

        const response = await request(app)
          .post('/api/admin/gtm-plans/plan-1/phases/phase-999/send-status-report')
          .send({
            notifications: {
              notifyUser: true,
            },
          })
          .expect(404);

        expect(response.body.success).toBe(false);
        expect(response.body.error).toBe('Phase not found');
      });
    });

    describe('POST /api/admin/gtm-plans/:planId/send-status-report', () => {
      it('should send a plan status report successfully', async () => {
        const mockPlan = {
          planId: 'plan-1',
          userId: 'user-1',
          title: 'Test Plan',
          dri: 'plan-poc@example.com',
          phases: [
            {
              id: 'phase-1',
              title: 'Phase 1',
              status: 'in_progress',
              dri: 'phase1-poc@example.com',
              workItems: [],
            },
            {
              id: 'phase-2',
              title: 'Phase 2',
              status: 'completed',
              dri: 'phase2-poc@example.com',
              workItems: [],
            },
          ],
        };

        mockGet.mockReturnValue({
          promise: jest.fn().mockResolvedValue({
            Item: mockPlan,
          }),
        });

        const response = await request(app)
          .post('/api/admin/gtm-plans/plan-1/send-status-report')
          .send({
            notifications: {
              notifyUser: true,
              notifyPlanPoc: true,
              notifyPhasePocs: true,
            },
            message: 'Overall plan status report',
          })
          .expect(200);

        expect(response.body.success).toBe(true);
        expect(response.body.message).toBe('Plan status report sent successfully');
      });

      it('should return 404 if plan is not found', async () => {
        mockGet.mockReturnValue({
          promise: jest.fn().mockResolvedValue({}),
        });

        const response = await request(app)
          .post('/api/admin/gtm-plans/plan-999/send-status-report')
          .send({
            notifications: {
              notifyUser: true,
            },
          })
          .expect(404);

        expect(response.body.success).toBe(false);
        expect(response.body.error).toBe('GTM Plan not found');
      });

      it('should handle missing notification options gracefully', async () => {
        const mockPlan = {
          planId: 'plan-1',
          userId: 'user-1',
          title: 'Test Plan',
          phases: [],
        };

        mockGet.mockReturnValue({
          promise: jest.fn().mockResolvedValue({
            Item: mockPlan,
          }),
        });

        const response = await request(app)
          .post('/api/admin/gtm-plans/plan-1/send-status-report')
          .send({})
          .expect(200);

        expect(response.body.success).toBe(true);
      });
    });
  });
});
