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

jest.mock('../services/generateMarketingResponseWorkerService', () => ({
  generateMarketingResponseWorkerService: {
    shutdown: jest.fn().mockResolvedValue(undefined),
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
import { generateMarketingResponseWorkerService } from '../services/generateMarketingResponseWorkerService';

const app = express();
app.use(express.json());
app.use('/api/admin/mcp-servers', mcpServersRouter);

describe('MCP Servers Routes - Validation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (settingsService.getSetting as jest.Mock).mockResolvedValue(null);
    (settingsService.setSetting as jest.Mock).mockResolvedValue(undefined);
  });

  const waitForAsyncSideEffects = () => new Promise((resolve) => setTimeout(resolve, 0));

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
      await waitForAsyncSideEffects();
      expect(generateMarketingResponseWorkerService.shutdown).toHaveBeenCalled();
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

    it('should ignore url field for stdio transport and preserve command', async () => {
      const res = await request(app)
        .post('/api/admin/mcp-servers')
        .send({
          name: 'stdio-server',
          transport: 'stdio',
          url: 'test@example.com',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp']
        });

      expect(res.status).toBe(201);
      expect(res.body.transport).toBe('stdio');
      expect(res.body.command).toBe('npx');
      expect(res.body.url).toBeUndefined();
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
      await waitForAsyncSideEffects();
      expect(generateMarketingResponseWorkerService.shutdown).toHaveBeenCalled();
    });
  });

  describe('excludeFromAgent (hide from agent / backend-only)', () => {
    const lastSavedServers = () => {
      const calls = (settingsService.setSetting as jest.Mock).mock.calls;
      return JSON.parse(calls[calls.length - 1][1]);
    };

    it('POST persists excludeFromAgent:true', async () => {
      const res = await request(app)
        .post('/api/admin/mcp-servers')
        .send({
          name: 'backend-only-srv',
          transport: 'streamable-http',
          url: 'https://x.com/mcp',
          excludeFromAgent: true,
        });

      expect(res.status).toBe(201);
      expect(res.body.excludeFromAgent).toBe(true);
      expect(lastSavedServers()[0].excludeFromAgent).toBe(true);
    });

    it('PUT preserves excludeFromAgent when the field is not in the request body', async () => {
      (settingsService.getSetting as jest.Mock).mockResolvedValue({
        settingValue: JSON.stringify([
          { name: 'hf', transport: 'streamable-http', url: 'https://x.com/mcp', excludeFromAgent: true },
        ]),
      });

      const res = await request(app)
        .put('/api/admin/mcp-servers/hf')
        .send({ url: 'https://y.com/mcp' }); // unrelated edit, no excludeFromAgent

      expect(res.status).toBe(200);
      expect(lastSavedServers()[0].excludeFromAgent).toBe(true);
    });

    it('GET returns excludeFromAgent so the edit UI can reflect it (and never leaks oauth secrets)', async () => {
      (settingsService.getSetting as jest.Mock).mockResolvedValue({
        settingValue: JSON.stringify([
          {
            name: 'hf',
            transport: 'streamable-http',
            url: 'https://x.com/mcp',
            excludeFromAgent: true,
            oauthTokens: 'ENCRYPTED_SECRET',
            oauthClientInfo: 'ENCRYPTED_CLIENT',
          },
        ]),
      });

      const res = await request(app).get('/api/admin/mcp-servers');
      expect(res.status).toBe(200);
      expect(res.body[0].excludeFromAgent).toBe(true);
      // secrets must still be stripped
      expect(res.body[0].oauthTokens).toBeUndefined();
      expect(res.body[0].oauthClientInfo).toBeUndefined();
    });

    it('PUT can clear excludeFromAgent when explicitly set false', async () => {
      (settingsService.getSetting as jest.Mock).mockResolvedValue({
        settingValue: JSON.stringify([
          { name: 'hf', transport: 'streamable-http', url: 'https://x.com/mcp', excludeFromAgent: true },
        ]),
      });

      const res = await request(app)
        .put('/api/admin/mcp-servers/hf')
        .send({ excludeFromAgent: false });

      expect(res.status).toBe(200);
      expect(lastSavedServers()[0].excludeFromAgent).toBeUndefined();
    });
  });

  describe('DELETE /api/admin/mcp-servers/:name - Worker Recycle', () => {
    beforeEach(() => {
      (settingsService.getSetting as jest.Mock).mockResolvedValue({
        settingValue: JSON.stringify([
          { name: 'existing-server', transport: 'streamable-http', url: 'http://localhost:3001' }
        ])
      });
    });

    it('should recycle worker after successful delete', async () => {
      const res = await request(app)
        .delete('/api/admin/mcp-servers/existing-server');

      expect(res.status).toBe(200);
      await waitForAsyncSideEffects();
      expect(generateMarketingResponseWorkerService.shutdown).toHaveBeenCalled();
    });
  });
});
