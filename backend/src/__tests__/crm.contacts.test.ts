/**
 * Tests for GET /api/crm/contacts — the server-side dedup endpoint
 * that replaces the /crm Inbox tab's client-side dedup fallback.
 *
 * Covers:
 *  - Unauthorized (no user) → 401
 *  - Invalid listType → 400
 *  - Invalid sort → 400
 *  - Invalid limit → 400
 *  - Happy path → 200 with deduped contacts + counts
 *  - Passes listType filter through to the service
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
    getLeadListsByUserId: jest.fn(),
    getLeadsByListId: jest.fn(),
    getLeadListById: jest.fn(),
  },
  taskDb: { getTaskById: jest.fn() },
  subscriberDb: { getAllTaskSubscribers: jest.fn() },
  userDb: { getUserById: jest.fn() },
  orgDb: { getOrgById: jest.fn(), getOrgMembers: jest.fn() },
}));

jest.mock('../services/emailEventsDb', () => ({
  emailEventsDb: {},
}));
jest.mock('../services/agentModeService', () => ({
  agentModeService: {},
}));
jest.mock('../utils/llmService', () => ({ createLLMService: jest.fn() }));
jest.mock('../services/settingsService', () => ({ settingsService: {} }));
jest.mock('../services/resendService', () => ({ resendService: {} }));
jest.mock('../services/leadListAlertService', () => ({ leadListAlertService: {} }));
jest.mock('../utils/s3Utils', () => ({ uploadFileToS3: jest.fn() }));

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: 'test-user-id', email: 'test@example.com' };
    next();
  },
  AuthenticatedRequest: {},
}));

jest.mock('../services/contactDedupService', () => ({
  dedupContactsForUser: jest.fn(),
}));

import router from '../routes/crm';
import { dedupContactsForUser } from '../services/contactDedupService';
import { userDb, orgDb } from '../services/db';

const asMock = (fn: any) => fn as jest.Mock;

const findHandler = (routerObj: any, path: string, method: string) => {
  const layer = routerObj.stack.find(
    (r: any) => r.route?.path === path && r.route?.methods?.[method],
  );
  if (!layer?.route) return null;
  const handle = layer.route.stack[layer.route.stack.length - 1].handle;
  return (req: any, res: any) => handle(req, res, jest.fn());
};

describe('GET /api/crm/contacts', () => {
  const handler = findHandler(router, '/contacts', 'get');
  let mockReq: any;
  let mockRes: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockReq = {
      query: {},
      user: { userId: 'test-user-id', email: 'test@example.com' },
    };
    mockRes = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
  });

  it('route is registered', () => {
    expect(handler).toBeTruthy();
  });

  it('returns 401 when no user on the request', async () => {
    mockReq.user = undefined;
    await handler!(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(401);
  });

  it('returns 400 when listType is invalid', async () => {
    mockReq.query = { listType: 'bogus' };
    await handler!(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(400);
  });

  it('returns 400 when sort is invalid', async () => {
    mockReq.query = { sort: 'abc' };
    await handler!(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(400);
  });

  it('returns 400 when limit is out of range', async () => {
    mockReq.query = { limit: '0' };
    await handler!(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(400);

    mockReq.query = { limit: 'not-a-number' };
    await handler!(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(400);
  });

  it('returns 200 with deduped result on happy path', async () => {
    asMock(dedupContactsForUser).mockResolvedValue({
      contacts: [
        {
          email: 'a@x.com',
          name: 'Alice',
          company: 'Acme',
          heatScore: 7,
          lastContactAt: '2026-04-14T00:00:00.000Z',
          lists: [{ listId: 'L1', name: 'Sales' }],
          primaryLead: { leadId: '1' },
        },
      ],
      total: 1,
      rawCount: 3,
      listsCount: 2,
    });

    mockReq.query = { listType: 'sales', limit: '500', sort: 'heat' };
    await handler!(mockReq, mockRes);

    expect(dedupContactsForUser).toHaveBeenCalledWith({
      userId: 'test-user-id',
      listType: 'sales',
      listIds: undefined,
      limit: 500,
      sort: 'heat',
      cursor: undefined,
      rawFetchLimit: 5000,
    });
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({
        total: 1,
        rawCount: 3,
        listsCount: 2,
        contacts: expect.any(Array),
        durationMs: expect.any(Number),
      }),
    );
  });

  // ENG-686 follow-up (found via live QA): this route pre-dated the
  // org-share model and unconditionally merged in every org member's
  // contacts regardless of shareSettings.crm.enabled.
  describe('org-share fan-out honours crm.enabled (ENG-686 follow-up)', () => {
    beforeEach(() => {
      asMock(dedupContactsForUser).mockResolvedValue({
        contacts: [],
        total: 0,
        rawCount: 0,
        listsCount: 0,
      });
      (orgDb.getOrgMembers as jest.Mock).mockResolvedValue([
        { userId: 'test-user-id' },
        { userId: 'other-member' },
      ]);
    });

    afterEach(() => {
      // jest.clearAllMocks() (outer beforeEach) clears call history but not
      // mockResolvedValue — reset explicitly so these org fixtures don't leak
      // into unrelated tests later in this file.
      (userDb.getUserById as jest.Mock).mockReset();
      (orgDb.getOrgById as jest.Mock).mockReset();
      (orgDb.getOrgMembers as jest.Mock).mockReset();
    });

    it('does not dedup across other members when crm.enabled is false and caller is a plain member', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'test-user-id', orgId: 'org-A' });
      (orgDb.getOrgById as jest.Mock).mockResolvedValue({
        orgId: 'org-A',
        ownerUserId: 'org-owner-id',
        shareSettings: { crm: { enabled: false, editors: [] } },
      });

      await handler!(mockReq, mockRes);

      expect(dedupContactsForUser).toHaveBeenCalledTimes(1);
      expect(dedupContactsForUser).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'test-user-id' }),
      );
    });

    it('still dedups across every member when crm.enabled is false and caller is the org owner', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'test-user-id', orgId: 'org-A' });
      (orgDb.getOrgById as jest.Mock).mockResolvedValue({
        orgId: 'org-A',
        ownerUserId: 'test-user-id',
        shareSettings: { crm: { enabled: false, editors: [] } },
      });

      await handler!(mockReq, mockRes);

      expect(dedupContactsForUser).toHaveBeenCalledTimes(2);
      expect(dedupContactsForUser).toHaveBeenCalledWith(expect.objectContaining({ userId: 'test-user-id' }));
      expect(dedupContactsForUser).toHaveBeenCalledWith(expect.objectContaining({ userId: 'other-member' }));
    });

    it('dedups across every member when crm.enabled is true (default)', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'test-user-id', orgId: 'org-A' });
      (orgDb.getOrgById as jest.Mock).mockResolvedValue({
        orgId: 'org-A',
        ownerUserId: 'org-owner-id',
        shareSettings: { crm: { enabled: true, editors: [] } },
      });

      await handler!(mockReq, mockRes);

      expect(dedupContactsForUser).toHaveBeenCalledTimes(2);
      expect(dedupContactsForUser).toHaveBeenCalledWith(expect.objectContaining({ userId: 'other-member' }));
    });
  });

  it('parses listIds from comma-separated query param', async () => {
    asMock(dedupContactsForUser).mockResolvedValue({
      contacts: [],
      total: 0,
      rawCount: 0,
      listsCount: 0,
    });
    mockReq.query = { listIds: 'L1, L2 , L3' };
    await handler!(mockReq, mockRes);
    expect(dedupContactsForUser).toHaveBeenCalledWith(
      expect.objectContaining({ listIds: ['L1', 'L2', 'L3'], rawFetchLimit: 5000 }),
    );
  });

  it('returns 500 when service throws', async () => {
    asMock(dedupContactsForUser).mockRejectedValue(new Error('nope'));
    await handler!(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(500);
  });

  it('returns 400 when cursor is malformed', async () => {
    mockReq.query = { cursor: '!!!not-valid-base64' };
    await handler!(mockReq, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(400);
  });

  it('passes cursor to service and returns nextCursor + hasMore in response', async () => {
    const validCursor = Buffer.from(
      JSON.stringify({ L1: { listId: 'L1', leadId: 'x' } }),
    ).toString('base64');
    asMock(dedupContactsForUser).mockResolvedValue({
      contacts: [],
      total: 0,
      rawCount: 0,
      listsCount: 1,
      nextCursor: 'next-cursor-value',
      hasMore: true,
    });
    mockReq.query = { cursor: validCursor };
    await handler!(mockReq, mockRes);

    expect(dedupContactsForUser).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: validCursor }),
    );
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({ nextCursor: 'next-cursor-value', hasMore: true }),
    );
  });
});
