import request from 'supertest';
import express from 'express';
import adminRoutes from '../routes/admin';

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

jest.mock('../services/db', () => ({}));
jest.mock('../services/waitlistDb', () => ({}));
jest.mock('../services/emailService', () => ({}));
jest.mock('../services/workflowDb', () => ({}));
jest.mock('../services/chatbotService', () => ({}));
jest.mock('../services/resendService', () => ({
  resendService: {
    sendEmail: jest.fn(),
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

const { DynamoDB } = require('aws-sdk');

const app = express();
app.use(express.json());
app.use('/api/admin', adminRoutes);

describe('Admin CRM Analytics Endpoint', () => {
  let mockScan: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NODE_ENV = 'development';

    mockScan = jest.fn();
    (DynamoDB.DocumentClient as jest.Mock).mockImplementation(() => ({
      scan: mockScan,
    }));
  });

  it('should return CRM analytics with all metrics', async () => {
    const mockLeadLists = [
      { listId: 'list-1', name: 'List 1', createdAt: '2026-02-10T10:00:00Z' },
      { listId: 'list-2', name: 'List 2', createdAt: '2026-01-05T10:00:00Z' },
    ];

    const mockLeads = [
      { leadId: 'lead-1', email: 'a@example.com', isICP: 1, isEngaged: 1, createdAt: '2026-02-10T10:00:00Z' },
      { leadId: 'lead-2', email: 'b@example.com', isICP: 1, isEngaged: 0, createdAt: '2026-02-12T10:00:00Z' },
      { leadId: 'lead-3', email: 'c@example.com', isICP: 0, isEngaged: 1, createdAt: '2026-01-01T10:00:00Z' },
      { leadId: 'lead-4', email: 'd@example.com', isICP: 0, isEngaged: 0, createdAt: '2026-01-15T10:00:00Z' },
    ];

    // Mock scan to return different results based on TableName
    mockScan.mockImplementation((params: any) => ({
      promise: jest.fn().mockResolvedValue({
        Items: params.TableName.includes('LeadLists') ? mockLeadLists : mockLeads,
      }),
    }));

    const response = await request(app)
      .get('/api/admin/analytics/crm')
      .expect(200);

    expect(response.body.totalLists).toBe(2);
    expect(response.body.totalLeads).toBe(4);
    expect(response.body.totalICPLeads).toBe(2);
    expect(response.body.totalEngagedLeads).toBe(2);
    // Without date range, newLists = totalLists, newLeads = totalLeads
    expect(response.body.newLists).toBe(2);
    expect(response.body.newLeads).toBe(4);
  });

  it('should filter new leads and lists by date range', async () => {
    const mockLeadLists = [
      { listId: 'list-1', name: 'List 1', createdAt: '2026-02-10T10:00:00Z' },
      { listId: 'list-2', name: 'List 2', createdAt: '2026-01-05T10:00:00Z' },
      { listId: 'list-3', name: 'List 3', createdAt: '2026-02-14T10:00:00Z' },
    ];

    const mockLeads = [
      { leadId: 'lead-1', email: 'a@example.com', isICP: 1, isEngaged: 0, createdAt: '2026-02-10T10:00:00Z' },
      { leadId: 'lead-2', email: 'b@example.com', isICP: 0, isEngaged: 0, createdAt: '2026-01-01T10:00:00Z' },
      { leadId: 'lead-3', email: 'c@example.com', isICP: 0, isEngaged: 1, createdAt: '2026-02-12T10:00:00Z' },
    ];

    mockScan.mockImplementation((params: any) => ({
      promise: jest.fn().mockResolvedValue({
        Items: params.TableName.includes('LeadLists') ? mockLeadLists : mockLeads,
      }),
    }));

    const response = await request(app)
      .get('/api/admin/analytics/crm?startDate=2026-02-01&endDate=2026-02-13')
      .expect(200);

    expect(response.body.totalLists).toBe(3);
    expect(response.body.totalLeads).toBe(3);
    // Only items in range
    expect(response.body.newLists).toBe(1); // list-1 (Feb 10)
    expect(response.body.newLeads).toBe(2); // lead-1 (Feb 10), lead-3 (Feb 12)
    // Totals are unaffected by date range
    expect(response.body.totalICPLeads).toBe(1);
    expect(response.body.totalEngagedLeads).toBe(1);
  });

  it('should handle empty tables', async () => {
    mockScan.mockImplementation(() => ({
      promise: jest.fn().mockResolvedValue({ Items: [] }),
    }));

    const response = await request(app)
      .get('/api/admin/analytics/crm')
      .expect(200);

    expect(response.body.totalLists).toBe(0);
    expect(response.body.newLists).toBe(0);
    expect(response.body.totalLeads).toBe(0);
    expect(response.body.newLeads).toBe(0);
    expect(response.body.totalICPLeads).toBe(0);
    expect(response.body.totalEngagedLeads).toBe(0);
  });

  it('should paginate through all DynamoDB results', async () => {
    const page1Lists = [
      { listId: 'list-1', name: 'List 1', createdAt: '2026-02-10T10:00:00Z' },
    ];
    const page2Lists = [
      { listId: 'list-2', name: 'List 2', createdAt: '2026-02-11T10:00:00Z' },
    ];

    const page1Leads = [
      { leadId: 'lead-1', email: 'a@example.com', isICP: 1, isEngaged: 0, createdAt: '2026-02-10T10:00:00Z' },
      { leadId: 'lead-2', email: 'b@example.com', isICP: 0, isEngaged: 1, createdAt: '2026-02-11T10:00:00Z' },
    ];
    const page2Leads = [
      { leadId: 'lead-3', email: 'c@example.com', isICP: 1, isEngaged: 1, createdAt: '2026-02-12T10:00:00Z' },
    ];

    // Track call count per table to return paginated results
    const callCounts: Record<string, number> = {};

    mockScan.mockImplementation((params: any) => {
      const table = params.TableName as string;
      callCounts[table] = (callCounts[table] || 0) + 1;

      if (table.includes('LeadLists')) {
        if (callCounts[table] === 1) {
          return {
            promise: jest.fn().mockResolvedValue({
              Items: page1Lists,
              LastEvaluatedKey: { listId: 'list-1' },
            }),
          };
        }
        return {
          promise: jest.fn().mockResolvedValue({
            Items: page2Lists,
          }),
        };
      }

      // Leads table
      if (callCounts[table] === 1) {
        return {
          promise: jest.fn().mockResolvedValue({
            Items: page1Leads,
            LastEvaluatedKey: { leadId: 'lead-2' },
          }),
        };
      }
      return {
        promise: jest.fn().mockResolvedValue({
          Items: page2Leads,
        }),
      };
    });

    const response = await request(app)
      .get('/api/admin/analytics/crm')
      .expect(200);

    // Should have all items from both pages
    expect(response.body.totalLists).toBe(2);
    expect(response.body.totalLeads).toBe(3);
    expect(response.body.totalICPLeads).toBe(2);
    expect(response.body.totalEngagedLeads).toBe(2);

    // Verify scan was called twice per table (pagination)
    const leadListsTable = 'Dev-AW-LeadLists';
    const leadsTable = 'Dev-AW-Leads';
    expect(callCounts[leadListsTable]).toBe(2);
    expect(callCounts[leadsTable]).toBe(2);
  });

  it('should handle leads without createdAt in date range filtering', async () => {
    const mockLeadLists = [
      { listId: 'list-1', name: 'List 1' }, // no createdAt
    ];

    const mockLeads = [
      { leadId: 'lead-1', email: 'a@example.com', isICP: 0, isEngaged: 0 }, // no createdAt
      { leadId: 'lead-2', email: 'b@example.com', isICP: 1, isEngaged: 0, createdAt: '2026-02-10T10:00:00Z' },
    ];

    mockScan.mockImplementation((params: any) => ({
      promise: jest.fn().mockResolvedValue({
        Items: params.TableName.includes('LeadLists') ? mockLeadLists : mockLeads,
      }),
    }));

    const response = await request(app)
      .get('/api/admin/analytics/crm?startDate=2026-02-01&endDate=2026-02-28')
      .expect(200);

    expect(response.body.totalLists).toBe(1);
    expect(response.body.totalLeads).toBe(2);
    // Items without createdAt produce empty string, which won't match date range
    expect(response.body.newLists).toBe(0);
    expect(response.body.newLeads).toBe(1); // only lead-2
  });

  it('should handle DynamoDB errors', async () => {
    mockScan.mockImplementation(() => ({
      promise: jest.fn().mockRejectedValue(new Error('DynamoDB error')),
    }));

    const response = await request(app)
      .get('/api/admin/analytics/crm')
      .expect(500);

    expect(response.body.message).toContain('Error fetching CRM analytics');
  });

  it('should use Dev- prefix in development mode', async () => {
    process.env.NODE_ENV = 'development';

    mockScan.mockImplementation((params: any) => ({
      promise: jest.fn().mockResolvedValue({ Items: [] }),
    }));

    await request(app)
      .get('/api/admin/analytics/crm')
      .expect(200);

    // Verify the scan was called with Dev- prefixed table names
    const scanCalls = mockScan.mock.calls;
    const tableNames = scanCalls.map((call: any) => call[0].TableName);
    expect(tableNames).toContain('Dev-AW-LeadLists');
    expect(tableNames).toContain('Dev-AW-Leads');
  });
});
