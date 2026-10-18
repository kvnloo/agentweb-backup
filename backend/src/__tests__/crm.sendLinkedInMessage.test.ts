/**
 * Tests for POST /api/crm/lists/:listId/leads/:leadId/send-linkedin-message
 *
 * Covers:
 *  - 401 when unauthenticated
 *  - 400 when message is empty/missing
 *  - 404 when list not found or not owned by user
 *  - 404 when lead not found
 *  - 400 when lead has no LinkedIn URL
 *  - 400 when no LinkedIn account is connected
 *  - 400 when target is not a 1st-degree connection (Cannot send message:)
 *  - Happy path: message sent and engagement event recorded with non-empty emailId
 *  - emailId fallback: empty messageProviderId must not produce empty-string GSI key
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
const mockGetUserById = jest.fn();
const mockUpdateLead = jest.fn().mockResolvedValue(undefined);
const mockGetOrgById = jest.fn();

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
  orgDb: { getOrgById: (...args: any[]) => mockGetOrgById(...args) },
}));

const mockAddLinkedInMessageEvent = jest.fn();
jest.mock('../services/emailEventsDb', () => ({
  emailEventsDb: {
    addLinkedInMessageEvent: (...args: any[]) => mockAddLinkedInMessageEvent(...args),
  },
}));

const mockResolveAccountId = jest.fn();
const mockSendMessage = jest.fn();
const mockGetLinkedInProfile = jest.fn();

jest.mock('../services/linkedInOutreachService', () => ({
  linkedInOutreachService: {
    resolveAccountId: (...args: any[]) => mockResolveAccountId(...args),
    getLinkedInProfile: (...args: any[]) => mockGetLinkedInProfile(...args),
    sendMessage: (...args: any[]) => mockSendMessage(...args),
  },
}));

const mockSyncConnectionsForAccount = jest.fn();
jest.mock('../cron/linkedInConnectionSyncCron', () => ({
  syncConnectionsForAccount: (...args: any[]) => mockSyncConnectionsForAccount(...args),
}));

const mockResolveLinkedInAccountForWrite = jest.fn().mockResolvedValue({ ownerUserId: 'test-user-id' });
const mockPaceLinkedInWrite = jest.fn().mockResolvedValue({ refusal: null });
jest.mock('../services/agentMode/linkedInDailyVolumeGate', () => ({
  resolveLinkedInAccountForWrite: (...args: any[]) => mockResolveLinkedInAccountForWrite(...args),
  paceLinkedInWrite: (...args: any[]) => mockPaceLinkedInWrite(...args),
}));
const mockReserveWriteSlot = jest.fn().mockResolvedValue({ allowed: true });
jest.mock('../services/linkedInWritePacer', () => ({
  ...jest.requireActual('../services/linkedInWritePacer'),
  reserveWriteSlot: (...args: any[]) => mockReserveWriteSlot(...args),
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
const LEAD_WITH_LINKEDIN = {
  leadId: 'lead-456',
  linkedin: 'https://www.linkedin.com/in/john-doe',
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('POST /api/crm/lists/:listId/leads/:leadId/send-linkedin-message', () => {
  const handler = findHandler(
    router,
    '/lists/:listId/leads/:leadId/send-linkedin-message',
    'post',
  );

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetLeadListById.mockResolvedValue(OWNED_LIST);
    mockGetLeadById.mockResolvedValue(LEAD_WITH_LINKEDIN);
    mockResolveAccountId.mockResolvedValue('unipile-acct-1');
    mockResolveLinkedInAccountForWrite.mockResolvedValue({ ownerUserId: 'test-user-id' });
    mockSendMessage.mockResolvedValue({ id: 'chat-abc' });
    mockAddLinkedInMessageEvent.mockResolvedValue(undefined);
  });

  it('route is registered', () => {
    expect(handler).toBeTruthy();
  });

  it('returns 401 when no user', async () => {
    const req: any = {
      user: undefined,
      params: { listId: 'list-123', leadId: 'lead-456' },
      body: { message: 'Hello!' },
    };
    const res = makeRes();
    await handler!(req, res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('returns 400 when message is missing', async () => {
    const req: any = {
      user: { userId: 'test-user-id' },
      params: { listId: 'list-123', leadId: 'lead-456' },
      body: {},
    };
    const res = makeRes();
    await handler!(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ message: 'message is required' }));
  });

  it('returns 400 when message is whitespace only', async () => {
    const req: any = {
      user: { userId: 'test-user-id' },
      params: { listId: 'list-123', leadId: 'lead-456' },
      body: { message: '   ' },
    };
    const res = makeRes();
    await handler!(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns 404 when list not found', async () => {
    mockGetLeadListById.mockResolvedValue(null);
    const req: any = {
      user: { userId: 'test-user-id' },
      params: { listId: 'nonexistent', leadId: 'lead-456' },
      body: { message: 'Hello!' },
    };
    const res = makeRes();
    await handler!(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('returns 404 when list belongs to another user', async () => {
    mockGetLeadListById.mockResolvedValue({ listId: 'list-123', userId: 'other-user' });
    const req: any = {
      user: { userId: 'test-user-id' },
      params: { listId: 'list-123', leadId: 'lead-456' },
      body: { message: 'Hello!' },
    };
    const res = makeRes();
    await handler!(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('returns 404 when org member is not the list owner and not a CRM editor (ENG-686)', async () => {
    // ENG-686: send-linkedin-message is a destructive write. A plain org member
    // (same org, not the owner, not in crm.editors) is denied. This endpoint
    // deliberately returns 404 (not 403) to avoid leaking list existence.
    mockGetLeadListById.mockResolvedValue({ listId: 'list-123', userId: 'owner-id' });
    mockGetUserById.mockImplementation((id: string) =>
      Promise.resolve(
        id === 'test-user-id'
          ? { userId: 'test-user-id', orgId: 'org-1' }
          : { userId: 'owner-id', orgId: 'org-1' },
      ),
    );
    mockGetOrgById.mockResolvedValue({
      orgId: 'org-1',
      ownerUserId: 'owner-id',
      shareSettings: { crm: { enabled: true, editors: [] } },
    });
    const req: any = {
      user: { userId: 'test-user-id' },
      params: { listId: 'list-123', leadId: 'lead-456' },
      body: { message: 'Hello!' },
    };
    const res = makeRes();
    await handler!(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('returns 404 when lead not found', async () => {
    mockGetLeadById.mockResolvedValue(null);
    const req: any = {
      user: { userId: 'test-user-id' },
      params: { listId: 'list-123', leadId: 'lead-456' },
      body: { message: 'Hello!' },
    };
    const res = makeRes();
    await handler!(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('returns 400 when lead has no LinkedIn URL', async () => {
    mockGetLeadById.mockResolvedValue({ leadId: 'lead-456', linkedin: '' });
    const req: any = {
      user: { userId: 'test-user-id' },
      params: { listId: 'list-123', leadId: 'lead-456' },
      body: { message: 'Hello!' },
    };
    const res = makeRes();
    await handler!(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('LinkedIn URL') }),
    );
  });

  it('returns 400 when no LinkedIn account connected', async () => {
    mockResolveAccountId.mockResolvedValue(null);
    const req: any = {
      user: { userId: 'test-user-id' },
      params: { listId: 'list-123', leadId: 'lead-456' },
      body: { message: 'Hello!' },
    };
    const res = makeRes();
    await handler!(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('No LinkedIn account') }),
    );
  });

  it('returns 400 when target is not a 1st-degree connection', async () => {
    mockSendMessage.mockRejectedValue(
      new Error('Cannot send message: target is not a 1st-degree connection. Use the send-invite action first to connect.'),
    );
    const req: any = {
      user: { userId: 'test-user-id' },
      params: { listId: 'list-123', leadId: 'lead-456' },
      body: { message: 'Hello!' },
    };
    const res = makeRes();
    await handler!(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('Cannot send message:') }),
    );
  });

  // ENG-2205 follow-up: a client-supplied accountId is untrusted (same hole as send-linkedin-invite).
  // Auto-resolution is deliberately UNCHANGED: own account first, then the shared pool for users without one.
  it('auto-resolves exactly as before when no account is supplied (own account, else the shared pool) and skips the ownership check', async () => {
    const res = makeRes();
    await handler!({ user: { userId: 'test-user-id' }, params: { listId: 'list-123', leadId: 'lead-456' }, body: { message: 'Hello!' } } as any, res as any);
    expect(mockResolveAccountId).toHaveBeenCalledWith('test-user-id');
    // ENG-2529: the account is looked up only to pace it — never a 403 on the auto-resolved path.
    expect(res.status).not.toHaveBeenCalledWith(403);
    expect(mockPaceLinkedInWrite).toHaveBeenCalledWith('send-message', expect.anything(), 'unipile-acct-1');
    expect(mockSendMessage).toHaveBeenCalledWith('unipile-acct-1', expect.any(String), true, 'Hello!');
  });

  it('refuses with 429 before any send when the account is at its daily cap (ENG-2529)', async () => {
    mockPaceLinkedInWrite.mockResolvedValueOnce({ refusal: { success: false, message: 'LinkedIn daily volume limit reached', error: 'cap', gate: 'daily_volume' } });
    const res = makeRes();
    await handler!({ user: { userId: 'test-user-id' }, params: { listId: 'list-123', leadId: 'lead-456' }, body: { message: 'hello', accountId: 'li-cap-world' } } as any, res as any);
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ message: 'LinkedIn daily volume limit reached' }));
    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(mockAddLinkedInMessageEvent).not.toHaveBeenCalled();
  });

  it('refuses with 403 and sends nothing when the caller-specified account is not theirs', async () => {
    mockResolveLinkedInAccountForWrite.mockResolvedValue(null);
    const res = makeRes();
    await handler!({ user: { userId: 'test-user-id' }, params: { listId: 'list-123', leadId: 'lead-456' }, body: { message: 'Hello!', accountId: 'someone-elses-acct' } } as any, res as any);
    expect(mockResolveLinkedInAccountForWrite).toHaveBeenCalledWith('test-user-id', 'someone-elses-acct');
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'linkedin_account_not_connected', message: expect.stringContaining('not connected to your user') }));
    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(mockAddLinkedInMessageEvent).not.toHaveBeenCalled();
  });

  it('sends from a caller-specified account the user owns or shares (portal default-account path)', async () => {
    mockResolveLinkedInAccountForWrite.mockResolvedValue({ ownerUserId: 'test-user-id' });
    const res = makeRes();
    await handler!({ user: { userId: 'test-user-id' }, params: { listId: 'list-123', leadId: 'lead-456' }, body: { message: 'Hello!', accountId: 'my-default-acct' } } as any, res as any);
    expect(mockSendMessage).toHaveBeenCalledWith('my-default-acct', 'https://www.linkedin.com/in/john-doe', true, 'Hello!');
    expect(mockResolveAccountId).not.toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  // The message is already out when the engagement is recorded; reporting a failed send would make the user
  // retry and message the lead twice.
  // The message is already out when the engagement is recorded. A transient write failure is retried (keyed put with a
  // fixed eventId, so a retry overwrites rather than duplicates); only a persistent failure is reported, and even then
  // as success, because reporting a failed send would make the user message the lead twice.
  it('recovers from a transient engagement-write failure: retried, recorded once with the SAME event, plain success', async () => {
    mockAddLinkedInMessageEvent
      .mockRejectedValueOnce(new Error('read ECONNRESET'))
      .mockRejectedValueOnce(new Error('read ECONNRESET'))
      .mockResolvedValueOnce(undefined);
    const res = makeRes();
    await handler!({ user: { userId: 'test-user-id' }, params: { listId: 'list-123', leadId: 'lead-456' }, body: { message: 'Hello!' } } as any, res as any);
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    expect(mockAddLinkedInMessageEvent).toHaveBeenCalledTimes(3);
    const ids = new Set(mockAddLinkedInMessageEvent.mock.calls.map((c: any[]) => c[0].eventId));
    const stamps = new Set(mockAddLinkedInMessageEvent.mock.calls.map((c: any[]) => c[0].timestamp));
    expect(ids.size).toBe(1);
    expect(stamps.size).toBe(1);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ success: true });
  });

  it('still reports success (and does not invite a retry) when the engagement write keeps failing AFTER a successful send', async () => {
    mockAddLinkedInMessageEvent.mockRejectedValue(new Error('read ECONNRESET'));
    const res = makeRes();
    await handler!({ user: { userId: 'test-user-id' }, params: { listId: 'list-123', leadId: 'lead-456' }, body: { message: 'Hello!' } } as any, res as any);
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    expect(mockAddLinkedInMessageEvent).toHaveBeenCalledTimes(3); // 1 try + 2 retries, then give up
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ success: true, engagementRecorded: false });
  });

  it('sends message and records engagement on happy path', async () => {
    const req: any = {
      user: { userId: 'test-user-id' },
      params: { listId: 'list-123', leadId: 'lead-456' },
      body: { message: 'Hello, just reaching out!' },
    };
    const res = makeRes();
    await handler!(req, res);

    expect(mockSendMessage).toHaveBeenCalledWith(
      'unipile-acct-1',
      'https://www.linkedin.com/in/john-doe',
      true,
      'Hello, just reaching out!',
    );
    expect(mockAddLinkedInMessageEvent).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ success: true });
  });

  it('emailId in engagement event is never an empty string (GSI key constraint)', async () => {
    // messageProviderId is hardcoded as '' in the route — addLinkedInMessageEvent must
    // fall back to eventId so DynamoDB does not reject the put with a GSI empty-key error.
    const req: any = {
      user: { userId: 'test-user-id' },
      params: { listId: 'list-123', leadId: 'lead-456' },
      body: { message: 'Hello!' },
    };
    const res = makeRes();
    await handler!(req, res);

    expect(mockAddLinkedInMessageEvent).toHaveBeenCalledTimes(1);
    const callArg = mockAddLinkedInMessageEvent.mock.calls[0][0];
    // messageProviderId is '' — the fix in emailEventsDb should use eventId as fallback
    expect(callArg.messageProviderId).toBe('');
    // But the actual stored emailId (computed inside addLinkedInMessageEvent) must be non-empty.
    // We verify the contract by ensuring the route passes a non-empty eventId that can serve as fallback.
    expect(callArg.eventId).toBeTruthy();
    expect(callArg.eventId).not.toBe('');
  });
});

// ─── ENG-1026: identity cross-check before send ──────────────────────────────

describe('send-linkedin-message identity cross-check (ENG-1026)', () => {
  const handler = findHandler(
    router,
    '/lists/:listId/leads/:leadId/send-linkedin-message',
    'post',
  );

  const makeReq = () => ({
    user: { userId: 'test-user-id' },
    params: { listId: 'list-123', leadId: 'lead-456' },
    body: { message: 'Hello!' },
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetLeadListById.mockResolvedValue(OWNED_LIST);
    mockResolveAccountId.mockResolvedValue('unipile-acct-1');
    mockSendMessage.mockResolvedValue({ id: 'chat-abc' });
    mockAddLinkedInMessageEvent.mockResolvedValue(undefined);
  });

  it('refuses with 409 linkedin_identity_mismatch when the profile company mismatches', async () => {
    mockGetLeadById.mockResolvedValue({
      leadId: 'lead-456',
      linkedin: 'https://www.linkedin.com/in/florencesu',
      firstName: 'Florence',
      lastName: 'Su',
      company: 'Vivian Health',
    });
    mockGetLinkedInProfile.mockResolvedValue({
      first_name: 'Florence',
      last_name: 'Su',
      headline: 'Technical Program Manager at Snowflake',
      work_experience: [{ position: 'TPM', company: 'Snowflake', current: true }],
    });

    const res = makeRes();
    await handler!(makeReq() as any, res as any);

    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'linkedin_identity_mismatch',
      details: expect.objectContaining({ leadCompany: 'Vivian Health' }),
    }));
  });

  it('sends and stamps the verified-identity fields on a successful cross-check', async () => {
    mockGetLeadById.mockResolvedValue({
      leadId: 'lead-456',
      linkedin: 'https://www.linkedin.com/in/florencesu',
      firstName: 'Florence',
      lastName: 'Su',
      company: 'Vivian Health',
    });
    mockGetLinkedInProfile.mockResolvedValue({
      first_name: 'Florence',
      last_name: 'Su',
      work_experience: [{ position: 'VP Performance Marketing', company: 'Vivian Health', current: true }],
    });

    const res = makeRes();
    await handler!(makeReq() as any, res as any);

    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    expect(mockUpdateLead).toHaveBeenCalledWith('list-123', 'lead-456', expect.objectContaining({
      linkedinIdentityVerifiedAt: expect.any(String),
      linkedinIdentityVerifiedUrl: expect.stringContaining('/in/florencesu'),
    }));
  });

  it('does not block or fetch when the lead has no company/name data', async () => {
    mockGetLeadById.mockResolvedValue(LEAD_WITH_LINKEDIN);
    const res = makeRes();
    await handler!(makeReq() as any, res as any);
    expect(mockGetLinkedInProfile).not.toHaveBeenCalled();
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    expect(mockUpdateLead).not.toHaveBeenCalled();
  });

  it('fails open when the profile fetch throws', async () => {
    mockGetLeadById.mockResolvedValue({
      leadId: 'lead-456',
      linkedin: 'https://www.linkedin.com/in/florencesu',
      company: 'Vivian Health',
    });
    mockGetLinkedInProfile.mockRejectedValue(new Error('unipile down'));
    const res = makeRes();
    await handler!(makeReq() as any, res as any);
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    expect(mockUpdateLead).not.toHaveBeenCalled();
  });
});


// ENG-2205: resolveAccountId can now return an account whose probe was only
// indeterminate, so the real call below it is the backstop. An infrastructure
// failure there (Unipile credentials / gateway 5xx / timeout) must surface as a
// handled 503 — never a 500 echoing the raw internal message.
describe('LinkedIn routes: infrastructure failures are handled, not raw 500s (ENG-2205)', () => {
  const sendHandler = findHandler(router, '/lists/:listId/leads/:leadId/send-linkedin-message', 'post');
  const syncHandler = findHandler(router, '/lists/:listId/sync-linkedin-connections', 'post');
  const CREDS = new Error('Failed to fetch Unipile credentials from Secrets Manager');
  const GATEWAY = new Error('<html><head><title>502 Bad Gateway</title></head></html>');
  const sendReq = () => ({
    user: { userId: 'test-user-id' },
    params: { listId: 'list-123', leadId: 'lead-456' },
    body: { message: 'Hello!' },
  });
  const syncReq = () => ({ user: { userId: 'test-user-id' }, params: { listId: 'list-123' }, body: {} });

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetLeadListById.mockResolvedValue(OWNED_LIST);
    mockGetLeadById.mockResolvedValue(LEAD_WITH_LINKEDIN);
    mockResolveAccountId.mockResolvedValue('unindeterminate-acct');
    mockGetLinkedInProfile.mockResolvedValue(null);
  });

  it.each([['credentials failure', CREDS], ['gateway 502', GATEWAY]])(
    'send-linkedin-message returns 503 (no raw message, nothing recorded) on %s',
    async (_label, err) => {
      mockSendMessage.mockRejectedValue(err);
      const res = makeRes();
      await sendHandler!(sendReq() as any, res as any);
      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'linkedin_unavailable' }));
      expect(JSON.stringify((res.json as jest.Mock).mock.calls)).not.toMatch(/Secrets Manager|Bad Gateway/);
      expect(mockAddLinkedInMessageEvent).not.toHaveBeenCalled();
    },
  );

  it('send-linkedin-message keeps a plain 500 for a non-infrastructure error', async () => {
    mockSendMessage.mockRejectedValue(new Error('something unrelated broke'));
    const res = makeRes();
    await sendHandler!(sendReq() as any, res as any);
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it.each([['credentials failure', CREDS], ['gateway 502', GATEWAY]])(
    'sync-linkedin-connections returns 503 (no raw message) on %s',
    async (_label, err) => {
      mockSyncConnectionsForAccount.mockRejectedValue(err);
      const res = makeRes();
      await syncHandler!(syncReq() as any, res as any);
      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'linkedin_unavailable' }));
      expect(JSON.stringify((res.json as jest.Mock).mock.calls)).not.toMatch(/Secrets Manager|Bad Gateway/);
    },
  );

  it('sync-linkedin-connections still succeeds and still 400s with no account', async () => {
    mockSyncConnectionsForAccount.mockResolvedValue([1, 2]);
    let res = makeRes();
    await syncHandler!(syncReq() as any, res as any);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ synced: 2 }));
    mockResolveAccountId.mockResolvedValue(null);
    res = makeRes();
    await syncHandler!(syncReq() as any, res as any);
    expect(res.status).toHaveBeenCalledWith(400);
  });
});
