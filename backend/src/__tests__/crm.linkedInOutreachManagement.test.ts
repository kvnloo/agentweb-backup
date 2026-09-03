/**
 * Tests for ENG-1612's mechanical LinkedIn outreach-management routes:
 *
 *  - GET  /api/crm/linkedin/sent-invitations
 *  - POST /api/crm/linkedin/sent-invitations/:invitationId/withdraw
 *  - GET  /api/crm/linkedin/received-invitations
 *  - POST /api/crm/linkedin/received-invitations/:invitationId/accept
 *  - GET  /api/crm/linkedin/daily-quota
 *
 * These expose existing linkedInOutreachService / linkedInDailyVolumeGate
 * capabilities (previously Emma-chat-only) into the CRM UI. Focus: auth,
 * ownership checks (never operate on an account the caller doesn't own),
 * and that writes route through the same pacer Emma's tool calls use.
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
  crmDb: {},
  taskDb: { getTaskById: jest.fn() },
  subscriberDb: { getAllTaskSubscribers: jest.fn() },
  userDb: { getUserById: jest.fn() },
  orgDb: {},
}));

const mockListUserOwnedUnipileAccountIds = jest.fn();
const mockGetAllSentInvitationsByAccount = jest.fn();
const mockCancelInvitation = jest.fn();
const mockListReceivedInvitations = jest.fn();
const mockAcceptInvitation = jest.fn();

jest.mock('../services/linkedInOutreachService', () => ({
  linkedInOutreachService: {
    listUserOwnedUnipileAccountIds: (...args: any[]) => mockListUserOwnedUnipileAccountIds(...args),
    cancelInvitation: (...args: any[]) => mockCancelInvitation(...args),
    listReceivedInvitations: (...args: any[]) => mockListReceivedInvitations(...args),
    acceptInvitation: (...args: any[]) => mockAcceptInvitation(...args),
  },
}));

const mockDeleteSentInvitationByInvitationId = jest.fn();
jest.mock('../services/unipileSentInvitationsDb', () => ({
  getAllSentInvitationsByAccount: (...args: any[]) => mockGetAllSentInvitationsByAccount(...args),
  deleteSentInvitationByInvitationId: (...args: any[]) => mockDeleteSentInvitationByInvitationId(...args),
}));

const mockResolveLinkedInAccountForWrite = jest.fn();
const mockPaceLinkedInWrite = jest.fn();
jest.mock('../services/agentMode/linkedInDailyVolumeGate', () => ({
  resolveLinkedInAccountForWrite: (...args: any[]) => mockResolveLinkedInAccountForWrite(...args),
  paceLinkedInWrite: (...args: any[]) => mockPaceLinkedInWrite(...args),
}));

const mockPeekWriteCooldown = jest.fn((..._args: any[]) => ({ active: false, expiresAt: null }));
jest.mock('../services/linkedInWritePacer', () => ({
  resolveDailyInviteCap: jest.fn((cap: number | null | undefined) => (typeof cap === 'number' ? cap : 10)),
  dailyMessageCap: jest.fn(() => 20),
  peekWriteCooldown: (...args: any[]) => mockPeekWriteCooldown(...args),
}));

jest.mock('../services/agentModeService', () => ({ agentModeService: {} }));
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

import router from '../routes/crm';

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

beforeEach(() => {
  jest.clearAllMocks();
});

describe('GET /api/crm/linkedin/sent-invitations', () => {
  const handler = findHandler(router, '/linkedin/sent-invitations', 'get');

  it('route is registered', () => expect(handler).toBeTruthy());

  it('401 when unauthenticated', async () => {
    const req: any = { user: undefined, query: {} };
    const res = makeRes();
    await handler!(req, res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('400 when no LinkedIn account connected', async () => {
    mockListUserOwnedUnipileAccountIds.mockResolvedValue([]);
    const req: any = { user: { userId: 'test-user-id' }, query: {} };
    const res = makeRes();
    await handler!(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('403 when requesting an account the caller does not own', async () => {
    mockListUserOwnedUnipileAccountIds.mockResolvedValue(['acct-owned']);
    const req: any = { user: { userId: 'test-user-id' }, query: { accountId: 'acct-other' } };
    const res = makeRes();
    await handler!(req, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockGetAllSentInvitationsByAccount).not.toHaveBeenCalled();
  });

  it('defaults to the caller-owned account and returns invitations newest-first', async () => {
    mockListUserOwnedUnipileAccountIds.mockResolvedValue(['acct-owned']);
    mockGetAllSentInvitationsByAccount.mockResolvedValue([
      { invitationId: 'inv-1', sentAt: '2026-06-01T00:00:00.000Z' },
      { invitationId: 'inv-2', sentAt: '2026-06-03T00:00:00.000Z' },
    ]);
    const req: any = { user: { userId: 'test-user-id' }, query: {} };
    const res = makeRes();
    await handler!(req, res);
    expect(mockGetAllSentInvitationsByAccount).toHaveBeenCalledWith('acct-owned');
    expect(res.json).toHaveBeenCalledWith({
      accountId: 'acct-owned',
      invitations: [
        { invitationId: 'inv-2', sentAt: '2026-06-03T00:00:00.000Z' },
        { invitationId: 'inv-1', sentAt: '2026-06-01T00:00:00.000Z' },
      ],
    });
  });
});

describe('POST /api/crm/linkedin/sent-invitations/:invitationId/withdraw', () => {
  const handler = findHandler(router, '/linkedin/sent-invitations/:invitationId/withdraw', 'post');

  it('route is registered', () => expect(handler).toBeTruthy());

  it('401 when unauthenticated', async () => {
    const req: any = { user: undefined, params: { invitationId: 'inv-1' }, body: {} };
    const res = makeRes();
    await handler!(req, res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('400 when accountId missing', async () => {
    const req: any = { user: { userId: 'test-user-id' }, params: { invitationId: 'inv-1' }, body: {} };
    const res = makeRes();
    await handler!(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('403 when the account is not resolvable for this caller', async () => {
    mockResolveLinkedInAccountForWrite.mockResolvedValue(null);
    const req: any = {
      user: { userId: 'test-user-id' },
      params: { invitationId: 'inv-1' },
      body: { accountId: 'acct-1' },
    };
    const res = makeRes();
    await handler!(req, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockCancelInvitation).not.toHaveBeenCalled();
  });

  it('429 when the pacer refuses the withdraw', async () => {
    mockResolveLinkedInAccountForWrite.mockResolvedValue({ ownerUserId: 'test-user-id' });
    mockPaceLinkedInWrite.mockResolvedValue({ refusal: { success: false, message: 'paced', error: 'slow down' } });
    const req: any = {
      user: { userId: 'test-user-id' },
      params: { invitationId: 'inv-1' },
      body: { accountId: 'acct-1' },
    };
    const res = makeRes();
    await handler!(req, res);
    expect(mockPaceLinkedInWrite).toHaveBeenCalledWith('cancel-invitation', { ownerUserId: 'test-user-id' }, 'acct-1');
    expect(res.status).toHaveBeenCalledWith(429);
    expect(mockCancelInvitation).not.toHaveBeenCalled();
  });

  it('cancels the invitation, cleans up the cache, and does not fail the request when cache cleanup fails', async () => {
    mockResolveLinkedInAccountForWrite.mockResolvedValue({ ownerUserId: 'test-user-id' });
    mockPaceLinkedInWrite.mockResolvedValue({ refusal: null });
    mockCancelInvitation.mockResolvedValue({ ok: true });
    mockDeleteSentInvitationByInvitationId.mockRejectedValue(new Error('dynamo hiccup'));
    const req: any = {
      user: { userId: 'test-user-id' },
      params: { invitationId: 'inv-1' },
      body: { accountId: 'acct-1' },
    };
    const res = makeRes();
    await handler!(req, res);
    expect(mockCancelInvitation).toHaveBeenCalledWith('inv-1', 'acct-1');
    expect(mockDeleteSentInvitationByInvitationId).toHaveBeenCalledWith('acct-1', 'inv-1');
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, invitationId: 'inv-1', accountId: 'acct-1' }),
    );
    expect(res.status).not.toHaveBeenCalledWith(500);
  });
});

describe('GET /api/crm/linkedin/received-invitations', () => {
  const handler = findHandler(router, '/linkedin/received-invitations', 'get');

  it('route is registered', () => expect(handler).toBeTruthy());

  it('401 when unauthenticated', async () => {
    const req: any = { user: undefined, query: {} };
    const res = makeRes();
    await handler!(req, res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('lists received invitations for the resolved account', async () => {
    mockListUserOwnedUnipileAccountIds.mockResolvedValue(['acct-owned']);
    mockListReceivedInvitations.mockResolvedValue({ items: [{ invitation_id: 'r-1' }], cursor: null });
    const req: any = { user: { userId: 'test-user-id' }, query: {} };
    const res = makeRes();
    await handler!(req, res);
    expect(mockListReceivedInvitations).toHaveBeenCalledWith('acct-owned', undefined);
    expect(res.json).toHaveBeenCalledWith({ accountId: 'acct-owned', items: [{ invitation_id: 'r-1' }], cursor: null });
  });
});

describe('POST /api/crm/linkedin/received-invitations/:invitationId/accept', () => {
  const handler = findHandler(router, '/linkedin/received-invitations/:invitationId/accept', 'post');

  it('route is registered', () => expect(handler).toBeTruthy());

  it('400 when sharedSecret missing', async () => {
    const req: any = {
      user: { userId: 'test-user-id' },
      params: { invitationId: 'inv-1' },
      body: { accountId: 'acct-1' },
    };
    const res = makeRes();
    await handler!(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('429 when the pacer refuses the accept', async () => {
    mockResolveLinkedInAccountForWrite.mockResolvedValue({ ownerUserId: 'test-user-id' });
    mockPaceLinkedInWrite.mockResolvedValue({ refusal: { success: false, message: 'paced', error: 'slow down' } });
    const req: any = {
      user: { userId: 'test-user-id' },
      params: { invitationId: 'inv-1' },
      body: { accountId: 'acct-1', sharedSecret: 'secret-1' },
    };
    const res = makeRes();
    await handler!(req, res);
    expect(mockPaceLinkedInWrite).toHaveBeenCalledWith('accept-invitation', { ownerUserId: 'test-user-id' }, 'acct-1');
    expect(res.status).toHaveBeenCalledWith(429);
    expect(mockAcceptInvitation).not.toHaveBeenCalled();
  });

  it('accepts the invitation on the happy path', async () => {
    mockResolveLinkedInAccountForWrite.mockResolvedValue({ ownerUserId: 'test-user-id' });
    mockPaceLinkedInWrite.mockResolvedValue({ refusal: null });
    mockAcceptInvitation.mockResolvedValue({ ok: true });
    const req: any = {
      user: { userId: 'test-user-id' },
      params: { invitationId: 'inv-1' },
      body: { accountId: 'acct-1', sharedSecret: 'secret-1' },
    };
    const res = makeRes();
    await handler!(req, res);
    expect(mockAcceptInvitation).toHaveBeenCalledWith('inv-1', 'acct-1', 'secret-1');
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, invitationId: 'inv-1', accountId: 'acct-1' }),
    );
  });
});

describe('GET /api/crm/linkedin/daily-quota', () => {
  const handler = findHandler(router, '/linkedin/daily-quota', 'get');

  it('route is registered', () => expect(handler).toBeTruthy());

  it('401 when unauthenticated', async () => {
    const req: any = { user: undefined, query: {} };
    const res = makeRes();
    await handler!(req, res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('returns used/cap/remaining for invites and messages', async () => {
    mockListUserOwnedUnipileAccountIds.mockResolvedValue(['acct-owned']);
    mockResolveLinkedInAccountForWrite.mockResolvedValue({
      ownerUserId: 'test-user-id',
      configuredDailyInviteCap: 10,
      dailyVolumeState: {
        invite: { count: 3, windowStartedAt: Date.now() },
        message: { count: 5, windowStartedAt: Date.now() },
      },
    });
    const req: any = { user: { userId: 'test-user-id' }, query: {} };
    const res = makeRes();
    await handler!(req, res);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'acct-owned',
        invites: expect.objectContaining({ used: 3, cap: 10, remaining: 7 }),
        messages: expect.objectContaining({ used: 5, cap: 20, remaining: 15 }),
        cooldown: expect.objectContaining({ active: expect.any(Boolean), expiresAt: null }),
      }),
    );
  });
});
