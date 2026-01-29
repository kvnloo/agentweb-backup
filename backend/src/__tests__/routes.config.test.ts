import request from 'supertest';
import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import jwt from 'jsonwebtoken';
import { DocumentClient } from 'aws-sdk/clients/dynamodb';
import * as dbUtils from '../services/db';

// Mock dependencies BEFORE importing the route
const mockDynamoDb = {
  query: jest.fn().mockReturnThis(),
  put: jest.fn().mockReturnThis(),
  delete: jest.fn().mockReturnThis(),
  get: jest.fn().mockReturnThis(),
  update: jest.fn().mockReturnThis(),
  promise: jest.fn(),
};

jest.mock('aws-sdk', () => ({
  DynamoDB: {
    DocumentClient: jest.fn(() => mockDynamoDb)
  }
}));

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, res: any, next: any) => {
    req.user = { userId: 'test-user-id', email: 'test@example.com', isAdmin: false };
    next();
  }
}));

jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn(),
    getUserByEmail: jest.fn()
  }
}));

// Import the router and encryption functions
// We need to use require to ensure mocks are applied first, or just standard import is fine since jest hoists mocks.
// However, since we're testing the router attached to an express app, we'll set that up.
import configRouter, { encryptPassword, decryptPassword } from '../routes/config';

const app = express();
app.use(express.json());
app.use('/api/config', configRouter);

describe('Config Routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.JWT_SECRET = 'test-secret';
  });

  describe('Encryption Utilities', () => {
    it('should encrypt and decrypt a password correctly', () => {
      const originalPassword = 'my-secret-password';
      const userId = 'user-123';
      
      const encrypted = encryptPassword(originalPassword, userId);
      expect(encrypted).toBeDefined();
      expect(typeof encrypted).toBe('string');
      
      const decrypted = decryptPassword(encrypted);
      expect(decrypted.password).toBe(originalPassword);
      expect(decrypted.userId).toBe(userId);
    });
  });

  describe('GET /api/config', () => {
    it('should return user configurations', async () => {
      const mockConfigs = [
        { configId: '1', userId: 'test-user-id', website: 'example.com', password: 'p1' },
        { configId: '2', userId: 'test-user-id', website: 'test.com', password: 'p2', sharedConfigIds: ['shared-1'] }
      ];

      const mockSharedConfig = { 
        configId: 'shared-1', 
        userId: 'other-user', 
        website: 'shared.com', 
        password: 'p3' 
      };

      // Mock query response for user configs
      mockDynamoDb.promise.mockResolvedValueOnce({ Items: mockConfigs });
      
      // Mock query response for shared config lookup
      mockDynamoDb.promise.mockResolvedValueOnce({ Items: [mockSharedConfig] });

      // Mock user lookup for shared config
      (dbUtils.userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'other-user', email: 'shared@example.com' });

      const res = await request(app).get('/api/config');

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
      expect(res.body[0].website).toBe('example.com');
      expect(res.body[0]).not.toHaveProperty('password'); // Password should be stripped
      
      // Check shared config processing
      expect(res.body[1].sharedWith).toBeDefined();
      expect(res.body[1].sharedWith).toContain('shared@example.com');
    });

    it('should handle errors gracefully', async () => {
      mockDynamoDb.promise.mockRejectedValue(new Error('DynamoDB Error'));
      
      const res = await request(app).get('/api/config');
      
      expect(res.status).toBe(500);
      expect(res.body).toHaveProperty('error');
    });
  });

  describe('POST /api/config', () => {
    it('should create a valid website configuration', async () => {
      mockDynamoDb.promise.mockResolvedValue({});

      const configData = {
        website: 'example.com',
        username: 'user',
        password: 'password123',
        isApiConfig: false
      };

      const res = await request(app)
        .post('/api/config')
        .send(configData);

      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty('configId');
      
      expect(mockDynamoDb.put).toHaveBeenCalledWith(expect.objectContaining({
        TableName: expect.stringContaining('AW-Configs'),
        Item: expect.objectContaining({
          userId: 'test-user-id',
          website: 'example.com',
          isApiConfig: false
        })
      }));
    });

    it('should create a valid API configuration', async () => {
      mockDynamoDb.promise.mockResolvedValue({});

      const configData = {
        appName: 'MyApp',
        isApiConfig: true,
        username: 'api-user',
        password: 'api-key-123',
        integrationDocLink: 'http://docs.example.com'
      };

      const res = await request(app)
        .post('/api/config')
        .send(configData);

      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty('configId');
      
      expect(mockDynamoDb.put).toHaveBeenCalledWith(expect.objectContaining({
        Item: expect.objectContaining({
          isApiConfig: true,
          appName: 'MyApp',
          integrationDocLink: 'http://docs.example.com'
        })
      }));
    });

    it('should reject invalid domain in website config', async () => {
      const configData = {
        website: 'invalid-domain',
        username: 'user',
        password: 'password123'
      };

      const res = await request(app)
        .post('/api/config')
        .send(configData);

      expect(res.status).toBe(400);
      expect(mockDynamoDb.put).not.toHaveBeenCalled();
    });

    it('should reject missing fields for API config', async () => {
       const configData = {
        isApiConfig: true,
        // Missing appName
        username: 'user',
        password: 'password123'
      };

      const res = await request(app)
        .post('/api/config')
        .send(configData);

      expect(res.status).toBe(400);
    });
  });

  describe('DELETE /api/config/:configId', () => {
    it('should delete a configuration', async () => {
      mockDynamoDb.promise.mockResolvedValue({});

      const res = await request(app).delete('/api/config/123');

      expect(res.status).toBe(204);
      expect(mockDynamoDb.delete).toHaveBeenCalledWith(expect.objectContaining({
        Key: {
          userId: 'test-user-id',
          configId: '123'
        }
      }));
    });
  });

  describe('POST /api/config/:configId/share', () => {
    it('should share configuration with a specific user', async () => {
      // Mock existing config
      const mockConfig = {
        configId: 'config-1',
        userId: 'test-user-id',
        website: 'example.com',
        username: 'u',
        password: 'p',
        encryptedPassword: 'enc',
        isApiConfig: false,
        sharedConfigIds: []
      };
      
      // Get existing config
      mockDynamoDb.promise.mockResolvedValueOnce({ Item: mockConfig });
      
      // Get target user
      (dbUtils.userDb.getUserByEmail as jest.Mock).mockResolvedValue({ 
        userId: 'target-user', 
        email: 'target@example.com' 
      });

      // Update original config (first update call)
      mockDynamoDb.promise.mockResolvedValueOnce({});
      
      // Save new shared config (put call)
      mockDynamoDb.promise.mockResolvedValueOnce({});

      const res = await request(app)
        .post('/api/config/config-1/share')
        .send({ email: 'target@example.com' });

      expect(res.status).toBe(201);
      
      // Verify we looked up the user
      expect(dbUtils.userDb.getUserByEmail).toHaveBeenCalledWith('target@example.com');
      
      // Verify we created a new config for target user
      expect(mockDynamoDb.put).toHaveBeenCalledWith(expect.objectContaining({
        Item: expect.objectContaining({
          userId: 'target-user',
          website: 'example.com',
          sharedBy: 'test-user-id'
        })
      }));
    });

    it('should share API configuration preserving fields', async () => {
       // Mock existing API config
      const mockConfig = {
        configId: 'config-api',
        userId: 'test-user-id',
        appName: 'MyAPI',
        isApiConfig: true,
        username: 'u',
        password: 'p',
        encryptedPassword: 'enc',
        integrationDocLink: 'docs'
      };
      
      mockDynamoDb.promise.mockResolvedValueOnce({ Item: mockConfig });
      (dbUtils.userDb.getUserByEmail as jest.Mock).mockResolvedValue({ userId: 'target-user', email: 'target@example.com' });
      mockDynamoDb.promise.mockResolvedValueOnce({}); // Update
      mockDynamoDb.promise.mockResolvedValueOnce({}); // Put

      const res = await request(app)
        .post('/api/config/config-api/share')
        .send({ email: 'target@example.com' });

      expect(res.status).toBe(201);

      // Verify we created a new config preserving API fields
      expect(mockDynamoDb.put).toHaveBeenCalledWith(expect.objectContaining({
        Item: expect.objectContaining({
          userId: 'target-user',
          isApiConfig: true,
          appName: 'MyAPI',
          integrationDocLink: 'docs'
        })
      }));
    });

    it('should share with everyone (public)', async () => {
      mockDynamoDb.promise.mockResolvedValueOnce({ 
        Item: { configId: 'config-1', userId: 'test-user-id' } 
      });
      mockDynamoDb.promise.mockResolvedValueOnce({}); // Update

      const res = await request(app)
        .post('/api/config/config-1/share')
        .send({ shareWithEveryone: true });

      expect(res.status).toBe(201);
      
      expect(mockDynamoDb.update).toHaveBeenCalledWith(expect.objectContaining({
        Key: { userId: 'test-user-id', configId: 'config-1' },
        UpdateExpression: expect.stringContaining('SET shareWithEveryone = :shareWithEveryone')
      }));
    });
  });

  describe('GET /api/config/shared', () => {
    it('should return configs shared with me', async () => {
      // Mock directly shared configs
      mockDynamoDb.promise.mockResolvedValueOnce({ 
        Items: [{ 
          configId: 'shared-1', 
          website: 'direct.com', 
          sharedBy: 'friend-id', 
          userId: 'test-user-id' 
        }] 
      });
      
      // Mock publicly shared configs
      mockDynamoDb.promise.mockResolvedValueOnce({ 
        Items: [{ 
          configId: 'public-1', 
          appName: 'PublicAPI', 
          shareWithEveryone: 1, 
          userId: 'public-user' 
        }] 
      });

      // Mock user lookup for sharers
      (dbUtils.userDb.getUserById as jest.Mock).mockImplementation((id) => {
        if (id === 'friend-id') return { userId: 'friend-id', email: 'friend@example.com' };
        if (id === 'public-user') return { userId: 'public-user', email: 'public@example.com' };
        return null;
      });

      const res = await request(app).get('/api/config/shared');

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
      
      const direct = res.body.find((c: any) => c.configId === 'shared-1');
      expect(direct.sharedBy).toBe('friend@example.com');
      
      const publicConf = res.body.find((c: any) => c.configId === 'public-1');
      expect(publicConf.isPublic).toBe(true);
      expect(publicConf.appName).toBe('PublicAPI');
    });
  });

  describe('GET /api/config/api/:appName', () => {
    it('should return user\'s own API config if exists', async () => {
      // Mock user config found
      mockDynamoDb.promise.mockResolvedValueOnce({
        Items: [{ 
          configId: 'own-api', 
          appName: 'TargetApp', 
          isApiConfig: true, 
          username: 'me', 
          userId: 'test-user-id' 
        }]
      });

      const res = await request(app).get('/api/config/api/TargetApp');

      expect(res.status).toBe(200);
      expect(res.body.configId).toBe('own-api');
    });

    it('should return public API config if user config not found', async () => {
      // Mock user config NOT found
      mockDynamoDb.promise.mockResolvedValueOnce({ Items: [] });
      
      // Mock public config found
      mockDynamoDb.promise.mockResolvedValueOnce({
        Items: [{ 
          configId: 'public-api', 
          appName: 'TargetApp', 
          isApiConfig: true, 
          shareWithEveryone: 1,
          userId: 'other' 
        }]
      });

      const res = await request(app).get('/api/config/api/TargetApp');

      expect(res.status).toBe(200);
      expect(res.body.configId).toBe('public-api');
    });

    it('should return 404 if no config found', async () => {
      // Mock user config NOT found
      mockDynamoDb.promise.mockResolvedValueOnce({ Items: [] });
      // Mock public config NOT found
      mockDynamoDb.promise.mockResolvedValueOnce({ Items: [] });

      const res = await request(app).get('/api/config/api/TargetApp');

      expect(res.status).toBe(404);
    });
  });
});
