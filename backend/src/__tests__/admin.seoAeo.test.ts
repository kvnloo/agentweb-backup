/**
 * Tests for Admin SEO/AEO configuration endpoint
 * Updated to the new contract: PUT /api/admin/users/:userId/seo-aeo accepts
 * array fields (googleAnalyticsProperties, clarityProjects) and returns
 * { config, scope }. The route delegates to resolveConfigTarget /
 * writeAnalyticsConfig / readAnalyticsConfig.
 */

// Mock the auth middleware
jest.mock('../middleware/auth', () => ({
  authenticateToken: jest.fn()
}));
jest.mock('../middleware/admin', () => ({
  isAdmin: jest.fn()
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

describe('Admin SEO/AEO Configuration', () => {
  let app: express.Application;

  beforeEach(() => {
    jest.clearAllMocks();

    app = express();
    app.use(express.json());

    // Mock authenticateToken to pass through
    mockedAuthenticateToken.mockImplementation(async (req: any, res: any, next: any) => {
      (req as any).user = {
        userId: 'admin-user-123',
        email: 'admin@example.com'
      };
      next();
      return undefined;
    });

    // Mock isAdmin to pass through
    mockedIsAdmin.mockImplementation(async (req: any, res: any, next: any) => {
      next();
      return undefined;
    });

    // Default: user found, resolves to self, stored config is empty
    (userDb.getUserById as jest.Mock).mockResolvedValue({
      userId: 'test-user-123',
      email: 'test@example.com',
    });
    mockResolveTarget.mockResolvedValue({ kind: 'user', id: 'test-user-123', canEdit: true });
    mockRead.mockResolvedValue({ seoDomains: [], googleAnalyticsProperties: [], clarityProjects: [] });
    mockWrite.mockResolvedValue(undefined);

    app.use('/api/admin', adminRoutes);
  });

  describe('PUT /api/admin/users/:userId/seo-aeo', () => {
    it('should return 404 if user not found', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue(null);

      const response = await request(app)
        .put('/api/admin/users/test-user-123/seo-aeo')
        .send({
          seoDomains: ['example.com'],
        })
        .expect(404);

      expect(response.body.message).toBe('User not found');
    });

    it('should update SEO domains', async () => {
      mockRead.mockResolvedValue({ seoDomains: ['example.com', 'another.com'], googleAnalyticsProperties: [], clarityProjects: [] });

      const response = await request(app)
        .put('/api/admin/users/test-user-123/seo-aeo')
        .send({
          seoDomains: ['example.com', 'another.com']
        })
        .expect(200);

      expect(mockWrite).toHaveBeenCalled();
      expect(response.body.config.seoDomains).toEqual(['example.com', 'another.com']);
      expect(response.body.scope).toBe('self');
    });

    it('should update Google Analytics Properties (array format)', async () => {
      mockRead.mockResolvedValue({
        seoDomains: [],
        googleAnalyticsProperties: [{ propertyId: '123456789', label: 'Main' }],
        clarityProjects: [],
      });

      const response = await request(app)
        .put('/api/admin/users/test-user-123/seo-aeo')
        .send({
          googleAnalyticsProperties: [{ propertyId: '123456789', label: 'Main' }],
        })
        .expect(200);

      expect(mockWrite).toHaveBeenCalled();
      const writtenFields = mockWrite.mock.calls[0][1];
      expect(writtenFields.googleAnalyticsProperties[0].propertyId).toBe('123456789');
      expect(response.body.config.googleAnalyticsProperties[0].propertyId).toBe('123456789');
    });

    it('should update both SEO domains and GA Properties', async () => {
      mockRead.mockResolvedValue({
        seoDomains: ['example.com'],
        googleAnalyticsProperties: [{ propertyId: '123456789', label: 'Main' }],
        clarityProjects: [{ projectId: 'ul13e4f7fe', label: 'Main' }],
      });

      const response = await request(app)
        .put('/api/admin/users/test-user-123/seo-aeo')
        .send({
          seoDomains: ['example.com'],
          googleAnalyticsProperties: [{ propertyId: '123456789', label: 'Main' }],
          clarityProjects: [{ projectId: 'ul13e4f7fe', label: 'Main' }],
        })
        .expect(200);

      expect(mockWrite).toHaveBeenCalled();
      expect(response.body.config.seoDomains).toEqual(['example.com']);
      expect(response.body.config.googleAnalyticsProperties[0].propertyId).toBe('123456789');
      expect(response.body.config.clarityProjects[0].projectId).toBe('ul13e4f7fe');
    });

    it('should validate SEO domains format', async () => {
      const response = await request(app)
        .put('/api/admin/users/test-user-123/seo-aeo')
        .send({
          seoDomains: ['invalid-domain']
        })
        .expect(400);

      expect(response.body.message).toContain('Invalid domain format');
    });

    it('should validate SEO domains is an array', async () => {
      const response = await request(app)
        .put('/api/admin/users/test-user-123/seo-aeo')
        .send({
          seoDomains: 'not-an-array'
        })
        .expect(400);

      expect(response.body.message).toBe('seoDomains must be an array');
    });

    it('should validate Google Analytics Property ID is numeric (via array format)', async () => {
      const response = await request(app)
        .put('/api/admin/users/test-user-123/seo-aeo')
        .send({
          googleAnalyticsProperties: [{ propertyId: 'G-XXXXXXXXXX', label: 'Bad' }],
        })
        .expect(400);

      expect(response.body.message).toContain('Invalid GA4 Property ID');
    });

    it('should update Microsoft Clarity Projects (array format)', async () => {
      mockRead.mockResolvedValue({
        seoDomains: [],
        googleAnalyticsProperties: [],
        clarityProjects: [{ projectId: 'ul13e4f7fe', label: 'Main' }],
      });

      const response = await request(app)
        .put('/api/admin/users/test-user-123/seo-aeo')
        .send({
          clarityProjects: [{ projectId: 'ul13e4f7fe', label: 'Main' }],
        })
        .expect(200);

      expect(mockWrite).toHaveBeenCalled();
      const writtenFields = mockWrite.mock.calls[0][1];
      expect(writtenFields.clarityProjects[0].projectId).toBe('ul13e4f7fe');
      expect(response.body.config.clarityProjects[0].projectId).toBe('ul13e4f7fe');
    });

    it('should validate Microsoft Clarity Project ID format (via array format)', async () => {
      const response = await request(app)
        .put('/api/admin/users/test-user-123/seo-aeo')
        .send({
          clarityProjects: [{ projectId: 'bad id!', label: 'Bad' }],
        })
        .expect(400);

      expect(response.body.message).toContain('Invalid Clarity Project ID');
    });

    it('should handle empty googleAnalyticsProperties array (clears config)', async () => {
      mockRead.mockResolvedValue({
        seoDomains: [],
        googleAnalyticsProperties: [],
        clarityProjects: [],
        primaryAnalyticsPropertyId: null,
      });

      const response = await request(app)
        .put('/api/admin/users/test-user-123/seo-aeo')
        .send({
          googleAnalyticsProperties: [],
        })
        .expect(200);

      expect(mockWrite).toHaveBeenCalled();
      const writtenFields = mockWrite.mock.calls[0][1];
      expect(writtenFields.googleAnalyticsProperties).toEqual([]);
    });

    it('should trim whitespace from GA Property IDs in array format', async () => {
      mockRead.mockResolvedValue({
        seoDomains: [],
        googleAnalyticsProperties: [{ propertyId: '123456789', label: 'Main' }],
        clarityProjects: [],
      });

      const response = await request(app)
        .put('/api/admin/users/test-user-123/seo-aeo')
        .send({
          googleAnalyticsProperties: [{ propertyId: '  123456789  ', label: 'Main' }],
        })
        .expect(200);

      expect(mockWrite).toHaveBeenCalled();
      const writtenFields = mockWrite.mock.calls[0][1];
      expect(writtenFields.googleAnalyticsProperties[0].propertyId).toBe('123456789');
    });

    it('should handle errors gracefully', async () => {
      mockWrite.mockRejectedValue(new Error('Database error'));

      const response = await request(app)
        .put('/api/admin/users/test-user-123/seo-aeo')
        .send({
          seoDomains: ['example.com']
        })
        .expect(500);

      expect(response.body.message).toBe('Error updating SEO/AEO configuration');
    });
  });
});
