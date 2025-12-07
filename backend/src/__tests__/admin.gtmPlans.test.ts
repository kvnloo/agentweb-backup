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
    config: {
      update: jest.fn(),
    },
    DynamoDB: {
      DocumentClient: jest.fn(() => ({
        scan: mockScan,
      })),
    },
  };
});

// Mock other dependencies that might be imported
jest.mock('../services/waitlistDb', () => ({}));
jest.mock('../services/emailService', () => ({}));
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
