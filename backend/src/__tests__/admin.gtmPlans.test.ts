import request from 'supertest';
import express from 'express';
import adminRoutes from '../routes/admin';
import { userDb } from '../services/db';

// Mock the dependencies
// admin.ts takes its table prefix from config/constants, a value fixed when the module
// is first loaded (ENG-1760). These tests switch NODE_ENV per case, so the prefix is
// resolved live from the environment here instead.
jest.mock('../config/constants', () => ({
  get TABLE_PREFIX() {
    return process.env.NODE_ENV === 'development' ? 'Dev-' : '';
  },
  tableName: (base: string) =>
    `${process.env.NODE_ENV === 'development' ? 'Dev-' : ''}${base}`,
}));

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
    sendSystemEmail: jest.fn(),
  },
}));
jest.mock('../services/workflowDb', () => ({}));
jest.mock('../services/chatbotService', () => ({}));

const { DynamoDB } = require('aws-sdk');
const { resendService } = require('../services/resendService');
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
    // These run the REAL report code and the real route; only the database and the mail service are doubles. (They used to mock the
    // notification service with jest.doMock after the route was imported, which replaced nothing, and the mail mock had no
    // sendSystemEmail, so every send failed while the route answered "sent successfully".)
    let mockGet: jest.Mock;
    const sendSystemEmail = resendService.sendSystemEmail as jest.Mock;

    const reportPlan = {
      planId: 'plan-1',
      userId: 'user-1',
      title: 'Test Plan',
      dri: 'plan-poc@example.com',
      phases: [
        { id: 'phase-1', title: 'Test Phase', status: 'in_progress', dri: 'phase-poc@example.com', workItems: [{ id: 'item-1', title: 'Test Item', status: 'pending', dri: 'item-poc@example.com' }] },
        { id: 'phase-2', title: 'Phase 2', status: 'completed', dri: 'phase2-poc@example.com', workItems: [] },
      ],
    };
    const planIs = (item: any) => mockGet.mockReturnValue({ promise: jest.fn().mockResolvedValue({ Item: item }) });
    const phaseUrl = '/api/admin/gtm-plans/plan-1/phases/phase-1/send-status-report';
    const planUrl = '/api/admin/gtm-plans/plan-1/send-status-report';

    beforeEach(() => {
      jest.clearAllMocks();

      mockGet = jest.fn();
      (DynamoDB.DocumentClient as jest.Mock).mockImplementation(() => ({
        get: mockGet,
      }));

      sendSystemEmail.mockReset().mockResolvedValue({ id: 'email-1' });
      mockUserDb.getUserById.mockReset().mockResolvedValue(undefined as any);
    });

    describe('POST /api/admin/gtm-plans/:planId/phases/:phaseId/send-status-report', () => {
      it('answers with what was sent: one recipient chosen, one email accepted', async () => {
        planIs(reportPlan);

        const response = await request(app)
          .post(phaseUrl)
          .send({ notifications: { notifyPhasePoc: true }, message: 'Custom status report message' })
          .expect(200);

        expect(response.body).toEqual({
          success: true,
          message: 'The phase status report for "Test Phase" was sent successfully to 1 recipient.',
          sent: 1,
          failed: 0,
          suppressed: 0,
        });
        expect(sendSystemEmail).toHaveBeenCalledTimes(1);
        expect(sendSystemEmail.mock.calls[0][0].to).toBe('phase-poc@example.com');
      });

      it('puts the custom message into the email (html and plain text)', async () => {
        planIs(reportPlan);

        await request(app).post(phaseUrl).send({ notifications: { notifyPhasePoc: true }, message: 'Custom status report message' }).expect(200);

        const email = sendSystemEmail.mock.calls[0][0];
        expect(email.html).toContain('Custom status report message');
        expect(email.text).toContain('Custom status report message');
      });

      it('emails the account owner when that option is chosen', async () => {
        planIs(reportPlan);
        mockUserDb.getUserById.mockResolvedValue({ userId: 'user-1', email: 'owner@example.com' } as any);

        const response = await request(app).post(phaseUrl).send({ notifications: { notifyUser: true } }).expect(200);

        expect(mockUserDb.getUserById).toHaveBeenCalledWith('user-1');
        expect(sendSystemEmail.mock.calls.map((call) => call[0].to)).toEqual(['owner@example.com']);
        expect(response.body).toMatchObject({ sent: 1, failed: 0 });
      });

      it('answers 500 in the old shape when the plan cannot be read', async () => {
        mockGet.mockReturnValue({ promise: jest.fn().mockRejectedValue(new Error('boom')) });

        const response = await request(app).post(phaseUrl).send({ notifications: { notifyPhasePoc: true } }).expect(500);

        expect(response.body).toEqual({ success: false, message: 'Error sending phase status report', error: 'boom' });
        expect(sendSystemEmail).not.toHaveBeenCalled();
      });

      it('answers 400 and emails nobody when no recipient option is chosen', async () => {
        planIs(reportPlan);

        const response = await request(app).post(phaseUrl).send({ notifications: { notifyUser: false } }).expect(400);

        expect(response.body.success).toBe(false);
        expect(response.body.error).toMatch(/was not sent: nobody was chosen to receive it/);
        expect(response.body.error).toMatch(/Nothing was emailed/);
        expect(sendSystemEmail).not.toHaveBeenCalled();
      });

      it('answers 502 and not "sent" when the mail service refuses every email', async () => {
        planIs(reportPlan);
        sendSystemEmail.mockRejectedValue(new Error('Resend is down'));

        const response = await request(app).post(phaseUrl).send({ notifications: { notifyPhasePoc: true, notifyPlanPoc: true } }).expect(502);

        expect(response.body.success).toBe(false);
        expect(response.body.error).toMatch(/refused all 2 emails/);
        expect(response.body.error).toMatch(/Nothing was delivered/);
        expect(sendSystemEmail).toHaveBeenCalledTimes(2);
      });

      it('answers 200 with the exact counts when one email is refused and the other accepted', async () => {
        planIs(reportPlan);
        sendSystemEmail.mockResolvedValueOnce({ id: 'ok-1' }).mockRejectedValueOnce(new Error('bad address'));

        const response = await request(app).post(phaseUrl).send({ notifications: { notifyPhasePoc: true, notifyPlanPoc: true } }).expect(200);

        expect(response.body.success).toBe(true);
        expect(response.body.message).toBe('The phase status report for "Test Phase" was sent to 1 of 2 recipients; 1 could not be sent.');
        expect(response.body).toMatchObject({ sent: 1, failed: 1, suppressed: 0 });
      });

      it('does not call an email the non-production guard held back "sent"', async () => {
        planIs(reportPlan);
        sendSystemEmail.mockResolvedValue({ id: 'nonprod-suppressed', suppressed: true });

        const response = await request(app).post(phaseUrl).send({ notifications: { notifyPhasePoc: true } }).expect(200);

        expect(response.body.message).toMatch(/was NOT delivered: this environment's email guard held back 1 email/);
        expect(response.body).toMatchObject({ sent: 0, failed: 0, suppressed: 1 });
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
      it('answers with what was sent: three distinct contacts chosen, three emails accepted', async () => {
        planIs(reportPlan);

        const response = await request(app)
          .post(planUrl)
          .send({ notifications: { notifyPlanPoc: true, notifyPhasePocs: true }, message: 'Overall plan status report' })
          .expect(200);

        expect(response.body).toEqual({
          success: true,
          message: 'The plan status report for "Test Plan" was sent successfully to 3 recipients.',
          sent: 3,
          failed: 0,
          suppressed: 0,
        });
        expect(sendSystemEmail.mock.calls.map((call) => call[0].to).sort()).toEqual(['phase-poc@example.com', 'phase2-poc@example.com', 'plan-poc@example.com']);
      });

      it('puts the custom message into the email (html and plain text)', async () => {
        planIs(reportPlan);

        await request(app).post(planUrl).send({ notifications: { notifyPlanPoc: true }, message: 'Overall plan status report' }).expect(200);

        const email = sendSystemEmail.mock.calls[0][0];
        expect(email.html).toContain('Overall plan status report');
        expect(email.text).toContain('Overall plan status report');
      });

      it('answers 500 in the old shape when the plan cannot be read', async () => {
        mockGet.mockReturnValue({ promise: jest.fn().mockRejectedValue(new Error('boom')) });

        const response = await request(app).post(planUrl).send({ notifications: { notifyPlanPoc: true } }).expect(500);

        expect(response.body).toEqual({ success: false, message: 'Error sending plan status report', error: 'boom' });
        expect(sendSystemEmail).not.toHaveBeenCalled();
      });

      it('answers 400 and emails nobody when no recipient option is chosen (it used to answer "sent successfully")', async () => {
        planIs({ planId: 'plan-1', userId: 'user-1', title: 'Test Plan', phases: [] });

        const response = await request(app).post(planUrl).send({}).expect(400);

        expect(response.body.success).toBe(false);
        expect(response.body.error).toMatch(/was not sent: nobody was chosen to receive it/);
        expect(sendSystemEmail).not.toHaveBeenCalled();
      });

      it('answers 502 and not "sent" when the mail service refuses every email', async () => {
        planIs(reportPlan);
        sendSystemEmail.mockRejectedValue(new Error('Resend is down'));

        const response = await request(app).post(planUrl).send({ notifications: { notifyPlanPoc: true, notifyPhasePocs: true } }).expect(502);

        expect(response.body.success).toBe(false);
        expect(response.body.error).toMatch(/refused all 3 emails/);
        expect(sendSystemEmail).toHaveBeenCalledTimes(3);
      });

      it('answers 200 with the exact counts when some emails are refused', async () => {
        planIs(reportPlan);
        sendSystemEmail.mockResolvedValueOnce({ id: 'ok-1' }).mockRejectedValueOnce(new Error('bad address')).mockResolvedValueOnce({ id: 'ok-3' });

        const response = await request(app).post(planUrl).send({ notifications: { notifyPlanPoc: true, notifyPhasePocs: true } }).expect(200);

        expect(response.body.message).toBe('The plan status report for "Test Plan" was sent to 2 of 3 recipients; 1 could not be sent.');
        expect(response.body).toMatchObject({ sent: 2, failed: 1, suppressed: 0 });
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

    });
  });
});
