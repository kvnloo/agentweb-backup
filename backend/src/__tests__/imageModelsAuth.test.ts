import express from 'express';
import request from 'supertest';

// Mock settingsService before importing the route
jest.mock('../services/settingsService', () => ({
  settingsService: {
    getSetting: jest.fn().mockResolvedValue(null),
  },
}));

// Mock auth middleware
const mockAuthenticateToken = jest.fn((req: any, _res: any, next: any) => {
  if (req.headers.authorization === 'Bearer valid-admin-token') {
    req.user = { userId: 'admin-1', email: 'admin@test.com', isAdmin: true };
    next();
  } else if (req.headers.authorization === 'Bearer valid-user-token') {
    req.user = { userId: 'user-1', email: 'user@test.com', isAdmin: false };
    next();
  } else {
    _res.status(401).json({ error: 'Unauthorized' });
  }
});

jest.mock('../middleware/auth', () => ({
  authenticateToken: mockAuthenticateToken,
  requireAdmin: jest.fn((req: any, res: any, next: any) => {
    if (req.user?.isAdmin) {
      next();
    } else {
      res.status(403).json({ error: 'Admin access required' });
    }
  }),
}));

import imageModelsRouter from '../routes/image-models';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/image-models', imageModelsRouter);
  return app;
}

describe('Image Models route authentication', () => {
  it('should reject requests without auth token (401)', async () => {
    const app = createApp();
    const res = await request(app).get('/api/image-models');
    expect(res.status).toBe(401);
  });

  it('should reject requests from non-admin users (403)', async () => {
    const app = createApp();
    const res = await request(app)
      .get('/api/image-models')
      .set('Authorization', 'Bearer valid-user-token');
    expect(res.status).toBe(403);
  });

  it('should allow admin users to access image models (200)', async () => {
    const app = createApp();
    const res = await request(app)
      .get('/api/image-models')
      .set('Authorization', 'Bearer valid-admin-token');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('defaultImageModel');
    expect(res.body).toHaveProperty('supportedImageModels');
  });
});
