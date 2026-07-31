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
const mockFindLeadByLinkedinInList = jest.fn();
const mockAddLeadEngagement = jest.fn();

jest.mock('../services/db', () => ({
  crmDb: {
    getLeadListById: (...args: any[]) => mockGetLeadListById(...args),
    getLeadById: (...args: any[]) => mockGetLeadById(...args),
    updateLead: (...args: any[]) => mockUpdateLead(...args),
    getLeadsByListId: jest.fn().mockResolvedValue({ leads: [] }),
    // ENG-787: the route mirrors the invite into the CRM. Without these the mirror
    // throws and the route silently takes its timestamp-only fallback, so every
    // assertion below would pass even with the mirror broken.
    findLeadByLinkedinInList: (...args: any[]) => mockFindLeadByLinkedinInList(...args),
    addLeadEngagement: (...args: any[]) => mockAddLeadEngagement(...args),
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
const mockGetInviteCharLimitForAccount = jest.fn();

jest.mock('../services/linkedInOutreachService', () => ({
  linkedInOutreachService: {
    resolveAccountId: (...args: any[]) => mockResolveAccountId(...args),
    resolveUserOwnedAccountId: (...args: any[]) => mockResolveUserOwnedAccountId(...args),
    sendInvitation: (...args: any[]) => mockSendInvitation(...args),
    getInviteCharLimitForAccount: (...args: any[]) => mockGetInviteCharLimitForAccount(...args),
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
    mockGetInviteCharLimitForAccount.mockResolvedValue(200);
    mockSendInvitation.mockResolvedValue({ ok: true });
    mockUpdateLead.mockResolvedValue(undefined);
    mockUpsertSentInvitation.mockResolvedValue(undefined);
    mockFindLeadByLinkedinInList.mockResolvedValue(null);
    mockAddLeadEngagement.mockResolvedValue(undefined);
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
    expect(mockSendInvitation).toHaveBeenCalledWith('list-acct-9', LEAD_WITH_LINKEDIN.linkedin, true, undefined, 200, { onNoteQuota: 'skip' });
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
    expect(mockSendInvitation).toHaveBeenCalledWith('caller-acct-1', LEAD_WITH_LINKEDIN.linkedin, true, undefined, 200, { onNoteQuota: 'skip' });
    expect(mockResolveUserOwnedAccountId).not.toHaveBeenCalled();
  });

  it('falls back to the user own account when list has none assigned', async () => {
    const req: any = { user: { userId: 'test-user-id' }, params: { listId: 'list-123', leadId: 'lead-456' }, body: {} };
    const res = makeRes();
    await handler!(req, res);
    expect(mockResolveUserOwnedAccountId).toHaveBeenCalledWith('test-user-id');
    expect(mockSendInvitation).toHaveBeenCalledWith('user-own-acct', LEAD_WITH_LINKEDIN.linkedin, true, undefined, 200, { onNoteQuota: 'skip' });
  });

  it('sends the invite, stamps linkedInInviteSentAt, and returns success on happy path', async () => {
    const req: any = {
      user: { userId: 'test-user-id' },
      params: { listId: 'list-123', leadId: 'lead-456' },
      body: { message: '  Hi John — nice work on X  ' },
    };
    const res = makeRes();
    await handler!(req, res);

    // note is trimmed; free-account limit (200) is passed through
    expect(mockSendInvitation).toHaveBeenCalledWith('user-own-acct', LEAD_WITH_LINKEDIN.linkedin, true, 'Hi John — nice work on X', 200, { onNoteQuota: 'skip' });
    expect(mockUpdateLead).toHaveBeenCalledWith('list-123', 'lead-456', expect.objectContaining({
      linkedInInviteSentAt: expect.any(String),
    }));
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  it('passes the Premium char limit (300) through to sendInvitation for a Premium account', async () => {
    mockGetInviteCharLimitForAccount.mockResolvedValue(300);
    const req: any = {
      user: { userId: 'test-user-id' },
      params: { listId: 'list-123', leadId: 'lead-456' },
      body: { message: 'hello' },
    };
    const res = makeRes();
    await handler!(req, res);
    expect(mockGetInviteCharLimitForAccount).toHaveBeenCalledWith('test-user-id', 'user-own-acct');
    expect(mockSendInvitation).toHaveBeenCalledWith('user-own-acct', LEAD_WITH_LINKEDIN.linkedin, true, 'hello', 300, { onNoteQuota: 'skip' });
  });

  // ─── Note-quota hold / decision gate (ENG-213) ───────────────────────────────

  it('holds (does not send) and returns a decision gate when the note quota is spent', async () => {
    const held: any = new Error('LinkedIn note quota reached — the personalized note could not be attached.');
    held.noteQuotaExceeded = true;
    mockSendInvitation.mockRejectedValue(held);
    const req: any = {
      user: { userId: 'test-user-id' },
      params: { listId: 'list-123', leadId: 'lead-456' },
      body: { message: 'A deliberately personalised note' },
    };
    const res = makeRes();
    await handler!(req, res);

    // Default policy is 'skip' — the invite is HELD, not sent note-less.
    expect(mockSendInvitation).toHaveBeenCalledWith(
      'user-own-acct', LEAD_WITH_LINKEDIN.linkedin, true, 'A deliberately personalised note', 200, { onNoteQuota: 'skip' },
    );
    // Gate returned to the UI so it can ask "send without note / cancel".
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: false, noteQuotaExceeded: true }));
    // The lead is NOT marked invited and nothing is cached — nothing was sent.
    expect(mockUpdateLead).not.toHaveBeenCalled();
    expect(mockUpsertSentInvitation).not.toHaveBeenCalled();
  });

  it("sends note-less when the customer authorizes it via on_note_quota='send_without_note'", async () => {
    mockSendInvitation.mockResolvedValue({ note_dropped: true });
    const req: any = {
      user: { userId: 'test-user-id' },
      params: { listId: 'list-123', leadId: 'lead-456' },
      body: { message: 'A personalised note', on_note_quota: 'send_without_note' },
    };
    const res = makeRes();
    await handler!(req, res);

    expect(mockSendInvitation).toHaveBeenCalledWith(
      'user-own-acct', LEAD_WITH_LINKEDIN.linkedin, true, 'A personalised note', 200, { onNoteQuota: 'send_without_note' },
    );
    // Sent (note dropped) — the lead is stamped and the response flags noteDropped.
    expect(mockUpdateLead).toHaveBeenCalledWith('list-123', 'lead-456', expect.objectContaining({
      linkedInInviteSentAt: expect.any(String),
    }));
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, noteDropped: true }));
    // The dropped note must NOT be cached as if it were delivered.
    expect(mockUpsertSentInvitation).toHaveBeenCalledWith(expect.objectContaining({ invitationText: '' }));
  });

  // ENG-787: the manual button must mirror into the CRM, not just stamp a timestamp.
  it('logs a linkedin.invite.sent engagement and marks the lead contacted', async () => {
    const req: any = {
      user: { userId: 'test-user-id' },
      params: { listId: 'list-123', leadId: 'lead-456' },
      body: { message: 'Hi John' },
    };
    const res = makeRes();
    await handler!(req, res);

    expect(mockAddLeadEngagement).toHaveBeenCalledWith('list-123', 'lead-456', expect.objectContaining({
      eventType: 'linkedin.invite.sent',
      eventData: expect.objectContaining({
        note: 'Hi John',
        linkedin: LEAD_WITH_LINKEDIN.linkedin,
      }),
    }));
    expect(mockUpdateLead).toHaveBeenCalledWith('list-123', 'lead-456', expect.objectContaining({
      status: 'contacted',
      linkedInInviteSentAt: expect.any(String),
    }));
  });
});
