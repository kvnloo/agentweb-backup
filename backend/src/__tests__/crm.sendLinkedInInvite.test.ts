/**
 * Tests for POST /api/crm/lists/:listId/leads/:leadId/send-linkedin-invite
 *
 * Focus: the account a LinkedIn connection invite is sent from must be a sender the
 * user actually configured. The route must NOT silently borrow a site-wide shared
 * Unipile account (resolveAccountId) — it resolves the caller-specified account, then
 * the list-assigned account, then the user's OWN connected account, else returns 400.
 *
 * Covers:
 *  - 401 when unauthenticated
 *  - 404 when list not found / not accessible
 *  - 404 when lead not found
 *  - 400 when lead has no LinkedIn URL
 *  - 400 when no LinkedIn sender is configured (no own account, no list account)
 *  - Does NOT fall back to the site-wide shared pool (resolveAccountId not called)
 *  - Uses the list-assigned account when present
 *  - Uses the caller-specified account when provided (highest precedence)
 *  - Happy path: invitation sent and linkedInInviteSentAt stamped
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

const mockGetLeadListById = jest.fn();
const mockGetLeadById = jest.fn();
const mockUpdateLead = jest.fn();
const mockGetUserById = jest.fn();

jest.mock('../services/db', () => ({
  crmDb: {
    getLeadListById: (...args: any[]) => mockGetLeadListById(...args),
    getLeadById: (...args: any[]) => mockGetLeadById(...args),
    updateLead: (...args: any[]) => mockUpdateLead(...args),
    getLeadsByListId: jest.fn().mockResolvedValue({ leads: [] }),
  },
  taskDb: { getTaskById: jest.fn() },
  subscriberDb: { getAllTaskSubscribers: jest.fn() },
  userDb: { getUserById: (...args: any[]) => mockGetUserById(...args) },
}));

const mockUpsertSentInvitation = jest.fn();
jest.mock('../services/unipileSentInvitationsDb', () => ({
  upsertSentInvitation: (...args: any[]) => mockUpsertSentInvitation(...args),
}));

const mockNormalizeLinkedInUrl = jest.fn((u: string) => u.toLowerCase().replace(/\/?$/, '/'));
jest.mock('../services/unipileConnectionsDb', () => ({
  normalizeLinkedInUrl: (u: string) => mockNormalizeLinkedInUrl(u),
}));

const mockResolveAccountId = jest.fn();
const mockResolveUserOwnedAccountId = jest.fn();
const mockSendInvitation = jest.fn();

jest.mock('../services/linkedInOutreachService', () => ({
  linkedInOutreachService: {
    resolveAccountId: (...args: any[]) => mockResolveAccountId(...args),
    resolveUserOwnedAccountId: (...args: any[]) => mockResolveUserOwnedAccountId(...args),
    sendInvitation: (...args: any[]) => mockSendInvitation(...args),
  },
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

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

const OWNED_LIST = { listId: 'list-123', userId: 'test-user-id' };
const OWNED_LIST_WITH_ACCT = { listId: 'list-123', userId: 'test-user-id', linkedInAccountId: 'list-acct-9' };
const LEAD_WITH_LINKEDIN = {
  leadId: 'lead-456',
  firstName: 'John',
  lastName: 'Doe',
  linkedin: 'https://www.linkedin.com/in/john-doe',
};
const LEAD_WITHOUT_LINKEDIN = { leadId: 'lead-789', linkedin: '' };

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('POST /api/crm/lists/:listId/leads/:leadId/send-linkedin-invite', () => {
  const handler = findHandler(
    router,
    '/lists/:listId/leads/:leadId/send-linkedin-invite',
    'post',
  );

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetLeadListById.mockResolvedValue(OWNED_LIST);
    mockGetLeadById.mockResolvedValue(LEAD_WITH_LINKEDIN);
    mockResolveUserOwnedAccountId.mockResolvedValue('user-own-acct');
    mockResolveAccountId.mockResolvedValue('site-wide-shared-acct');
    mockSendInvitation.mockResolvedValue({ ok: true });
    mockUpdateLead.mockResolvedValue(undefined);
    mockUpsertSentInvitation.mockResolvedValue(undefined);
  });

  it('route is registered', () => {
    expect(handler).toBeTruthy();
  });

  it('returns 401 when no user', async () => {
    const req: any = { user: undefined, params: { listId: 'list-123', leadId: 'lead-456' }, body: {} };
    const res = makeRes();
    await handler!(req, res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('returns 404 when list not found', async () => {
    mockGetLeadListById.mockResolvedValue(null);
    const req: any = { user: { userId: 'test-user-id' }, params: { listId: 'nope', leadId: 'lead-456' }, body: {} };
    const res = makeRes();
    await handler!(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('returns 404 when lead not found', async () => {
    mockGetLeadById.mockResolvedValue(null);
    const req: any = { user: { userId: 'test-user-id' }, params: { listId: 'list-123', leadId: 'lead-456' }, body: {} };
    const res = makeRes();
    await handler!(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('returns 400 when lead has no LinkedIn URL', async () => {
    mockGetLeadById.mockResolvedValue(LEAD_WITHOUT_LINKEDIN);
    const req: any = { user: { userId: 'test-user-id' }, params: { listId: 'list-123', leadId: 'lead-789' }, body: {} };
    const res = makeRes();
    await handler!(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockSendInvitation).not.toHaveBeenCalled();
  });

  it('returns 400 when no LinkedIn sender is configured (no own account, no list account)', async () => {
    mockResolveUserOwnedAccountId.mockResolvedValue(null);
    const req: any = { user: { userId: 'test-user-id' }, params: { listId: 'list-123', leadId: 'lead-456' }, body: {} };
    const res = makeRes();
    await handler!(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockSendInvitation).not.toHaveBeenCalled();
  });

  it('does NOT borrow a site-wide shared account when no sender is configured', async () => {
    mockResolveUserOwnedAccountId.mockResolvedValue(null);
    // resolveAccountId would return a site-wide shared account — the route must not call it.
    const req: any = { user: { userId: 'test-user-id' }, params: { listId: 'list-123', leadId: 'lead-456' }, body: {} };
    const res = makeRes();
    await handler!(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockResolveAccountId).not.toHaveBeenCalled();
    expect(mockSendInvitation).not.toHaveBeenCalled();
  });

  it('uses the list-assigned account when present (not the user default)', async () => {
    mockGetLeadListById.mockResolvedValue(OWNED_LIST_WITH_ACCT);
    const req: any = { user: { userId: 'test-user-id' }, params: { listId: 'list-123', leadId: 'lead-456' }, body: {} };
    const res = makeRes();
    await handler!(req, res);
    expect(mockSendInvitation).toHaveBeenCalledWith('list-acct-9', LEAD_WITH_LINKEDIN.linkedin, true, undefined);
    expect(mockResolveUserOwnedAccountId).not.toHaveBeenCalled();
  });

  it('uses the caller-specified account with highest precedence', async () => {
    mockGetLeadListById.mockResolvedValue(OWNED_LIST_WITH_ACCT);
    const req: any = {
      user: { userId: 'test-user-id' },
      params: { listId: 'list-123', leadId: 'lead-456' },
      body: { accountId: 'caller-acct-1' },
    };
    const res = makeRes();
    await handler!(req, res);
    expect(mockSendInvitation).toHaveBeenCalledWith('caller-acct-1', LEAD_WITH_LINKEDIN.linkedin, true, undefined);
    expect(mockResolveUserOwnedAccountId).not.toHaveBeenCalled();
  });

  it('falls back to the user own account when list has none assigned', async () => {
    const req: any = { user: { userId: 'test-user-id' }, params: { listId: 'list-123', leadId: 'lead-456' }, body: {} };
    const res = makeRes();
    await handler!(req, res);
    expect(mockResolveUserOwnedAccountId).toHaveBeenCalledWith('test-user-id');
    expect(mockSendInvitation).toHaveBeenCalledWith('user-own-acct', LEAD_WITH_LINKEDIN.linkedin, true, undefined);
  });

  it('sends the invite, stamps linkedInInviteSentAt, and returns success on happy path', async () => {
    const req: any = {
      user: { userId: 'test-user-id' },
      params: { listId: 'list-123', leadId: 'lead-456' },
      body: { message: '  Hi John — nice work on X  ' },
    };
    const res = makeRes();
    await handler!(req, res);

    // note is trimmed
    expect(mockSendInvitation).toHaveBeenCalledWith('user-own-acct', LEAD_WITH_LINKEDIN.linkedin, true, 'Hi John — nice work on X');
    expect(mockUpdateLead).toHaveBeenCalledWith('list-123', 'lead-456', expect.objectContaining({
      linkedInInviteSentAt: expect.any(String),
    }));
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });
});
