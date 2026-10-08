/**
 * ENG-2361 — GET /api/crm/leads?status=pending_review merges pending-review
 * leads across every list the caller can access, annotated with listName.
 * Mirrors the crm route-test pattern (crm.leads.syncStatus.test.ts).
 */

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
    getLeadListsByUserId: jest.fn(),
    getLeadsByStatus: jest.fn(),
    getLeadsByListId: jest.fn(),
  },
  taskDb: { getTaskById: jest.fn() },
  subscriberDb: { getAllTaskSubscribers: jest.fn() },
  userDb: { getUserById: jest.fn() },
  orgDb: {},
}));

jest.mock('../services/crmAccessControl', () => ({
  ...jest.requireActual('../services/crmAccessControl'),
  canAccessCrmList: jest.fn(),
  getReadableOrgMemberIds: jest.fn(),
}));

jest.mock('../services/emailEventsDb', () => ({ emailEventsDb: {} }));
jest.mock('../services/agentModeService', () => ({ agentModeService: {} }));
jest.mock('../utils/llmService', () => ({ createLLMService: jest.fn() }));
jest.mock('../services/settingsService', () => ({ settingsService: {} }));
jest.mock('../services/resendService', () => ({ resendService: {} }));
jest.mock('../services/leadListAlertService', () => ({ leadListAlertService: {} }));
jest.mock('../utils/s3Utils', () => ({ uploadFileToS3: jest.fn() }));
jest.mock('../services/contactDedupService', () => ({ dedupContactsForUser: jest.fn() }));

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: 'test-user-id', email: 'test@example.com' };
    next();
  },
  AuthenticatedRequest: {},
}));

import router from '../routes/crm';
import { crmDb } from '../services/db';
import { canAccessCrmList, getReadableOrgMemberIds } from '../services/crmAccessControl';

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

const OWN_LIST = { listId: 'own', userId: 'test-user-id', name: 'My Prospects' };
const SHARED_LIST = { listId: 'shared', userId: 'teammate', name: 'Team List' };
const FORBIDDEN_LIST = { listId: 'forbidden', userId: 'teammate', name: 'Private' };

const LEADS: Record<string, any[]> = {
  own: [{ leadId: 'a', status: 'pending_review', messageDraft: 'Hi A', updatedAt: '2026-10-01T00:00:00Z' }],
  shared: [{ leadId: 'b', status: 'pending_review', messageDraft: 'Hi B', updatedAt: '2026-10-05T00:00:00Z' }],
  forbidden: [{ leadId: 'c', status: 'pending_review', messageDraft: 'Hi C', updatedAt: '2026-10-07T00:00:00Z' }],
};

describe('GET /leads — cross-list pending review (ENG-2361)', () => {
  const handler = findHandler(router, '/leads', 'get');

  beforeEach(() => {
    jest.clearAllMocks();
    asMock(getReadableOrgMemberIds).mockResolvedValue(['teammate']);
    asMock(crmDb.getLeadListsByUserId).mockImplementation(async (uid: string) =>
      uid === 'test-user-id' ? [OWN_LIST] : [SHARED_LIST, FORBIDDEN_LIST],
    );
    asMock(canAccessCrmList).mockImplementation(async (_uid: string, list: any) => list.listId !== 'forbidden');
    asMock(crmDb.getLeadsByStatus).mockImplementation(async (listId: string) => ({
      items: LEADS[listId] || [],
      lastEvaluatedKey: undefined,
    }));
  });

  it('merges pending_review leads from accessible lists with listName and draft, newest first', async () => {
    const res = makeRes();
    await handler!({ query: { status: 'pending_review' }, user: { userId: 'test-user-id' } }, res);

    const body = asMock(res.json).mock.calls[0][0];
    expect(body.truncated).toBe(false);
    expect(body.total).toBe(2);
    expect(body.leads.map((l: any) => [l.leadId, l.listId, l.listName, l.messageDraft])).toEqual([
      ['b', 'shared', 'Team List', 'Hi B'],
      ['a', 'own', 'My Prospects', 'Hi A'],
    ]);
  });

  it('never returns leads from a list that fails canAccessCrmList', async () => {
    const res = makeRes();
    await handler!({ query: { status: 'pending_review' }, user: { userId: 'test-user-id' } }, res);

    const body = asMock(res.json).mock.calls[0][0];
    expect(body.leads.some((l: any) => l.listId === 'forbidden' || l.leadId === 'c')).toBe(false);
    expect(asMock(crmDb.getLeadsByStatus).mock.calls.map((c) => c[0])).not.toContain('forbidden');
  });

  it.each([undefined, '', 'approved', 'new'])('rejects status=%p with 400', async (status) => {
    const res = makeRes();
    await handler!({ query: status === undefined ? {} : { status }, user: { userId: 'test-user-id' } }, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(crmDb.getLeadsByStatus).not.toHaveBeenCalled();
  });
});
