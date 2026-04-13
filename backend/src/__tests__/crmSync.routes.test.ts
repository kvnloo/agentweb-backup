import request from 'supertest';
import express from 'express';
import crmSyncRoutes from '../routes/crmSync';
import { externalCrmSyncService } from '../services/externalCrmSyncService';
import { crmDb } from '../services/db';

// Mock auth middleware
jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: 'user123', email: 'test@example.com' };
    next();
  },
  AuthenticatedRequest: {},
}));

jest.mock('../services/externalCrmSyncService');
jest.mock('../services/db', () => ({
  crmDb: {
    getLeadListById: jest.fn(),
  },
}));

const mockSyncService = externalCrmSyncService as jest.Mocked<typeof externalCrmSyncService>;
const mockCrmDb = crmDb as jest.Mocked<typeof crmDb>;

const app = express();
app.use(express.json());
app.use('/api/crm/sync', crmSyncRoutes);

describe('CRM Sync Routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (mockCrmDb.getLeadListById as jest.Mock).mockResolvedValue({
      listId: 'list123',
      userId: 'user123',
      name: 'Test List',
    });
  });

  describe('GET /config/:listId/:provider', () => {
    it('returns configured: false when no config exists', async () => {
      (mockSyncService.getConfig as jest.Mock).mockResolvedValue(null);

      const res = await request(app).get('/api/crm/sync/config/list123/hubspot');
      expect(res.status).toBe(200);
      expect(res.body.configured).toBe(false);
    });

    it('returns masked config when configured', async () => {
      (mockSyncService.getConfig as jest.Mock).mockResolvedValue({
        provider: 'hubspot',
        apiKeyEncrypted: 'encrypted',
        autoSyncEnabled: true,
        contactFieldMapping: [],
        dealFieldMapping: [],
        lastPushSyncAt: '2026-01-01T00:00:00.000Z',
      });

      const res = await request(app).get('/api/crm/sync/config/list123/hubspot');
      expect(res.status).toBe(200);
      expect(res.body.configured).toBe(true);
      expect(res.body.apiKeyMasked).toBe('••••••••');
      expect(res.body).not.toHaveProperty('apiKeyEncrypted');
    });

    it('returns 404 when list not found', async () => {
      (mockCrmDb.getLeadListById as jest.Mock).mockResolvedValue(null);

      const res = await request(app).get('/api/crm/sync/config/nonexistent/hubspot');
      expect(res.status).toBe(404);
    });

    it('returns 403 when user does not own list', async () => {
      (mockCrmDb.getLeadListById as jest.Mock).mockResolvedValue({
        listId: 'list123',
        userId: 'other-user',
      });

      const res = await request(app).get('/api/crm/sync/config/list123/hubspot');
      expect(res.status).toBe(403);
    });
  });

  describe('PUT /config/:listId/:provider', () => {
    it('saves config successfully', async () => {
      (mockSyncService.saveConfig as jest.Mock).mockResolvedValue({
        provider: 'hubspot',
        apiKeyEncrypted: 'encrypted',
        autoSyncEnabled: true,
        contactFieldMapping: [],
        dealFieldMapping: [],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      });

      const res = await request(app)
        .put('/api/crm/sync/config/list123/hubspot')
        .send({ apiKey: 'test-key', autoSyncEnabled: true });

      expect(res.status).toBe(200);
      expect(res.body.configured).toBe(true);
      expect(mockSyncService.saveConfig).toHaveBeenCalledWith('user123', 'list123', 'hubspot', {
        apiKey: 'test-key',
        autoSyncEnabled: true,
        contactFieldMapping: undefined,
        dealFieldMapping: undefined,
      });
    });

    it('rejects unsupported providers', async () => {
      const res = await request(app)
        .put('/api/crm/sync/config/list123/salesforce')
        .send({ apiKey: 'test-key' });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain('Unsupported provider');
    });
  });

  describe('DELETE /config/:listId/:provider', () => {
    it('deletes config successfully', async () => {
      (mockSyncService.deleteConfig as jest.Mock).mockResolvedValue(undefined);

      const res = await request(app).delete('/api/crm/sync/config/list123/hubspot');
      expect(res.status).toBe(200);
      expect(mockSyncService.deleteConfig).toHaveBeenCalledWith('user123', 'list123', 'hubspot');
    });
  });

  describe('POST /test/:listId/:provider', () => {
    it('returns connection test result', async () => {
      (mockSyncService.testConnection as jest.Mock).mockResolvedValue({ valid: true });

      const res = await request(app).post('/api/crm/sync/test/list123/hubspot');
      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(true);
    });

    it('returns error on failed connection', async () => {
      (mockSyncService.testConnection as jest.Mock).mockResolvedValue({
        valid: false,
        error: 'Invalid API key',
      });

      const res = await request(app).post('/api/crm/sync/test/list123/hubspot');
      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(false);
      expect(res.body.error).toBe('Invalid API key');
    });
  });

  describe('POST /push/:listId/:provider', () => {
    it('returns sync result on success', async () => {
      (mockSyncService.pushAllLeads as jest.Mock).mockResolvedValue({
        successCount: 10,
        newCount: 5,
        updatedCount: 5,
        errorCount: 0,
        errors: [],
      });

      const res = await request(app).post('/api/crm/sync/push/list123/hubspot');
      expect(res.status).toBe(200);
      expect(res.body.successCount).toBe(10);
    });

    it('returns 500 on service error', async () => {
      (mockSyncService.pushAllLeads as jest.Mock).mockRejectedValue(new Error('No sync configuration found'));

      const res = await request(app).post('/api/crm/sync/push/list123/hubspot');
      expect(res.status).toBe(500);
    });
  });

  describe('POST /pull/:listId/:provider', () => {
    it('returns sync result on success', async () => {
      (mockSyncService.pullAllContacts as jest.Mock).mockResolvedValue({
        successCount: 8,
        newCount: 6,
        updatedCount: 2,
        errorCount: 0,
        errors: [],
      });

      const res = await request(app).post('/api/crm/sync/pull/list123/hubspot');
      expect(res.status).toBe(200);
      expect(res.body.newCount).toBe(6);
    });
  });
});
