import request from 'supertest';
import express from 'express';
import adminRoutes from '../routes/admin';

// Mock auth middleware
jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: 'test-user-123', isAdmin: true };
    next();
  },
}));

// Mock admin middleware
jest.mock('../middleware/admin', () => ({
  isAdmin: (_req: any, _res: any, next: any) => next(),
}));

// Mock userDb
jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn(),
    updateUser: jest.fn(),
  },
}));

import { userDb } from '../services/db';

const mockedUserDb = userDb as jest.Mocked<typeof userDb>;

let app: express.Application;

describe('Admin gaFilteredDomains validation', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    app = express();
    app.use(express.json());
    app.use('/api/admin', adminRoutes);

    // Mock user exists
    mockedUserDb.getUserById.mockResolvedValue({
      userId: 'test-user-123',
      email: 'test@example.com',
      isAdmin: false,
      isActive: true,
      createdAt: new Date().toISOString(),
    } as any);
  });

  it('should accept valid standard domains in gaFilteredDomains', async () => {
    mockedUserDb.updateUser.mockResolvedValue({
      userId: 'test-user-123',
      email: 'test@example.com',
      gaFilteredDomains: ['app.example.com', 'admin.example.com'],
    } as any);

    const res = await request(app)
      .put('/api/admin/users/test-user-123/seo-aeo')
      .set('Authorization', 'Bearer test-token')
      .send({
        gaFilteredDomains: ['app.example.com', 'admin.example.com'],
      })
      .expect(200);

    expect(res.body.gaFilteredDomains).toEqual(['app.example.com', 'admin.example.com']);
    expect(mockedUserDb.updateUser).toHaveBeenCalledWith('test-user-123', {
      gaFilteredDomains: ['app.example.com', 'admin.example.com'],
    });
  });

  it('should accept localhost in gaFilteredDomains', async () => {
    mockedUserDb.updateUser.mockResolvedValue({
      userId: 'test-user-123',
      email: 'test@example.com',
      gaFilteredDomains: ['localhost', 'localhost:3000'],
    } as any);

    const res = await request(app)
      .put('/api/admin/users/test-user-123/seo-aeo')
      .set('Authorization', 'Bearer test-token')
      .send({
        gaFilteredDomains: ['localhost', 'localhost:3000'],
      })
      .expect(200);

    expect(res.body.gaFilteredDomains).toEqual(['localhost', 'localhost:3000']);
  });

  it('should accept IP addresses in gaFilteredDomains', async () => {
    mockedUserDb.updateUser.mockResolvedValue({
      userId: 'test-user-123',
      email: 'test@example.com',
      gaFilteredDomains: ['127.0.0.1', '192.168.1.1:8080'],
    } as any);

    const res = await request(app)
      .put('/api/admin/users/test-user-123/seo-aeo')
      .set('Authorization', 'Bearer test-token')
      .send({
        gaFilteredDomains: ['127.0.0.1', '192.168.1.1:8080'],
      })
      .expect(200);

    expect(res.body.gaFilteredDomains).toEqual(['127.0.0.1', '192.168.1.1:8080']);
  });

  it('should accept mixed valid domains (standard, localhost, IP)', async () => {
    mockedUserDb.updateUser.mockResolvedValue({
      userId: 'test-user-123',
      email: 'test@example.com',
      gaFilteredDomains: ['app.example.com', 'localhost', '127.0.0.1'],
    } as any);

    const res = await request(app)
      .put('/api/admin/users/test-user-123/seo-aeo')
      .set('Authorization', 'Bearer test-token')
      .send({
        gaFilteredDomains: ['app.example.com', 'localhost', '127.0.0.1'],
      })
      .expect(200);

    expect(res.body.gaFilteredDomains).toEqual(['app.example.com', 'localhost', '127.0.0.1']);
  });

  it('should reject invalid domain format in gaFilteredDomains', async () => {
    const res = await request(app)
      .put('/api/admin/users/test-user-123/seo-aeo')
      .set('Authorization', 'Bearer test-token')
      .send({
        gaFilteredDomains: ['invalid_domain', 'app.example.com'],
      })
      .expect(400);

    expect(res.body.message).toContain('Invalid filtered domain format');
    expect(res.body.message).toContain('invalid_domain');
    expect(mockedUserDb.updateUser).not.toHaveBeenCalled();
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
    expect(mockedUserDb.updateUser).not.toHaveBeenCalled();
  });

  it('should accept empty gaFilteredDomains array', async () => {
    mockedUserDb.updateUser.mockResolvedValue({
      userId: 'test-user-123',
      email: 'test@example.com',
      gaFilteredDomains: [],
    } as any);

    const res = await request(app)
      .put('/api/admin/users/test-user-123/seo-aeo')
      .set('Authorization', 'Bearer test-token')
      .send({
        gaFilteredDomains: [],
      })
      .expect(200);

    expect(res.body.gaFilteredDomains).toEqual([]);
  });

  it('should update gaFilteredDomains along with other SEO fields', async () => {
    mockedUserDb.updateUser.mockResolvedValue({
      userId: 'test-user-123',
      email: 'test@example.com',
      seoDomains: ['example.com'],
      googleAnalyticsPropertyId: '123456789',
      gaFilteredDomains: ['app.example.com', 'localhost'],
      productDomain: 'app.example.com',
    } as any);

    const res = await request(app)
      .put('/api/admin/users/test-user-123/seo-aeo')
      .set('Authorization', 'Bearer test-token')
      .send({
        seoDomains: ['example.com'],
        googleAnalyticsPropertyId: '123456789',
        gaFilteredDomains: ['app.example.com', 'localhost'],
        productDomain: 'app.example.com',
      })
      .expect(200);

    expect(res.body.gaFilteredDomains).toEqual(['app.example.com', 'localhost']);
    expect(mockedUserDb.updateUser).toHaveBeenCalledWith('test-user-123', {
      seoDomains: ['example.com'],
      googleAnalyticsPropertyId: '123456789',
      gaFilteredDomains: ['app.example.com', 'localhost'],
      productDomain: 'app.example.com',
    });
  });
});
