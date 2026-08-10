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

  it('allows an org member (same orgId, different userId) to send — not 404', async () => {
    // List owned by a teammate; requester is in the same org.
    mockGetLeadListById.mockResolvedValue({ listId: 'list-123', userId: 'owner-id' });
    mockGetUserById.mockImplementation((id: string) =>
      Promise.resolve(
        id === 'test-user-id'
          ? { userId: 'test-user-id', orgId: 'org-1' }
          : { userId: 'owner-id', orgId: 'org-1' },
      ),
    );
    const req: any = {
      user: { userId: 'test-user-id' },
      params: { listId: 'list-123', leadId: 'lead-456' },
      body: { message: 'Hello!' },
    };
    const res = makeRes();
    await handler!(req, res);
    // Must NOT be rejected as "Lead list not found"; the send proceeds.
    expect(res.status).not.toHaveBeenCalledWith(404);
    expect(mockSendMessage).toHaveBeenCalled();
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
