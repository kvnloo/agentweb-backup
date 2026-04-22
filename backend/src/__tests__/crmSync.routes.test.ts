import request from 'supertest';
import express from 'express';
import crmSyncRoutes from '../routes/crmSync';

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: 'user-1' };
    next();
  },
}));

jest.mock('../services/db', () => ({
  crmDb: {
    getLeadListById: jest.fn().mockResolvedValue({ listId: 'list-1', userId: 'user-1' }),
    setLeadListCrmSyncConfig: jest.fn().mockResolvedValue(undefined),
    getLeadsByListId: jest.fn().mockResolvedValue({ items: [], lastEvaluatedKey: undefined }),
  },
}));

jest.mock('../services/externalCrmSyncService', () => ({
  externalCrmSyncService: {
    getDefaultMappings: jest.fn().mockResolvedValue({ contactFieldMapping: [], dealFieldMapping: [], customFieldMapping: [] }),
    getConfig: jest.fn().mockResolvedValue(null),
    saveConfig: jest.fn().mockResolvedValue({
      provider: 'attio',
      listId: 'list-1',
      userId: 'user-1',
      autoSyncEnabled: false,
      contactFieldMapping: [],
      dealFieldMapping: [],
      customFieldMapping: [],
      deleteOnPush: false,
      deleteOnPull: false,
      webhookEnabled: true,
      webhookSecret: 'abc123',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      apiKeyEncrypted: 'enc:something',
    }),
    deleteConfig: jest.fn().mockResolvedValue(undefined),
    getDistinctCustomFieldKeys: jest.fn().mockResolvedValue([]),
    testConnection: jest.fn().mockResolvedValue({ valid: true }),
    pushAllLeads: jest.fn().mockResolvedValue({ successCount: 0, newCount: 0, updatedCount: 0, errorCount: 0, errors: [] }),
    pullAllContacts: jest.fn().mockResolvedValue({ successCount: 0, newCount: 0, updatedCount: 0, errorCount: 0, errors: [] }),
    getExternalProperties: jest.fn().mockResolvedValue({ properties: [] }),
    getExternalPipelines: jest.fn().mockResolvedValue([]),
    deleteLeadFromCrm: jest.fn().mockResolvedValue(undefined),
    ensureWebhookSecret: jest.fn().mockResolvedValue(undefined),
  },
}));

const app = express();
app.use(express.json());
app.use('/api/crm-sync', crmSyncRoutes);

describe('PUT /api/crm-sync/config/:listId/:provider — Attio API key validation', () => {
  it('rejects an Attio API key shorter than 64 characters', async () => {
    const res = await request(app)
      .put('/api/crm-sync/config/list-1/attio')
      .send({ apiKey: 'too-short-key' })
      .expect(400);

    expect(res.body.error).toMatch(/must be exactly 64 characters/);
    expect(res.body.error).toMatch(/yours is 13/);
  });

  it('rejects an Attio API key longer than 64 characters', async () => {
    const longKey = 'a'.repeat(100);
    const res = await request(app)
      .put('/api/crm-sync/config/list-1/attio')
      .send({ apiKey: longKey })
      .expect(400);

    expect(res.body.error).toMatch(/must be exactly 64 characters/);
    expect(res.body.error).toMatch(/yours is 100/);
  });

  it('rejects a key with leading/trailing whitespace that makes it wrong length', async () => {
    const keyWithSpaces = '  ' + 'a'.repeat(60) + '  ';
    const res = await request(app)
      .put('/api/crm-sync/config/list-1/attio')
      .send({ apiKey: keyWithSpaces })
      .expect(400);

    expect(res.body.error).toMatch(/must be exactly 64 characters/);
  });

  it('accepts an Attio API key exactly 64 characters long', async () => {
    const validKey = 'a'.repeat(64);
    const res = await request(app)
      .put('/api/crm-sync/config/list-1/attio')
      .send({ apiKey: validKey })
      .expect(200);

    expect(res.body.configured).toBe(true);
  });

  it('skips Attio key length validation when no apiKey is provided (update other fields)', async () => {
    const res = await request(app)
      .put('/api/crm-sync/config/list-1/attio')
      .send({ autoSyncEnabled: true })
      .expect(200);

    expect(res.body.configured).toBe(true);
  });

  it('skips Attio key length validation for HubSpot provider', async () => {
    const { externalCrmSyncService } = require('../services/externalCrmSyncService');
    externalCrmSyncService.saveConfig.mockResolvedValueOnce({
      provider: 'hubspot',
      listId: 'list-1',
      userId: 'user-1',
      autoSyncEnabled: false,
      contactFieldMapping: [],
      dealFieldMapping: [],
      customFieldMapping: [],
      deleteOnPush: false,
      deleteOnPull: false,
      webhookEnabled: true,
      webhookSecret: 'abc123',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      apiKeyEncrypted: 'enc:something',
    });

    const res = await request(app)
      .put('/api/crm-sync/config/list-1/hubspot')
      .send({ apiKey: 'short-hubspot-token' })
      .expect(200);

    expect(res.body.configured).toBe(true);
  });
});
