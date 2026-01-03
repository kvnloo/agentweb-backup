/**
 * Tests for Admin SEO/AEO configuration endpoint
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
    updateUser: jest.fn()
  }
}));

import express from 'express';
import request from 'supertest';
import adminRoutes from '../routes/admin';
import { userDb } from '../services/db';

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
    
    app.use('/api/admin', adminRoutes);
  });

  describe('PUT /api/admin/users/:userId/seo-aeo', () => {
    it('should return 404 if user not found', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue(null);

      const response = await request(app)
        .put('/api/admin/users/test-user-123/seo-aeo')
        .send({
          seoDomains: ['example.com'],
          googleAnalyticsPropertyId: '123456789'
        })
        .expect(404);

      expect(response.body.message).toBe('User not found');
    });

    it('should update SEO domains', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue({
        userId: 'test-user-123',
        email: 'test@example.com'
      });
      (userDb.updateUser as jest.Mock).mockResolvedValue({
        userId: 'test-user-123',
        email: 'test@example.com',
        seoDomains: ['example.com', 'another.com']
      });

      const response = await request(app)
        .put('/api/admin/users/test-user-123/seo-aeo')
        .send({
          seoDomains: ['example.com', 'another.com']
        })
        .expect(200);

      expect(userDb.updateUser).toHaveBeenCalledWith('test-user-123', {
        seoDomains: ['example.com', 'another.com']
      });
      expect(response.body.seoDomains).toEqual(['example.com', 'another.com']);
    });

    it('should update Google Analytics Property ID', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue({
        userId: 'test-user-123',
        email: 'test@example.com'
      });
      (userDb.updateUser as jest.Mock).mockResolvedValue({
        userId: 'test-user-123',
        email: 'test@example.com',
        googleAnalyticsPropertyId: '123456789'
      });

      const response = await request(app)
        .put('/api/admin/users/test-user-123/seo-aeo')
        .send({
          googleAnalyticsPropertyId: '123456789'
        })
        .expect(200);

      expect(userDb.updateUser).toHaveBeenCalledWith('test-user-123', {
        googleAnalyticsPropertyId: '123456789'
      });
      expect(response.body.googleAnalyticsPropertyId).toBe('123456789');
    });

    it('should update both SEO domains and GA Property ID', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue({
        userId: 'test-user-123',
        email: 'test@example.com'
      });
      (userDb.updateUser as jest.Mock).mockResolvedValue({
        userId: 'test-user-123',
        email: 'test@example.com',
        seoDomains: ['example.com'],
        googleAnalyticsPropertyId: '123456789',
        clarityProjectId: 'ul13e4f7fe'
      });

      const response = await request(app)
        .put('/api/admin/users/test-user-123/seo-aeo')
        .send({
          seoDomains: ['example.com'],
          googleAnalyticsPropertyId: '123456789',
          clarityProjectId: 'ul13e4f7fe'
        })
        .expect(200);

      expect(userDb.updateUser).toHaveBeenCalledWith('test-user-123', {
        seoDomains: ['example.com'],
        googleAnalyticsPropertyId: '123456789',
        clarityProjectId: 'ul13e4f7fe'
      });
      expect(response.body.seoDomains).toEqual(['example.com']);
      expect(response.body.googleAnalyticsPropertyId).toBe('123456789');
      expect(response.body.clarityProjectId).toBe('ul13e4f7fe');
    });

    it('should validate SEO domains format', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue({
        userId: 'test-user-123',
        email: 'test@example.com'
      });

      const response = await request(app)
        .put('/api/admin/users/test-user-123/seo-aeo')
        .send({
          seoDomains: ['invalid-domain']
        })
        .expect(400);

      expect(response.body.message).toContain('Invalid domain format');
    });

    it('should validate SEO domains is an array', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue({
        userId: 'test-user-123',
        email: 'test@example.com'
      });

      const response = await request(app)
        .put('/api/admin/users/test-user-123/seo-aeo')
        .send({
          seoDomains: 'not-an-array'
        })
        .expect(400);

      expect(response.body.message).toBe('seoDomains must be an array');
    });

    it('should validate Google Analytics Property ID is numeric', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue({
        userId: 'test-user-123',
        email: 'test@example.com'
      });

      const response = await request(app)
        .put('/api/admin/users/test-user-123/seo-aeo')
        .send({
          googleAnalyticsPropertyId: 'G-XXXXXXXXXX'
        })
        .expect(400);

      expect(response.body.message).toContain('Invalid Google Analytics Property ID format');
    });

    it('should update Microsoft Clarity Project ID', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue({
        userId: 'test-user-123',
        email: 'test@example.com'
      });
      (userDb.updateUser as jest.Mock).mockResolvedValue({
        userId: 'test-user-123',
        email: 'test@example.com',
        clarityProjectId: 'ul13e4f7fe'
      });

      const response = await request(app)
        .put('/api/admin/users/test-user-123/seo-aeo')
        .send({
          clarityProjectId: 'ul13e4f7fe'
        })
        .expect(200);

      expect(userDb.updateUser).toHaveBeenCalledWith('test-user-123', {
        clarityProjectId: 'ul13e4f7fe'
      });
      expect(response.body.clarityProjectId).toBe('ul13e4f7fe');
    });

    it('should validate Microsoft Clarity Project ID format', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue({
        userId: 'test-user-123',
        email: 'test@example.com'
      });

      const response = await request(app)
        .put('/api/admin/users/test-user-123/seo-aeo')
        .send({
          clarityProjectId: 'bad id!'
        })
        .expect(400);

      expect(response.body.message).toContain('Invalid Microsoft Clarity Project ID format');
    });

    it('should accept empty string for GA Property ID to clear it', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue({
        userId: 'test-user-123',
        email: 'test@example.com',
        googleAnalyticsPropertyId: '123456789'
      });
      (userDb.updateUser as jest.Mock).mockResolvedValue({
        userId: 'test-user-123',
        email: 'test@example.com',
        googleAnalyticsPropertyId: null
      });

      const response = await request(app)
        .put('/api/admin/users/test-user-123/seo-aeo')
        .send({
          googleAnalyticsPropertyId: ''
        })
        .expect(200);

      expect(userDb.updateUser).toHaveBeenCalledWith('test-user-123', {
        googleAnalyticsPropertyId: null
      });
    });

    it('should trim whitespace from GA Property ID', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue({
        userId: 'test-user-123',
        email: 'test@example.com'
      });
      (userDb.updateUser as jest.Mock).mockResolvedValue({
        userId: 'test-user-123',
        email: 'test@example.com',
        googleAnalyticsPropertyId: '123456789'
      });

      const response = await request(app)
        .put('/api/admin/users/test-user-123/seo-aeo')
        .send({
          googleAnalyticsPropertyId: '  123456789  '
        })
        .expect(200);

      expect(userDb.updateUser).toHaveBeenCalledWith('test-user-123', {
        googleAnalyticsPropertyId: '123456789'
      });
    });

    it('should handle errors gracefully', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue({
        userId: 'test-user-123',
        email: 'test@example.com'
      });
      (userDb.updateUser as jest.Mock).mockRejectedValue(new Error('Database error'));

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
