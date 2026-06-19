import request from 'supertest';
import express from 'express';
import crmSyncRoutes from '../routes/crmSync';

jest.mock('../utils/hubspotWebhookSubscriptions', () => ({
  ensureWebhookSubscriptions: jest.fn().mockResolvedValue(undefined),
}));

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
    getLeadListsByUserId: jest.fn().mockResolvedValue([]),
    getLeadListsForUser: jest.fn().mockResolvedValue([]),
  },
  userDb: {
    getUserById: jest.fn().mockResolvedValue({ userId: 'user-1' }),
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
    startPushJob: jest.fn().mockResolvedValue({ job: { jobId: 'job-1', status: 'running', startedAt: '2026-01-01T00:00:00.000Z' }, completion: Promise.resolve() }),
    getPushJob: jest.fn().mockResolvedValue({ jobId: 'job-1', status: 'running', startedAt: '2026-01-01T00:00:00.000Z' }),
    pullAllContacts: jest.fn().mockResolvedValue({ successCount: 0, newCount: 0, updatedCount: 0, errorCount: 0, errors: [] }),
    getExternalProperties: jest.fn().mockResolvedValue({ properties: [] }),
    getExternalPipelines: jest.fn().mockResolvedValue([]),
    changePipeline: jest.fn().mockResolvedValue({
      provider: 'hubspot',
      listId: 'list-1',
      userId: 'user-1',
      accountId: 'acct-1',
      externalPipelineId: 'new-pipe',
      autoSyncEnabled: true,
      contactFieldMapping: [],
      dealFieldMapping: [],
      customFieldMapping: [],
      webhookEnabled: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    }),
    deleteLeadFromCrm: jest.fn().mockResolvedValue(undefined),
    ensureWebhookSecret: jest.fn().mockResolvedValue(undefined),
  },
}));

const app = express();
app.use(express.json());
app.use('/api/crm-sync', crmSyncRoutes);

describe('PUT /api/crm-sync/config/:listId/:provider/pipeline — change pipeline', () => {
  const { externalCrmSyncService } = require('../services/externalCrmSyncService');

  it('rejects a non-hubspot provider with 400', async () => {
    const res = await request(app)
      .put('/api/crm-sync/config/list-1/attio/pipeline')
      .send({ externalPipelineId: 'p1' })
      .expect(400);
    expect(res.body.error).toMatch(/only supported for HubSpot/i);
  });

  it('rejects a missing externalPipelineId with 400', async () => {
    const res = await request(app)
      .put('/api/crm-sync/config/list-1/hubspot/pipeline')
      .send({})
      .expect(400);
    expect(res.body.error).toMatch(/externalPipelineId is required/i);
  });

  it('changes the pipeline and returns the updated config', async () => {
    const res = await request(app)
      .put('/api/crm-sync/config/list-1/hubspot/pipeline')
      .send({ externalPipelineId: 'new-pipe' })
      .expect(200);
    expect(externalCrmSyncService.changePipeline).toHaveBeenCalledWith('user-1', 'list-1', 'hubspot', 'new-pipe');
    expect(res.body.config.externalPipelineId).toBe('new-pipe');
  });

  it('surfaces service errors as 500', async () => {
    externalCrmSyncService.changePipeline.mockRejectedValueOnce(new Error('Pipeline not found in HubSpot: nope'));
    const res = await request(app)
      .put('/api/crm-sync/config/list-1/hubspot/pipeline')
      .send({ externalPipelineId: 'nope' })
      .expect(500);
    expect(res.body.error).toMatch(/not found/i);
  });
});

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

describe('POST /api/crm-sync/test/:listId/:provider — persist on success', () => {
  const { externalCrmSyncService } = require('../services/externalCrmSyncService');

  beforeEach(() => {
    jest.clearAllMocks();
    externalCrmSyncService.getDefaultMappings.mockResolvedValue({ contactFieldMapping: [], dealFieldMapping: [], customFieldMapping: [] });
    externalCrmSyncService.saveConfig.mockResolvedValue({
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
      webhookSecret: 'secret-xyz',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      apiKeyEncrypted: 'enc:token',
    });
    process.env.BACKEND_URL = 'http://backend.test';
  });

  it('persists minimal config and returns webhookUrl when test succeeds with apiKey', async () => {
    externalCrmSyncService.testConnection.mockResolvedValueOnce({ valid: true });

    const res = await request(app)
      .post('/api/crm-sync/test/list-1/hubspot')
      .send({ apiKey: 'pat-na1-xyz' })
      .expect(200);

    expect(res.body.valid).toBe(true);
    expect(res.body.webhookUrl).toBe('http://backend.test/api/crm/hubspot/list-1/webhook?secret=secret-xyz');
    expect(externalCrmSyncService.saveConfig).toHaveBeenCalledWith(
      'user-1', 'list-1', 'hubspot',
      expect.objectContaining({ apiKey: 'pat-na1-xyz' })
    );
  });

  it('persists minimal config and returns webhookUrl when test succeeds with accountId (OAuth)', async () => {
    externalCrmSyncService.testConnection.mockResolvedValueOnce({ valid: true });

    const res = await request(app)
      .post('/api/crm-sync/test/list-1/hubspot')
      .send({ accountId: 'acct-123' })
      .expect(200);

    expect(res.body.valid).toBe(true);
    expect(res.body.webhookUrl).toMatch(/secret=secret-xyz$/);
    expect(externalCrmSyncService.saveConfig).toHaveBeenCalledWith(
      'user-1', 'list-1', 'hubspot',
      expect.objectContaining({ accountId: 'acct-123' })
    );
  });

  it('does NOT persist config when test fails', async () => {
    externalCrmSyncService.testConnection.mockResolvedValueOnce({ valid: false, error: 'Invalid token' });

    const res = await request(app)
      .post('/api/crm-sync/test/list-1/hubspot')
      .send({ apiKey: 'bad-token' })
      .expect(200);

    expect(res.body.valid).toBe(false);
    expect(res.body.webhookUrl).toBeUndefined();
    expect(externalCrmSyncService.saveConfig).not.toHaveBeenCalled();
  });

  it('does NOT persist when test succeeds without inline credentials (re-test existing config)', async () => {
    externalCrmSyncService.testConnection.mockResolvedValueOnce({ valid: true });

    await request(app)
      .post('/api/crm-sync/test/list-1/hubspot')
      .send({})
      .expect(200);

    expect(externalCrmSyncService.saveConfig).not.toHaveBeenCalled();
  });

  it('rejects unauthorized list access', async () => {
    const { crmDb } = require('../services/db');
    crmDb.getLeadListById.mockResolvedValueOnce({ listId: 'list-1', userId: 'other-user' });

    await request(app)
      .post('/api/crm-sync/test/list-1/hubspot')
      .send({ apiKey: 'pat-na1-xyz' })
      .expect(403);

    expect(externalCrmSyncService.saveConfig).not.toHaveBeenCalled();
  });
});

describe('POST /api/crm-sync/push/:listId/:provider — async job', () => {
  const { externalCrmSyncService } = require('../services/externalCrmSyncService');
  const { crmDb, userDb } = require('../services/db');

  beforeEach(() => {
    jest.clearAllMocks();
    crmDb.getLeadListById.mockResolvedValue({ listId: 'list-1', userId: 'user-1' });
    userDb.getUserById.mockResolvedValue({ userId: 'user-1' });
  });

  it('returns 202 with a running job and does NOT block on completion', async () => {
    let resolveCompletion: () => void = () => {};
    const completion = new Promise<void>((r) => { resolveCompletion = r; });
    externalCrmSyncService.startPushJob.mockResolvedValueOnce({
      job: { jobId: 'job-async', status: 'running', startedAt: '2026-01-01T00:00:00.000Z' },
      completion,
    });

    const res = await request(app)
      .post('/api/crm-sync/push/list-1/hubspot')
      .send({})
      .expect(202);

    expect(res.body.jobId).toBe('job-async');
    expect(res.body.status).toBe('running');
    // The route must not have awaited completion (still pending here).
    resolveCompletion();
  });

  it('returns 403 when the user cannot access the list', async () => {
    crmDb.getLeadListById.mockResolvedValueOnce({ listId: 'list-1', userId: 'other' });
    userDb.getUserById.mockImplementation((id: string) =>
      Promise.resolve(id === 'other' ? { userId: 'other', orgId: 'B' } : { userId: 'user-1', orgId: 'A' })
    );

    await request(app)
      .post('/api/crm-sync/push/list-1/hubspot')
      .send({})
      .expect(403);

    expect(externalCrmSyncService.startPushJob).not.toHaveBeenCalled();
  });

  it('returns 500 with the error message when startPushJob throws (e.g. no config)', async () => {
    externalCrmSyncService.startPushJob.mockRejectedValueOnce(new Error('No sync configuration found'));

    const res = await request(app)
      .post('/api/crm-sync/push/list-1/hubspot')
      .send({})
      .expect(500);

    expect(res.body.error).toMatch(/No sync configuration found/);
  });
});

describe('GET /api/crm-sync/push/:listId/:provider/status — job status', () => {
  const { externalCrmSyncService } = require('../services/externalCrmSyncService');
  const { crmDb, userDb } = require('../services/db');

  beforeEach(() => {
    jest.clearAllMocks();
    crmDb.getLeadListById.mockResolvedValue({ listId: 'list-1', userId: 'user-1' });
    userDb.getUserById.mockResolvedValue({ userId: 'user-1' });
  });

  it('returns the job status when a job exists', async () => {
    externalCrmSyncService.getPushJob.mockResolvedValueOnce({
      jobId: 'job-1', status: 'completed', startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:01:00.000Z',
      result: { successCount: 5, newCount: 5, updatedCount: 0, errorCount: 0, errors: [] },
    });

    const res = await request(app)
      .get('/api/crm-sync/push/list-1/hubspot/status')
      .expect(200);

    expect(res.body.status).toBe('completed');
    expect(res.body.result.successCount).toBe(5);
  });

  it('returns status idle (200) when no job has run', async () => {
    externalCrmSyncService.getPushJob.mockResolvedValueOnce(null);

    const res = await request(app)
      .get('/api/crm-sync/push/list-1/hubspot/status')
      .expect(200);

    expect(res.body.status).toBe('idle');
  });

  it('returns 403 when the user cannot access the list', async () => {
    crmDb.getLeadListById.mockResolvedValueOnce({ listId: 'list-1', userId: 'other' });
    userDb.getUserById.mockImplementation((id: string) =>
      Promise.resolve(id === 'other' ? { userId: 'other', orgId: 'B' } : { userId: 'user-1', orgId: 'A' })
    );

    await request(app)
      .get('/api/crm-sync/push/list-1/hubspot/status')
      .expect(403);
  });
});

describe('Org-aware access control on CRM sync routes', () => {
  const { crmDb, userDb } = require('../services/db');
  const { externalCrmSyncService } = require('../services/externalCrmSyncService');

  beforeEach(() => {
    jest.clearAllMocks();
    externalCrmSyncService.getConfig.mockResolvedValue(null);
    externalCrmSyncService.getDefaultMappings.mockResolvedValue({ contactFieldMapping: [], dealFieldMapping: [], customFieldMapping: [] });
  });

  it('allows an org member to load config for a list owned by another member of the same org', async () => {
    // List owned by a different user...
    crmDb.getLeadListById.mockResolvedValue({ listId: 'list-1', userId: 'owner-2' });
    // ...but both users belong to the same org.
    userDb.getUserById.mockImplementation((id: string) =>
      Promise.resolve(id === 'owner-2' ? { userId: 'owner-2', orgId: 'org-A' } : { userId: 'user-1', orgId: 'org-A' })
    );

    const res = await request(app)
      .get('/api/crm-sync/config/list-1/hubspot')
      .expect(200);

    expect(res.body.configured).toBe(false);
  });

  it('denies a user who is not the owner and not in the same org', async () => {
    crmDb.getLeadListById.mockResolvedValue({ listId: 'list-1', userId: 'owner-2' });
    userDb.getUserById.mockImplementation((id: string) =>
      Promise.resolve(id === 'owner-2' ? { userId: 'owner-2', orgId: 'org-B' } : { userId: 'user-1', orgId: 'org-A' })
    );

    await request(app)
      .get('/api/crm-sync/config/list-1/hubspot')
      .expect(403);
  });

  it('denies access when the owner has no org (private list of another user)', async () => {
    crmDb.getLeadListById.mockResolvedValue({ listId: 'list-1', userId: 'owner-2' });
    userDb.getUserById.mockImplementation((id: string) =>
      Promise.resolve(id === 'owner-2' ? { userId: 'owner-2' } : { userId: 'user-1', orgId: 'org-A' })
    );

    await request(app)
      .get('/api/crm-sync/config/list-1/hubspot')
      .expect(403);
  });

  it('allows an org member to save config for a list owned by another member', async () => {
    crmDb.getLeadListById.mockResolvedValue({ listId: 'list-1', userId: 'owner-2' });
    userDb.getUserById.mockImplementation((id: string) =>
      Promise.resolve(id === 'owner-2' ? { userId: 'owner-2', orgId: 'org-A' } : { userId: 'user-1', orgId: 'org-A' })
    );
    externalCrmSyncService.saveConfig.mockResolvedValue({
      provider: 'hubspot', listId: 'list-1', userId: 'user-1',
      autoSyncEnabled: false, contactFieldMapping: [], dealFieldMapping: [], customFieldMapping: [],
      deleteOnPush: false, deleteOnPull: false, webhookEnabled: true, webhookSecret: 'abc',
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    });

    const res = await request(app)
      .put('/api/crm-sync/config/list-1/hubspot')
      .send({ autoSyncEnabled: false })
      .expect(200);

    expect(res.body.configured).toBe(true);
  });
});

describe('PUT /api/crm-sync/config/:listId/:provider — one-account-per-list enforcement', () => {
  const { crmDb } = require('../services/db');
  const { externalCrmSyncService } = require('../services/externalCrmSyncService');

  beforeEach(() => {
    jest.clearAllMocks();
    crmDb.getLeadListById.mockResolvedValue({ listId: 'list-1', userId: 'user-1' });
    externalCrmSyncService.saveConfig.mockResolvedValue({
      provider: 'hubspot', listId: 'list-1', userId: 'user-1', accountId: 'portal-123',
      autoSyncEnabled: false, contactFieldMapping: [], dealFieldMapping: [], customFieldMapping: [],
      deleteOnPush: false, deleteOnPull: false, webhookEnabled: true, webhookSecret: 'abc',
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('returns 409 when accountId is already linked to a different list', async () => {
    crmDb.getLeadListsForUser.mockResolvedValue([
      { listId: 'list-other', name: 'Other List', externalCrmSyncConfigs: { hubspot: { accountId: 'portal-123' } } },
    ]);

    const res = await request(app)
      .put('/api/crm-sync/config/list-1/hubspot')
      .send({ accountId: 'portal-123' })
      .expect(409);

    expect(res.body.error).toMatch(/already linked/);
    expect(res.body.error).toMatch(/Other List/);
    expect(externalCrmSyncService.saveConfig).not.toHaveBeenCalled();
  });

  it('allows save when the same list already owns the accountId (update scenario)', async () => {
    crmDb.getLeadListsForUser.mockResolvedValue([
      { listId: 'list-1', name: 'My List', externalCrmSyncConfigs: { hubspot: { accountId: 'portal-123' } } },
    ]);

    await request(app)
      .put('/api/crm-sync/config/list-1/hubspot')
      .send({ accountId: 'portal-123' })
      .expect(200);

    expect(externalCrmSyncService.saveConfig).toHaveBeenCalled();
  });

  it('allows save when accountId is absent (mapping-only update)', async () => {
    crmDb.getLeadListsForUser.mockResolvedValue([
      { listId: 'list-other', name: 'Other', externalCrmSyncConfigs: { hubspot: { accountId: 'portal-123' } } },
    ]);

    await request(app)
      .put('/api/crm-sync/config/list-1/hubspot')
      .send({ autoSyncEnabled: true })
      .expect(200);

    expect(externalCrmSyncService.saveConfig).toHaveBeenCalled();
  });

  it('returns 409 when an org member already has the accountId linked (org-scoped check)', async () => {
    // Simulate a different org member's list owning the same portal
    crmDb.getLeadListsForUser.mockResolvedValue([
      { listId: 'list-org-member', name: 'Team List', externalCrmSyncConfigs: { hubspot: { accountId: 'portal-123' } } },
    ]);

    const res = await request(app)
      .put('/api/crm-sync/config/list-1/hubspot')
      .send({ accountId: 'portal-123' })
      .expect(409);

    expect(res.body.error).toMatch(/already linked/);
    expect(externalCrmSyncService.saveConfig).not.toHaveBeenCalled();
  });
});

describe('POST /api/crm-sync/test/:listId/:provider — one-account-per-list enforcement', () => {
  const { crmDb } = require('../services/db');
  const { externalCrmSyncService } = require('../services/externalCrmSyncService');

  beforeEach(() => {
    jest.clearAllMocks();
    crmDb.getLeadListById.mockResolvedValue({ listId: 'list-1', userId: 'user-1' });
    externalCrmSyncService.testConnection.mockResolvedValue({ valid: true });
    externalCrmSyncService.saveConfig.mockResolvedValue({
      provider: 'hubspot', listId: 'list-1', userId: 'user-1', accountId: 'portal-123',
      autoSyncEnabled: false, contactFieldMapping: [], dealFieldMapping: [], customFieldMapping: [],
      deleteOnPush: false, deleteOnPull: false, webhookEnabled: true, webhookSecret: 'sec',
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('returns 409 when accountId being tested is already linked to a different list', async () => {
    crmDb.getLeadListsForUser.mockResolvedValue([
      { listId: 'list-other', name: 'Taken List', externalCrmSyncConfigs: { hubspot: { accountId: 'portal-123' } } },
    ]);

    const res = await request(app)
      .post('/api/crm-sync/test/list-1/hubspot')
      .send({ accountId: 'portal-123' })
      .expect(409);

    expect(res.body.error).toMatch(/already linked/);
    expect(externalCrmSyncService.saveConfig).not.toHaveBeenCalled();
  });

  it('saves config after successful test when no conflict exists', async () => {
    crmDb.getLeadListsForUser.mockResolvedValue([]);

    const res = await request(app)
      .post('/api/crm-sync/test/list-1/hubspot')
      .send({ accountId: 'portal-123' })
      .expect(200);

    expect(res.body.valid).toBe(true);
    expect(externalCrmSyncService.saveConfig).toHaveBeenCalled();
  });
});

describe('GET /api/crm-sync/used-accounts', () => {
  const { crmDb } = require('../services/db');

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns empty array when user has no lists', async () => {
    crmDb.getLeadListsByUserId.mockResolvedValue([]);

    const res = await request(app).get('/api/crm-sync/used-accounts').expect(200);
    expect(res.body.used).toEqual([]);
  });

  it('returns empty array when lists have no externalCrmSyncConfigs', async () => {
    crmDb.getLeadListsByUserId.mockResolvedValue([
      { listId: 'list-a', name: 'List A' },
    ]);

    const res = await request(app).get('/api/crm-sync/used-accounts').expect(200);
    expect(res.body.used).toEqual([]);
  });

  it('returns empty array when configs have no accountId', async () => {
    crmDb.getLeadListsByUserId.mockResolvedValue([
      { listId: 'list-a', name: 'List A', externalCrmSyncConfigs: { hubspot: { apiKeyEncrypted: 'enc' } } },
    ]);

    const res = await request(app).get('/api/crm-sync/used-accounts').expect(200);
    expect(res.body.used).toEqual([]);
  });

  it('returns accountId entries from all providers', async () => {
    crmDb.getLeadListsByUserId.mockResolvedValue([
      {
        listId: 'list-a',
        name: 'Prospects',
        externalCrmSyncConfigs: {
          hubspot: { accountId: 'portal-123' },
        },
      },
    ]);

    const res = await request(app).get('/api/crm-sync/used-accounts').expect(200);
    expect(res.body.used).toHaveLength(1);
    expect(res.body.used[0]).toMatchObject({
      accountId: 'portal-123',
      listId: 'list-a',
      listName: 'Prospects',
      provider: 'hubspot',
    });
  });

  it('falls back to listId when list has no name', async () => {
    crmDb.getLeadListsByUserId.mockResolvedValue([
      {
        listId: 'list-b',
        externalCrmSyncConfigs: { hubspot: { accountId: 'portal-456' } },
      },
    ]);

    const res = await request(app).get('/api/crm-sync/used-accounts').expect(200);
    expect(res.body.used[0].listName).toBe('list-b');
  });

  it('returns entries from multiple lists', async () => {
    crmDb.getLeadListsByUserId.mockResolvedValue([
      { listId: 'list-a', name: 'A', externalCrmSyncConfigs: { hubspot: { accountId: 'p1' } } },
      { listId: 'list-b', name: 'B', externalCrmSyncConfigs: { hubspot: { accountId: 'p2' } } },
    ]);

    const res = await request(app).get('/api/crm-sync/used-accounts').expect(200);
    expect(res.body.used).toHaveLength(2);
    const ids = res.body.used.map((u: any) => u.accountId);
    expect(ids).toContain('p1');
    expect(ids).toContain('p2');
  });
});

describe('PUT /api/crm-sync/config/:listId/:provider — ensureWebhookSubscriptions', () => {
  const { externalCrmSyncService } = require('../services/externalCrmSyncService');
  const { ensureWebhookSubscriptions } = require('../utils/hubspotWebhookSubscriptions');

  beforeEach(() => {
    jest.clearAllMocks();
    externalCrmSyncService.saveConfig.mockResolvedValue({
      provider: 'hubspot',
      listId: 'list-1',
      userId: 'user-1',
      accountId: 'portal-123',
      autoSyncEnabled: false,
      contactFieldMapping: [],
      dealFieldMapping: [],
      customFieldMapping: [],
      deleteOnPush: false,
      deleteOnPull: false,
      webhookEnabled: true,
      webhookSecret: 'abc',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('calls ensureWebhookSubscriptions for hubspot when accountId in request', async () => {
    await request(app)
      .put('/api/crm-sync/config/list-1/hubspot')
      .send({ accountId: 'portal-123' })
      .expect(200);

    await new Promise(r => setTimeout(r, 20));
    expect(ensureWebhookSubscriptions).toHaveBeenCalled();
  });

  it('calls ensureWebhookSubscriptions for hubspot when accountId in saved config', async () => {
    await request(app)
      .put('/api/crm-sync/config/list-1/hubspot')
      .send({ autoSyncEnabled: true })
      .expect(200);

    await new Promise(r => setTimeout(r, 20));
    expect(ensureWebhookSubscriptions).toHaveBeenCalled();
  });

  it('does NOT call ensureWebhookSubscriptions for attio', async () => {
    externalCrmSyncService.saveConfig.mockResolvedValue({
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
      webhookSecret: 'abc',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    await request(app)
      .put('/api/crm-sync/config/list-1/attio')
      .send({ apiKey: 'a'.repeat(64) })
      .expect(200);

    await new Promise(r => setTimeout(r, 20));
    expect(ensureWebhookSubscriptions).not.toHaveBeenCalled();
  });

  it('passes contactFieldMapping and customFieldMapping to ensureWebhookSubscriptions', async () => {
    const contactFieldMapping = [{ agentwebField: 'email', crmProperty: 'email', direction: 'both', enabled: true }];
    const customFieldMapping = [{ agentwebField: 'myField', crmProperty: 'my_field', direction: 'both', enabled: true }];

    externalCrmSyncService.saveConfig.mockResolvedValue({
      provider: 'hubspot',
      listId: 'list-1',
      userId: 'user-1',
      accountId: 'portal-123',
      autoSyncEnabled: false,
      contactFieldMapping,
      customFieldMapping,
      dealFieldMapping: [],
      deleteOnPush: false,
      deleteOnPull: false,
      webhookEnabled: true,
      webhookSecret: 'abc',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    await request(app)
      .put('/api/crm-sync/config/list-1/hubspot')
      .send({ accountId: 'portal-123', contactFieldMapping, customFieldMapping })
      .expect(200);

    await new Promise(r => setTimeout(r, 20));
    expect(ensureWebhookSubscriptions).toHaveBeenCalledWith(
      contactFieldMapping,
      customFieldMapping
    );
  });
});

describe('DELETE /api/crm-sync/config/:listId/:provider/account — disconnect account', () => {
  const { externalCrmSyncService } = require('../services/externalCrmSyncService');
  const { crmDb } = require('../services/db');

  beforeEach(() => {
    jest.clearAllMocks();
    crmDb.getLeadListById.mockResolvedValue({ listId: 'list-1', userId: 'user-1' });
    externalCrmSyncService.disconnectAccount = jest.fn().mockResolvedValue(undefined);
  });

  it('returns 200 and calls disconnectAccount', async () => {
    const res = await request(app)
      .delete('/api/crm-sync/config/list-1/hubspot/account')
      .expect(200);

    expect(res.body.message).toBe('Account disconnected');
    expect(externalCrmSyncService.disconnectAccount).toHaveBeenCalledWith('user-1', 'list-1', 'hubspot');
  });

  it('returns 404 when list does not exist', async () => {
    crmDb.getLeadListById.mockResolvedValue(null);
    await request(app)
      .delete('/api/crm-sync/config/list-1/hubspot/account')
      .expect(404);

    expect(externalCrmSyncService.disconnectAccount).not.toHaveBeenCalled();
  });

  it('returns 500 when disconnectAccount throws', async () => {
    externalCrmSyncService.disconnectAccount.mockRejectedValue(new Error('DB failure'));
    const res = await request(app)
      .delete('/api/crm-sync/config/list-1/hubspot/account')
      .expect(500);

    expect(res.body.error).toBe('DB failure');
  });
});
