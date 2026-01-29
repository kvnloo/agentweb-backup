import request from 'supertest';
import express from 'express';

// Mock dependencies BEFORE importing the route
jest.mock('aws-sdk', () => ({
  config: {
    update: jest.fn()
  },
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      query: jest.fn().mockReturnThis(),
      put: jest.fn().mockReturnThis(),
      delete: jest.fn().mockReturnThis(),
      get: jest.fn().mockReturnThis(),
      update: jest.fn().mockReturnThis(),
      promise: jest.fn(),
    }))
  },
  S3: jest.fn(() => ({}))
}));

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, res: any, next: any) => {
    req.user = { userId: 'test-user-id', email: 'test@example.com', isAdmin: true };
    next();
  },
  isAdmin: (req: any, res: any, next: any) => next()
}));

jest.mock('../services/settingsService', () => ({
  settingsService: {
    getSetting: jest.fn(),
    setSetting: jest.fn(),
  }
}));

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    refreshMcpTools: jest.fn().mockResolvedValue(undefined),
  }
}));

jest.mock('../mcp/client/mcpClientService', () => ({
  McpClientService: jest.fn().mockImplementation(() => ({
    initialize: jest.fn(),
    getTools: jest.fn().mockReturnValue([]),
    shutdown: jest.fn(),
  }))
}));

import mcpServersRouter from '../routes/mcpServers';
import { settingsService } from '../services/settingsService';

const app = express();
app.use(express.json());
app.use('/api/admin/mcp-servers', mcpServersRouter);

describe('MCP Servers Routes - Validation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (settingsService.getSetting as jest.Mock).mockResolvedValue(null);
    (settingsService.setSetting as jest.Mock).mockResolvedValue(undefined);
  });

  describe('POST /api/admin/mcp-servers - Name Validation', () => {
    it('should reject name with special characters', async () => {
      const res = await request(app)
        .post('/api/admin/mcp-servers')
        .send({
          name: 'server!@#',
          transport: 'streamable-http',
          url: 'http://localhost:3001/mcp'
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain('alphanumeric');
    });

    it('should reject name with spaces', async () => {
      const res = await request(app)
        .post('/api/admin/mcp-servers')
        .send({
          name: 'my server',
          transport: 'streamable-http',
          url: 'http://localhost:3001/mcp'
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain('alphanumeric');
    });

    it('should reject name longer than 64 characters', async () => {
      const longName = 'a'.repeat(65);
      const res = await request(app)
        .post('/api/admin/mcp-servers')
        .send({
          name: longName,
          transport: 'streamable-http',
          url: 'http://localhost:3001/mcp'
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain('1-64 characters');
    });

    it('should accept valid name with underscores and hyphens', async () => {
      const res = await request(app)
        .post('/api/admin/mcp-servers')
        .send({
          name: 'my_server-123',
          transport: 'streamable-http',
          url: 'http://localhost:3001/mcp'
        });

      expect(res.status).toBe(201);
    });
  });

  describe('POST /api/admin/mcp-servers - URL Validation', () => {
    it('should reject invalid URL format', async () => {
      const res = await request(app)
        .post('/api/admin/mcp-servers')
        .send({
          name: 'valid-server',
          transport: 'streamable-http',
          url: 'not-a-valid-url'
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain('valid http or https URL');
    });

    it('should reject ftp protocol URL', async () => {
      const res = await request(app)
        .post('/api/admin/mcp-servers')
        .send({
          name: 'valid-server',
          transport: 'sse',
          url: 'ftp://localhost:3001/mcp'
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain('valid http or https URL');
    });

    it('should accept http URL', async () => {
      const res = await request(app)
        .post('/api/admin/mcp-servers')
        .send({
          name: 'http-server',
          transport: 'streamable-http',
          url: 'http://localhost:3001/mcp'
        });

      expect(res.status).toBe(201);
    });

    it('should accept https URL', async () => {
      const res = await request(app)
        .post('/api/admin/mcp-servers')
        .send({
          name: 'https-server',
          transport: 'sse',
          url: 'https://example.com/mcp'
        });

      expect(res.status).toBe(201);
    });
  });

  describe('PUT /api/admin/mcp-servers/:name - Validation', () => {
    beforeEach(() => {
      (settingsService.getSetting as jest.Mock).mockResolvedValue({
        settingValue: JSON.stringify([
          { name: 'existing-server', transport: 'streamable-http', url: 'http://localhost:3001' }
        ])
      });
    });

    it('should reject new name with special characters', async () => {
      const res = await request(app)
        .put('/api/admin/mcp-servers/existing-server')
        .send({
          name: 'invalid name!'
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain('alphanumeric');
    });

    it('should reject invalid URL in update', async () => {
      const res = await request(app)
        .put('/api/admin/mcp-servers/existing-server')
        .send({
          url: 'not-a-url'
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain('valid http or https URL');
    });

    it('should accept valid updates', async () => {
      const res = await request(app)
        .put('/api/admin/mcp-servers/existing-server')
        .send({
          name: 'new-valid-name',
          url: 'https://new-url.com/mcp'
        });

      expect(res.status).toBe(200);
    });
  });
});
