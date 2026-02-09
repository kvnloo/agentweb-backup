/**
 * Tests for Funnel routes
 */

// Mock the auth middleware
jest.mock('../middleware/auth', () => ({
  authenticateToken: jest.fn()
}));
import { authenticateToken } from '../middleware/auth';
const mockedAuthenticateToken = authenticateToken as jest.MockedFunction<typeof authenticateToken>;

// Mock AWS SDK
const mockGet = jest.fn();
const mockPut = jest.fn();
jest.mock('aws-sdk', () => {
  return {
    DynamoDB: {
      DocumentClient: jest.fn().mockImplementation(() => ({
        get: mockGet,
        put: mockPut
      }))
    }
  };
});

import express from 'express';
import request from 'supertest';
import funnelRoutes from '../routes/funnel';

describe('Funnel Routes', () => {
  let app: express.Application;

  beforeEach(() => {
    jest.clearAllMocks();

    app = express();
    app.use(express.json());

    // Mock authenticateToken to pass through
    mockedAuthenticateToken.mockImplementation(async (req: any, res: any, next: any) => {
      (req as any).user = {
        userId: 'test-user-123',
        email: 'test@example.com'
      };
      next();
      return undefined;
    });

    app.use('/api/funnels', funnelRoutes);
  });

  describe('GET /api/funnels', () => {
    it('should return all funnels for a user', async () => {
      mockGet.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Item: {
            settingName: 'funnels_test-user-123',
            funnels: {
              'funnel-1': {
                id: 'funnel-1',
                name: 'Main Conversion Funnel',
                stages: [
                  { name: 'Homepage', eventName: 'page_view', filterExpression: 'pagePath=~^/$', color: '#4285F4' },
                  { name: 'Form Submit', eventName: 'form_submit', color: '#FBBC04' }
                ],
                createdAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-01T00:00:00.000Z'
              }
            }
          }
        })
      });

      const response = await request(app)
        .get('/api/funnels')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.funnels).toHaveLength(1);
      expect(response.body.funnels[0].configId).toBe('funnel:funnel-1');
      expect(response.body.funnels[0].name).toBe('Main Conversion Funnel');
    });

    it('should return empty list when no funnels exist', async () => {
      mockGet.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Item: undefined })
      });

      const response = await request(app)
        .get('/api/funnels')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.funnels).toEqual([]);
      expect(mockPut).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/funnels/:configId', () => {
    it('should return a specific funnel', async () => {
      mockGet.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Item: {
            settingName: 'funnels_test-user-123',
            funnels: {
              'funnel-1': {
                id: 'funnel-1',
                name: 'Test Funnel',
                stages: [],
                createdAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-01T00:00:00.000Z'
              }
            }
          }
        })
      });

      const response = await request(app)
        .get('/api/funnels/funnel:funnel-1')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.funnel.name).toBe('Test Funnel');
    });

    it('should return 404 if funnel not found', async () => {
      mockGet.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Item: {
            settingName: 'funnels_test-user-123',
            funnels: {}
          }
        })
      });

      const response = await request(app)
        .get('/api/funnels/funnel:nonexistent')
        .expect(404);

      expect(response.body.success).toBe(false);
      expect(response.body.message).toBe('Funnel not found');
    });
  });

  describe('POST /api/funnels', () => {
    it('should create a new funnel', async () => {
      mockGet.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Item: {
            settingName: 'funnels_test-user-123',
            funnels: {}
          }
        })
      });

      mockPut.mockReturnValue({
        promise: jest.fn().mockResolvedValue({})
      });

      const response = await request(app)
        .post('/api/funnels')
        .send({
          name: 'New Funnel',
          stages: [
            { name: 'Stage 1', eventName: 'page_view', color: '#4285F4' }
          ]
        })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.funnel.name).toBe('New Funnel');
      expect(mockPut).toHaveBeenCalled();
    });

    it('should return 400 if name is missing', async () => {
      const response = await request(app)
        .post('/api/funnels')
        .send({
          stages: []
        })
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.message).toBe('Funnel name is required');
    });

    it('should return 400 if stages validation fails', async () => {
      const response = await request(app)
        .post('/api/funnels')
        .send({
          name: 'Test Funnel',
          stages: [
            { name: '', eventName: 'page_view' } // Invalid: empty name
          ]
        })
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.message).toBe('Invalid funnel configuration');
    });
  });

  describe('PUT /api/funnels/:configId', () => {
    it('should update an existing funnel', async () => {
      mockGet.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Item: {
            settingName: 'funnels_test-user-123',
            funnels: {
              'funnel-1': {
                id: 'funnel-1',
                name: 'Old Name',
                stages: [],
                createdAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-01T00:00:00.000Z'
              }
            }
          }
        })
      });

      mockPut.mockReturnValue({
        promise: jest.fn().mockResolvedValue({})
      });

      const response = await request(app)
        .put('/api/funnels/funnel:funnel-1')
        .send({
          name: 'Updated Name'
        })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.message).toBe('Funnel updated successfully');
      expect(mockPut).toHaveBeenCalled();
    });

    it('should return 404 if funnel not found', async () => {
      mockGet.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Item: {
            settingName: 'funnels_test-user-123',
            funnels: {}
          }
        })
      });

      const response = await request(app)
        .put('/api/funnels/funnel:nonexistent')
        .send({
          name: 'Updated Name'
        })
        .expect(404);

      expect(response.body.success).toBe(false);
      expect(response.body.message).toBe('Funnel not found');
    });
  });

  describe('DELETE /api/funnels/:configId', () => {
    it('should delete an existing funnel', async () => {
      mockGet.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Item: {
            settingName: 'funnels_test-user-123',
            funnels: {
              'funnel-1': {
                id: 'funnel-1',
                name: 'Test Funnel',
                stages: [],
                createdAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-01T00:00:00.000Z'
              }
            }
          }
        })
      });

      mockPut.mockReturnValue({
        promise: jest.fn().mockResolvedValue({})
      });

      const response = await request(app)
        .delete('/api/funnels/funnel:funnel-1')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.message).toBe('Funnel deleted successfully');
      expect(mockPut).toHaveBeenCalled();
    });

    it('should return 404 if funnel not found', async () => {
      mockGet.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Item: {
            settingName: 'funnels_test-user-123',
            funnels: {}
          }
        })
      });

      const response = await request(app)
        .delete('/api/funnels/funnel:nonexistent')
        .expect(404);

      expect(response.body.success).toBe(false);
      expect(response.body.message).toBe('Funnel not found');
    });
  });
});
