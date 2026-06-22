/**
 * Tests for per-lead HubSpot sync-status behavior on the CRM lead routes:
 *  - POST /lists/:listId/leads  → stamps syncMetadata.syncStatus = 'sync_pending'
 *    when the list is HubSpot-connected (Task 4)
 *  - PUT  /lists/:listId/leads/:leadId → marks 'update_pending' when connected,
 *    auto-sync OFF, the lead is currently 'synced', and a mapped field changed
 *    (Task 5)
 *  - GET  /lists/:listId/leads → accepts ?syncStatus= filter (in-memory),
 *    returns hubspotConnected:boolean and a resolved syncStatus per lead (Task 6)
 *
 * Setup mirrors the established crm route-test pattern (see crm.contacts.test.ts):
 * mock ../services/db (crmDb), stub the auth middleware, import the crm router,
 * and invoke handlers directly via a findHandler helper. Access is granted by
 * making the list owned by the authenticated user (canAccessCrmList short-circuits
 * on list.userId === userId, so no userDb mocking is needed).
 */

// ─── Mocks ───────────────────────────────────────────────────────────────────

jest.mock('../server', () => ({
  io: { to: jest.fn().mockReturnValue({ emit: jest.fn() }), emit: jest.fn() },
  app: {},
}));

jest.mock('../controllers/templates', () => ({
  createTemplate: jest.fn(),
  getTemplates: jest.fn(),
  getTemplate: jest.fn(),
  updateTemplate: jest.fn(),
  deleteTemplate: jest.fn(),
  publishTemplate: jest.fn(),
}));

jest.mock('../services/db', () => ({
  crmDb: {
    getLeadListById: jest.fn(),
    getLeadsByListId: jest.fn(),
    getLeadById: jest.fn(),
    createLead: jest.fn(),
    updateLead: jest.fn(),
    addLeadEngagement: jest.fn(),
    getLeadEngagementCount: jest.fn(),
  },
  taskDb: { getTaskById: jest.fn() },
  subscriberDb: { getAllTaskSubscribers: jest.fn() },
  userDb: { getUserById: jest.fn() },
  orgDb: {},
}));

jest.mock('../services/emailEventsDb', () => ({ emailEventsDb: {} }));
jest.mock('../services/agentModeService', () => ({ agentModeService: {} }));
jest.mock('../utils/llmService', () => ({ createLLMService: jest.fn() }));
jest.mock('../services/settingsService', () => ({ settingsService: {} }));
jest.mock('../services/resendService', () => ({ resendService: {} }));
jest.mock('../services/leadListAlertService', () => ({ leadListAlertService: {} }));
jest.mock('../utils/s3Utils', () => ({ uploadFileToS3: jest.fn() }));
jest.mock('../services/contactDedupService', () => ({ dedupContactsForUser: jest.fn() }));

jest.mock('../services/externalCrmSyncService', () => ({
  externalCrmSyncService: {
    autoSyncLead: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../services/enrichSoLeadValidation', () => ({
  validateLeadEmailInBackground: jest.fn().mockResolvedValue(undefined),
  validateLeadsInBackground: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: 'test-user-id', email: 'test@example.com' };
    next();
  },
  AuthenticatedRequest: {},
}));

import router from '../routes/crm';
import { crmDb } from '../services/db';

const asMock = (fn: any) => fn as jest.Mock;

const findHandler = (routerObj: any, path: string, method: string) => {
  const layer = routerObj.stack.find(
    (r: any) => r.route?.path === path && r.route?.methods?.[method],
  );
  if (!layer?.route) return null;
  const handle = layer.route.stack[layer.route.stack.length - 1].handle;
  return (req: any, res: any) => handle(req, res, jest.fn());
};

const makeRes = () => ({
  status: jest.fn().mockReturnThis(),
  json: jest.fn().mockReturnThis(),
});

const HS_CONNECTED_LIST = {
  listId: 'list1',
  userId: 'test-user-id',
  externalCrmSyncConfigs: { hubspot: { accountId: 'acc1', autoSyncEnabled: false } },
};
const HS_AUTOSYNC_LIST = {
  listId: 'list1',
  userId: 'test-user-id',
  externalCrmSyncConfigs: { hubspot: { accountId: 'acc1', autoSyncEnabled: true } },
};
const HS_UNCONNECTED_LIST = {
  listId: 'list1',
  userId: 'test-user-id',
};

// ─── Task 4: POST create → sync_pending ──────────────────────────────────────

describe('POST /lists/:listId/leads — sync_pending stamping', () => {
  const handler = findHandler(router, '/lists/:listId/leads', 'post');

  beforeEach(() => {
    jest.clearAllMocks();
    // createLead echoes back the leadData it received so we can assert on the stamp.
    asMock(crmDb.createLead).mockImplementation(async (_listId: string, leadData: any) => ({
      leadId: 'new-lead',
      ...leadData,
    }));
  });

  it('route is registered', () => {
    expect(handler).toBeTruthy();
  });

  it('stamps syncStatus sync_pending in syncMetadata when the list is HubSpot-connected', async () => {
    asMock(crmDb.getLeadListById).mockResolvedValue(HS_CONNECTED_LIST);

    const req = { params: { listId: 'list1' }, body: { email: 'a@x.com' }, user: { userId: 'test-user-id' } };
    const res = makeRes();
    await handler!(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    const arg = asMock(crmDb.createLead).mock.calls[0][1];
    expect(arg.syncMetadata.syncStatus).toBe('sync_pending');
  });

  it('does NOT stamp syncStatus when the list is not connected', async () => {
    asMock(crmDb.getLeadListById).mockResolvedValue(HS_UNCONNECTED_LIST);

    const req = { params: { listId: 'list1' }, body: { email: 'a@x.com' }, user: { userId: 'test-user-id' } };
    const res = makeRes();
    await handler!(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    const arg = asMock(crmDb.createLead).mock.calls[0][1];
    expect(arg.syncMetadata?.syncStatus).toBeUndefined();
  });
});

// ─── Task 5: PUT update → update_pending ─────────────────────────────────────

describe('PUT /lists/:listId/leads/:leadId — update_pending stamping', () => {
  const handler = findHandler(router, '/lists/:listId/leads/:leadId', 'put');

  beforeEach(() => {
    jest.clearAllMocks();
    asMock(crmDb.updateLead).mockImplementation(async (_listId: string, leadId: string, updateData: any) => ({
      leadId,
      ...updateData,
    }));
  });

  it('route is registered', () => {
    expect(handler).toBeTruthy();
  });

  it('marks a synced lead update_pending when a mapped field changes and auto-sync is off', async () => {
    asMock(crmDb.getLeadListById).mockResolvedValue(HS_CONNECTED_LIST);
    asMock(crmDb.getLeadById).mockResolvedValue({
      leadId: 'lead1',
      company: 'Acme',
      syncMetadata: { hubspot_contact_id: 'c1', syncStatus: 'synced' },
    });

    const req = {
      params: { listId: 'list1', leadId: 'lead1' },
      body: { company: 'Beta' },
      user: { userId: 'test-user-id' },
    };
    const res = makeRes();
    await handler!(req, res);

    const arg = asMock(crmDb.updateLead).mock.calls.at(-1)?.[2];
    expect(arg.syncMetadata.syncStatus).toBe('update_pending');
    expect(arg.syncMetadata.hubspot_contact_id).toBe('c1'); // preserved
  });

  it('does NOT mark update_pending when only an unmapped field changes', async () => {
    asMock(crmDb.getLeadListById).mockResolvedValue(HS_CONNECTED_LIST);
    asMock(crmDb.getLeadById).mockResolvedValue({
      leadId: 'lead1',
      priority: 'Low',
      syncMetadata: { hubspot_contact_id: 'c1', syncStatus: 'synced' },
    });

    const req = {
      params: { listId: 'list1', leadId: 'lead1' },
      body: { priority: 'High' },
      user: { userId: 'test-user-id' },
    };
    const res = makeRes();
    await handler!(req, res);

    const arg = asMock(crmDb.updateLead).mock.calls.at(-1)?.[2];
    expect(arg.syncMetadata?.syncStatus).not.toBe('update_pending');
  });

  it('does NOT mark update_pending when auto-sync is enabled (adapter will set status)', async () => {
    asMock(crmDb.getLeadListById).mockResolvedValue(HS_AUTOSYNC_LIST);
    asMock(crmDb.getLeadById).mockResolvedValue({
      leadId: 'lead1',
      company: 'Acme',
      syncMetadata: { hubspot_contact_id: 'c1', syncStatus: 'synced' },
    });

    const req = {
      params: { listId: 'list1', leadId: 'lead1' },
      body: { company: 'Beta' },
      user: { userId: 'test-user-id' },
    };
    const res = makeRes();
    await handler!(req, res);

    const arg = asMock(crmDb.updateLead).mock.calls.at(-1)?.[2];
    expect(arg.syncMetadata?.syncStatus).not.toBe('update_pending');
  });

  it('does NOT mark update_pending when the lead was never synced (stays sync_pending)', async () => {
    asMock(crmDb.getLeadListById).mockResolvedValue(HS_CONNECTED_LIST);
    asMock(crmDb.getLeadById).mockResolvedValue({
      leadId: 'lead1',
      company: 'Acme',
      syncMetadata: {}, // resolves to sync_pending
    });

    const req = {
      params: { listId: 'list1', leadId: 'lead1' },
      body: { company: 'Beta' },
      user: { userId: 'test-user-id' },
    };
    const res = makeRes();
    await handler!(req, res);

    const arg = asMock(crmDb.updateLead).mock.calls.at(-1)?.[2];
    expect(arg.syncMetadata?.syncStatus).not.toBe('update_pending');
  });
});

// ─── Task 6: GET leads → filter + flags + resolved status ────────────────────

describe('GET /lists/:listId/leads — sync status filter + flags', () => {
  const handler = findHandler(router, '/lists/:listId/leads', 'get');

  const CANDIDATES = [
    { leadId: 'A', syncMetadata: { syncStatus: 'synced' } },
    { leadId: 'B', syncMetadata: { hubspot_contact_id: 'c1' } }, // legacy -> synced
    { leadId: 'C', syncMetadata: {} }, // -> sync_pending
  ];

  beforeEach(() => {
    jest.clearAllMocks();
    asMock(crmDb.getLeadEngagementCount).mockResolvedValue({
      total: 0,
      last7Days: 0,
      totalAllMessages: 0,
    });
  });

  it('route is registered', () => {
    expect(handler).toBeTruthy();
  });

  it('returns hubspotConnected:true and a resolved syncStatus per lead when connected', async () => {
    asMock(crmDb.getLeadListById).mockResolvedValue(HS_CONNECTED_LIST);
    asMock(crmDb.getLeadsByListId).mockResolvedValue({ items: CANDIDATES, lastEvaluatedKey: undefined });

    const req = { params: { listId: 'list1' }, query: {}, user: { userId: 'test-user-id' } };
    const res = makeRes();
    await handler!(req, res);

    const body = asMock(res.json).mock.calls.at(-1)?.[0];
    expect(body.hubspotConnected).toBe(true);
    const byId = Object.fromEntries(body.leads.map((l: any) => [l.leadId, l.syncStatus]));
    expect(byId.A).toBe('synced');
    expect(byId.B).toBe('synced');
    expect(byId.C).toBe('sync_pending');
  });

  it('filters to only leads whose resolved status matches ?syncStatus=', async () => {
    asMock(crmDb.getLeadListById).mockResolvedValue(HS_CONNECTED_LIST);
    asMock(crmDb.getLeadsByListId).mockResolvedValue({ items: CANDIDATES, lastEvaluatedKey: undefined });

    const req = { params: { listId: 'list1' }, query: { syncStatus: 'sync_pending' }, user: { userId: 'test-user-id' } };
    const res = makeRes();
    await handler!(req, res);

    const body = asMock(res.json).mock.calls.at(-1)?.[0];
    expect(body.leads.map((l: any) => l.leadId)).toEqual(['C']);
  });

  it('returns hubspotConnected:false and no syncStatus filtering when not connected', async () => {
    asMock(crmDb.getLeadListById).mockResolvedValue(HS_UNCONNECTED_LIST);
    asMock(crmDb.getLeadsByListId).mockResolvedValue({ items: CANDIDATES, lastEvaluatedKey: undefined });

    const req = { params: { listId: 'list1' }, query: { syncStatus: 'synced' }, user: { userId: 'test-user-id' } };
    const res = makeRes();
    await handler!(req, res);

    const body = asMock(res.json).mock.calls.at(-1)?.[0];
    expect(body.hubspotConnected).toBe(false);
    // syncStatus param ignored when not connected — all leads returned.
    expect(body.leads.map((l: any) => l.leadId)).toEqual(['A', 'B', 'C']);
  });
});
