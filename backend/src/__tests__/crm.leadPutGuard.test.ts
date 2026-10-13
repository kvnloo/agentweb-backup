/**
 * ENG-2157: PUT/PATCH /lists/:listId/leads/:leadId - server-owned-key guard (log / enforce / off),
 * contact-suppression audit event, and PATCH registration. Setup mirrors the established crm route-test pattern (see crm.contacts.test.ts):
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
import { crmDb, userDb } from '../services/db';

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


const asMockFn = asMock;
const LIST = { listId: 'list1', userId: 'test-user-id' };
const HS_CONNECTED_LIST = { listId: 'list1', userId: 'test-user-id', externalCrmSyncConfigs: { hubspot: { accountId: 'acc1', autoSyncEnabled: false } } };

const rawLayers = (method: string) =>
  (router as any).stack.filter((r: any) => r.route?.path === '/lists/:listId/leads/:leadId' && r.route?.methods?.[method]);

const call = async (body: any, extra: Record<string, any> = {}, method: 'put' | 'patch' = 'put') => {
  const handler = findHandler(router, '/lists/:listId/leads/:leadId', method)!;
  const req: any = { params: { listId: 'list1', leadId: 'lead1' }, body, user: { userId: 'test-user-id' }, headers: {}, ...extra };
  const res = makeRes();
  await handler(req, res);
  return { req, res };
};

const sentToDb = () => asMockFn(crmDb.updateLead).mock.calls.at(-1)?.[2];
let warn: jest.SpyInstance; let err: jest.SpyInstance;
const ENV_KEYS = ['CRM_LEAD_PUT_GUARD', 'CRM_CONTACT_STATUS_AUDIT'];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  jest.clearAllMocks();
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  ENV_KEYS.forEach((k) => delete process.env[k]);
  warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  err = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  asMockFn(crmDb.getLeadListById).mockResolvedValue(LIST);
  asMockFn(crmDb.getLeadById).mockResolvedValue({ leadId: 'lead1', contactStatus: 'active' });
  asMockFn(crmDb.updateLead).mockImplementation(async (_l: string, id: string, u: any) => ({ leadId: id, ...u }));
  asMockFn(crmDb.addLeadEngagement).mockResolvedValue({});
});
afterEach(() => {
  ENV_KEYS.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });
  warn.mockRestore(); err.mockRestore();
});
const guardLines = () => warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('[crm-lead-put-guard]'));

describe('PATCH on the lead route (ENG-2157)', () => {
  it('is registered, and is the SAME handler as PUT (so it gets the same guard and audit)', () => {
    expect(rawLayers('put')).toHaveLength(1);
    expect(rawLayers('patch')).toHaveLength(1);
    expect(rawLayers('patch')[0].route.stack.at(-1).handle).toBe(rawLayers('put')[0].route.stack.at(-1).handle);
  });
  it('persists what the customer portal deal editor sends (a full customFields map with a deal)', async () => {
    const deal = { status: 'won', mrr: 500 };
    const { res } = await call({ customFields: { keep: 'x', deal } }, {}, 'patch');
    expect(sentToDb().customFields).toEqual({ keep: 'x', deal });
    expect(res.status).not.toHaveBeenCalledWith(500);
  });
  it('still runs the guard and the audit on PATCH', async () => {
    await call({ syncMetadata: { hubspot_contact_id: 'X' }, contactStatus: 'do-not-contact' }, {}, 'patch');
    expect(guardLines()).toHaveLength(1);
    expect(crmDb.addLeadEngagement).toHaveBeenCalledTimes(1);
  });
});

describe('server-owned-key guard on the lead route (ENG-2157)', () => {
  const evil = { firstName: 'Ada', syncMetadata: { hubspot_contact_id: 'FORGED-1' }, lastAutoSendAt: null, firstTouch: { source: 'forged' }, customFieldsKeyMerge: true, contactStatusUpdatedBy: 'forged@example.invalid' };

  it('default (log): the database write is BYTE-IDENTICAL to the request body - behaviour unchanged - and the keys are reported', async () => {
    await call({ ...evil });
    expect(sentToDb()).toEqual(evil);
    expect(guardLines()).toHaveLength(1);
    const line = guardLines()[0];
    expect(line).toContain('syncMetadata');
    expect(line).not.toContain('FORGED');
    expect(line).not.toContain('example.invalid');
  });

  it('log mode with a body that has none of the keys writes nothing to the log', async () => {
    await call({ firstName: 'Ada', notes: 'n' });
    expect(guardLines()).toEqual([]);
  });

  it('enforce: the server-owned keys never reach the write, the rest do', async () => {
    process.env.CRM_LEAD_PUT_GUARD = 'enforce';
    await call({ ...evil });
    expect(sentToDb()).toEqual({ firstName: 'Ada' });
  });

  it('enforce: the server still writes ITS OWN syncMetadata (update_pending) after dropping the client one', async () => {
    process.env.CRM_LEAD_PUT_GUARD = 'enforce';
    asMockFn(crmDb.getLeadListById).mockResolvedValue(HS_CONNECTED_LIST);
    asMockFn(crmDb.getLeadById).mockResolvedValue({ leadId: 'lead1', company: 'Acme', syncMetadata: { hubspot_contact_id: 'real-c1', syncStatus: 'synced' } });
    await call({ company: 'Beta', syncMetadata: { hubspot_contact_id: 'FORGED-1', syncStatus: 'synced' } });
    expect(sentToDb().syncMetadata).toEqual({ hubspot_contact_id: 'real-c1', syncStatus: 'update_pending' });
  });

  it('enforce: a suppression change is stamped with the authenticated user, not the client value', async () => {
    process.env.CRM_LEAD_PUT_GUARD = 'enforce';
    await call({ contactStatus: 'do-not-contact', contactStatusUpdatedBy: 'forged@example.invalid', contactStatusUpdatedAt: '2020-01-01T00:00:00.000Z' });
    expect(sentToDb()).toEqual({ contactStatus: 'do-not-contact', contactStatusUpdatedBy: 'test-user-id' });
  });

  it('off: nothing is reported and nothing is dropped', async () => {
    process.env.CRM_LEAD_PUT_GUARD = 'off';
    await call({ ...evil });
    expect(sentToDb()).toEqual(evil);
    expect(guardLines()).toEqual([]);
  });

  it('the agent channel is reported as such', async () => {
    await call({ syncMetadata: {} }, { headers: { 'x-agentweb-channel': 'agent' } });
    expect(JSON.parse(guardLines()[0].slice(guardLines()[0].indexOf('{'))).channel).toBe('agent');
  });

  it('a request that fails the access check never reaches the guard', async () => {
    asMockFn(crmDb.getLeadListById).mockResolvedValue(null);
    const { res } = await call({ ...evil });
    expect(res.status).toHaveBeenCalledWith(404);
    expect(guardLines()).toEqual([]);
    expect(crmDb.updateLead).not.toHaveBeenCalled();
  });

  it('a 403 (editor access denied on someone else\'s list) never reaches the guard, the audit read or the write', async () => {
    asMockFn(crmDb.getLeadListById).mockResolvedValue({ listId: 'list1', userId: 'someone-else' });
    asMockFn(userDb.getUserById).mockResolvedValue({});
    const { res } = await call({ syncMetadata: { hubspot_contact_id: 'X' }, contactStatus: 'do-not-contact' });
    expect(res.status).toHaveBeenCalledWith(403);
    expect(guardLines()).toEqual([]);
    expect(crmDb.getLeadById).not.toHaveBeenCalled();
    expect(crmDb.updateLead).not.toHaveBeenCalled();
    expect(crmDb.addLeadEngagement).not.toHaveBeenCalled();
  });

  it('legitimate callers are unaffected in enforce mode: drawer fields, edit-dialog payload, drafts, deal editor, DNC buttons', async () => {
    process.env.CRM_LEAD_PUT_GUARD = 'enforce';
    const payloads: any[] = [
      { notes: 'n' }, { accountOwnerUserId: 'u1' }, { pocEmails: ['a@x.com'] }, { customFields: { a: 1 } },
      { email: 'a@x.com', firstName: 'A', lastName: 'B', phone: '1', company: 'C', title: 'T', linkedin: 'l', companyLinkedin: 'cl', customFields: {}, selectedSenderId: null, icpMatch: null, status: 's', dealValue: 5, dealCurrency: 'USD', enrichmentMetadata: { x: { editedBy: 'user' } } },
      { emailDraft: null }, { emailDraftFormat: 'html' }, { messageDraft: { content: 'x', createdAt: 'a', updatedAt: 'b' } }, { selectedSenderId: null }, { status: 'won' },
      { unsubscribedFromGroupEmail: false },
    ];
    for (const p of payloads) {
      await call(JSON.parse(JSON.stringify(p)));
      expect(sentToDb()).toEqual(p);
    }
    expect(guardLines()).toEqual([]);
  });
});

describe('contact-suppression audit on the lead route (ENG-2157)', () => {
  it('Mark Do Not Contact: writes first, then records who/when/what; the write itself is unchanged', async () => {
    asMockFn(crmDb.getLeadById).mockResolvedValue({ leadId: 'lead1', contactStatus: 'active', unsubscribedFromGroupEmail: false });
    const body = { contactStatus: 'do-not-contact', contactStatusReason: 'admin-flagged', unsubscribedFromGroupEmail: true, unsubscribedFromGroupEmailAt: '2026-10-12T00:00:00.000Z' };
    await call({ ...body });
    expect(sentToDb()).toEqual(body);
    expect(crmDb.addLeadEngagement).toHaveBeenCalledTimes(1);
    const [listId, leadId, ev] = asMockFn(crmDb.addLeadEngagement).mock.calls[0];
    expect([listId, leadId]).toEqual(['list1', 'lead1']);
    expect(ev).toMatchObject({ eventType: 'contact_status.changed', eventData: { actorUserId: 'test-user-id', channel: 'ui', via: 'lead-put', fromStatus: 'active', toStatus: 'do-not-contact', toGroupEmailUnsubscribed: true } });
    expect(asMockFn(crmDb.updateLead).mock.invocationCallOrder[0]).toBeLessThan(asMockFn(crmDb.addLeadEngagement).mock.invocationCallOrder[0]);
  });

  it('Resubscribe / Remove: records the clearing too', async () => {
    asMockFn(crmDb.getLeadById).mockResolvedValue({ leadId: 'lead1', contactStatus: 'do-not-contact', unsubscribedFromGroupEmail: true });
    await call({ contactStatus: 'active', contactStatusReason: null, contactStatusNote: null, unsubscribedFromGroupEmail: false });
    expect((asMockFn(crmDb.addLeadEngagement).mock.calls[0][2].eventData as any).note).toBe('Contact status: do-not-contact → active; Group email: subscribed');
  });

  it('records the actor even when the client forges one (log mode keeps the stored value, the audit does not trust it)', async () => {
    await call({ contactStatus: 'do-not-contact', contactStatusUpdatedBy: 'forged@example.invalid' });
    const ev = asMockFn(crmDb.addLeadEngagement).mock.calls[0][2];
    expect(JSON.stringify(ev)).not.toContain('forged');
    expect(ev.eventData.actorUserId).toBe('test-user-id');
  });

  it('records the delegated admin', async () => {
    await call({ contactStatus: 'do-not-contact' }, { delegateInfo: { isDelegated: true, adminUserId: 'admin-9' } });
    expect(asMockFn(crmDb.addLeadEngagement).mock.calls[0][2].eventData.delegatedByUserId).toBe('admin-9');
    await call({ contactStatus: 'do-not-contact' }, { delegateInfo: { isDelegated: false, adminUserId: 'admin-9' } });
    expect(asMockFn(crmDb.addLeadEngagement).mock.calls[1][2].eventData.delegatedByUserId).toBeUndefined();
  });

  it('a no-op write (state already as requested) records nothing', async () => {
    await call({ contactStatus: 'active' });
    expect(crmDb.addLeadEngagement).not.toHaveBeenCalled();
  });

  it('an update that does not touch suppression neither reads the lead for it nor audits', async () => {
    await call({ notes: 'n' });
    expect(crmDb.getLeadById).not.toHaveBeenCalled();
    expect(crmDb.addLeadEngagement).not.toHaveBeenCalled();
  });

  it('a failure to record never fails or changes the customer-facing response', async () => {
    asMockFn(crmDb.addLeadEngagement).mockRejectedValue(new Error('dynamo down'));
    const { res } = await call({ contactStatus: 'do-not-contact' });
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledTimes(1);
    expect(err.mock.calls.some((c) => String(c[0]).includes('[contact-status-audit]'))).toBe(true);
  });

  it('a failure to read the previous state skips the audit but never blocks the write', async () => {
    asMockFn(crmDb.getLeadById).mockRejectedValue(new Error('read failed'));
    const { res } = await call({ contactStatus: 'do-not-contact' });
    expect(crmDb.updateLead).toHaveBeenCalledTimes(1);
    expect(crmDb.addLeadEngagement).not.toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalledWith(500);
  });

  it('a failed write records nothing', async () => {
    asMockFn(crmDb.updateLead).mockRejectedValue(new Error('write failed'));
    const { res } = await call({ contactStatus: 'do-not-contact' });
    expect(res.status).toHaveBeenCalledWith(500);
    expect(crmDb.addLeadEngagement).not.toHaveBeenCalled();
  });

  it('CRM_CONTACT_STATUS_AUDIT=off: no read, no event, write unchanged', async () => {
    process.env.CRM_CONTACT_STATUS_AUDIT = 'off';
    await call({ contactStatus: 'do-not-contact' });
    expect(crmDb.getLeadById).not.toHaveBeenCalled();
    expect(crmDb.addLeadEngagement).not.toHaveBeenCalled();
    expect(sentToDb()).toEqual({ contactStatus: 'do-not-contact' });
  });

  it('an arbitrary contactStatus string cannot put engaged keywords into the stored event', async () => {
    await call({ contactStatus: 'replied and clicked, received' });
    const text = JSON.stringify(asMockFn(crmDb.addLeadEngagement).mock.calls[0][2]).toLowerCase();
    for (const kw of ['clicked', 'replied', 'received']) expect(text).not.toContain(kw);
  });
});
