/**
 * Tests for Admin gaFilteredDomains validation via PUT /api/admin/users/:userId/seo-aeo
 * Updated to the new contract: route delegates validation to validateAnalyticsConfig
 * (NOT mocked — exercised end-to-end) and returns { config, scope }.
 * Only analyticsConfigResolver and analyticsConfigStore are mocked.
 */

// Mock the auth middleware
jest.mock('../middleware/auth', () => ({
  authenticateToken: jest.fn(),
}));
jest.mock('../middleware/admin', () => ({
  isAdmin: jest.fn(),
}));

import { authenticateToken } from '../middleware/auth';
import { isAdmin } from '../middleware/admin';
const mockedAuthenticateToken = authenticateToken as jest.MockedFunction<typeof authenticateToken>;
const mockedIsAdmin = isAdmin as jest.MockedFunction<typeof isAdmin>;

// Mock the database service
jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn(),
    updateUser: jest.fn(),
    getAllUsers: jest.fn(),
  },
  taskDb: {},
  subscriberDb: {},
  crmDb: {},
  orgDb: {
    getOrgById: jest.fn(),
    updateOrg: jest.fn(),
    updateShareSettings: jest.fn(),
  },
}));

jest.mock('../services/settingsService', () => ({
  settingsService: {
    getSetting: jest.fn().mockResolvedValue(null),
    setSetting: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../services/analyticsConfigResolver', () => ({
  resolveConfigTarget: jest.fn(),
}));

jest.mock('../services/analyticsConfigStore', () => ({
  readAnalyticsConfig: jest.fn(),
  writeAnalyticsConfig: jest.fn(),
}));

import express from 'express';
import request from 'supertest';
import adminRoutes from '../routes/admin';
import { userDb } from '../services/db';
import { resolveConfigTarget } from '../services/analyticsConfigResolver';
import { readAnalyticsConfig, writeAnalyticsConfig } from '../services/analyticsConfigStore';

const mockResolveTarget = resolveConfigTarget as jest.Mock;
const mockRead = readAnalyticsConfig as jest.Mock;
const mockWrite = writeAnalyticsConfig as jest.Mock;

describe('Admin gaFilteredDomains validation', () => {
  let app: express.Application;

  beforeEach(() => {
    jest.clearAllMocks();

    app = express();
    app.use(express.json());

    // Mock authenticateToken to pass through
    mockedAuthenticateToken.mockImplementation(async (req: any, _res: any, next: any) => {
      (req as any).user = { userId: 'admin-user-123', email: 'admin@example.com' };
      next();
      return undefined;
    });

    // Mock isAdmin to pass through
    mockedIsAdmin.mockImplementation(async (_req: any, _res: any, next: any) => {
      next();
      return undefined;
    });

    // Default: user found, resolves to self, stored config is empty
    (userDb.getUserById as jest.Mock).mockResolvedValue({
      userId: 'test-user-123',
      email: 'test@example.com',
    });
    mockResolveTarget.mockResolvedValue({ kind: 'user', id: 'test-user-123', canEdit: true });
    mockRead.mockResolvedValue({ seoDomains: [], googleAnalyticsProperties: [], gaFilteredDomains: [], clarityProjects: [] });
    mockWrite.mockResolvedValue(undefined);

    app.use('/api/admin', adminRoutes);
  });

  it('should accept valid standard domains in gaFilteredDomains', async () => {
    mockRead.mockResolvedValue({
      seoDomains: [],
      googleAnalyticsProperties: [],
      gaFilteredDomains: ['app.example.com', 'admin.example.com'],
      clarityProjects: [],
    });

    const res = await request(app)
      .put('/api/admin/users/test-user-123/seo-aeo')
      .set('Authorization', 'Bearer test-token')
      .send({
        gaFilteredDomains: ['app.example.com', 'admin.example.com'],
      })
      .expect(200);

    expect(res.body.config.gaFilteredDomains).toEqual(['app.example.com', 'admin.example.com']);
    expect(res.body.scope).toBe('self');
    expect(mockWrite).toHaveBeenCalled();
    const writtenFields = mockWrite.mock.calls[0][1];
    expect(writtenFields.gaFilteredDomains).toEqual(['app.example.com', 'admin.example.com']);
  });

  it('should accept localhost in gaFilteredDomains', async () => {
    mockRead.mockResolvedValue({
      seoDomains: [],
      googleAnalyticsProperties: [],
      gaFilteredDomains: ['localhost', 'localhost:3000'],
      clarityProjects: [],
    });

    const res = await request(app)
      .put('/api/admin/users/test-user-123/seo-aeo')
      .set('Authorization', 'Bearer test-token')
      .send({
        gaFilteredDomains: ['localhost', 'localhost:3000'],
      })
      .expect(200);

    expect(res.body.config.gaFilteredDomains).toEqual(['localhost', 'localhost:3000']);
    expect(res.body.scope).toBe('self');
  });

  it('should accept IP addresses in gaFilteredDomains', async () => {
    mockRead.mockResolvedValue({
      seoDomains: [],
      googleAnalyticsProperties: [],
      gaFilteredDomains: ['127.0.0.1', '192.168.1.1:8080'],
      clarityProjects: [],
    });

    const res = await request(app)
      .put('/api/admin/users/test-user-123/seo-aeo')
      .set('Authorization', 'Bearer test-token')
      .send({
        gaFilteredDomains: ['127.0.0.1', '192.168.1.1:8080'],
      })
      .expect(200);

    expect(res.body.config.gaFilteredDomains).toEqual(['127.0.0.1', '192.168.1.1:8080']);
    expect(res.body.scope).toBe('self');
  });

  it('should accept mixed valid domains (standard, localhost, IP)', async () => {
    mockRead.mockResolvedValue({
      seoDomains: [],
      googleAnalyticsProperties: [],
      gaFilteredDomains: ['app.example.com', 'localhost', '127.0.0.1'],
      clarityProjects: [],
    });

    const res = await request(app)
      .put('/api/admin/users/test-user-123/seo-aeo')
      .set('Authorization', 'Bearer test-token')
      .send({
        gaFilteredDomains: ['app.example.com', 'localhost', '127.0.0.1'],
      })
      .expect(200);

    expect(res.body.config.gaFilteredDomains).toEqual(['app.example.com', 'localhost', '127.0.0.1']);
    expect(res.body.scope).toBe('self');
  });

  it('should reject invalid domain format in gaFilteredDomains', async () => {
    const res = await request(app)
      .put('/api/admin/users/test-user-123/seo-aeo')
      .set('Authorization', 'Bearer test-token')
      .send({
        gaFilteredDomains: ['invalid_domain', 'app.example.com'],
      })
      .expect(400);

    expect(res.body.message).toContain('Invalid filtered domain');
    expect(res.body.message).toContain('invalid_domain');
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it('should reject non-array gaFilteredDomains', async () => {
    const res = await request(app)
      .put('/api/admin/users/test-user-123/seo-aeo')
      .set('Authorization', 'Bearer test-token')
      .send({
        gaFilteredDomains: 'not-an-array',
      })
      .expect(400);

    expect(res.body.message).toBe('gaFilteredDomains must be an array');
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it('should accept empty gaFilteredDomains array', async () => {
    mockRead.mockResolvedValue({
      seoDomains: [],
      googleAnalyticsProperties: [],
      gaFilteredDomains: [],
      clarityProjects: [],
    });

    const res = await request(app)
      .put('/api/admin/users/test-user-123/seo-aeo')
      .set('Authorization', 'Bearer test-token')
      .send({
        gaFilteredDomains: [],
      })
      .expect(200);

    expect(res.body.config.gaFilteredDomains).toEqual([]);
    expect(res.body.scope).toBe('self');
    expect(mockWrite).toHaveBeenCalled();
  });

  it('should update gaFilteredDomains along with other SEO fields', async () => {
    mockRead.mockResolvedValue({
      seoDomains: ['example.com'],
      googleAnalyticsProperties: [{ propertyId: '123456789', label: 'Main' }],
      gaFilteredDomains: ['app.example.com', 'localhost'],
      clarityProjects: [],
      productDomain: 'app.example.com',
    });

    const res = await request(app)
      .put('/api/admin/users/test-user-123/seo-aeo')
      .set('Authorization', 'Bearer test-token')
      .send({
        seoDomains: ['example.com'],
        googleAnalyticsProperties: [{ propertyId: '123456789', label: 'Main' }],
        gaFilteredDomains: ['app.example.com', 'localhost'],
        productDomain: 'app.example.com',
      })
      .expect(200);

    expect(res.body.config.gaFilteredDomains).toEqual(['app.example.com', 'localhost']);
    expect(res.body.scope).toBe('self');
    expect(mockWrite).toHaveBeenCalled();
    const writtenFields = mockWrite.mock.calls[0][1];
    expect(writtenFields.gaFilteredDomains).toEqual(['app.example.com', 'localhost']);
    expect(writtenFields.seoDomains).toEqual(['example.com']);
    expect(writtenFields.productDomain).toBe('app.example.com');
  });
});
