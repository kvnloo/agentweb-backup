/**
 * Tests for POST /api/crm/lists/:listId/leads/:leadId/sync-linkedin-messages
 *
 * Covers:
 *  - 401 when unauthenticated
 *  - 404 when list not found
 *  - 403 when user doesn't own the list
 *  - 400 when lead has no LinkedIn URL
 *  - 400 when no Unipile account is connected
 *  - 400 when lead not found
 *  - Happy path: fetches messages from Unipile and upserts them
 *  - Returns correct sync counts (total synced)
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
const mockUpdateLeadLinkedInSyncAt = jest.fn();

jest.mock('../services/db', () => ({
  crmDb: {
    getLeadListById: (...args: any[]) => mockGetLeadListById(...args),
    getLeadById: (...args: any[]) => mockGetLeadById(...args),
    updateLeadLinkedInSyncAt: (...args: any[]) => mockUpdateLeadLinkedInSyncAt(...args),
    getLeadsByListId: jest.fn().mockResolvedValue({ leads: [] }),
  },
  taskDb: { getTaskById: jest.fn() },
  subscriberDb: { getAllTaskSubscribers: jest.fn() },
  userDb: { getUserById: jest.fn() },
}));

const mockAddLinkedInMessageEvent = jest.fn();
jest.mock('../services/emailEventsDb', () => ({
  emailEventsDb: {
    addLinkedInMessageEvent: (...args: any[]) => mockAddLinkedInMessageEvent(...args),
  },
}));

const mockResolveAccountId = jest.fn();
const mockGetMessagesWithContact = jest.fn();
const mockResolveProviderId = jest.fn();

jest.mock('../services/linkedInOutreachService', () => ({
  linkedInOutreachService: {
    resolveAccountId: (...args: any[]) => mockResolveAccountId(...args),
    getMessagesWithContact: (...args: any[]) => mockGetMessagesWithContact(...args),
    resolveProviderId: (...args: any[]) => mockResolveProviderId(...args),
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
const LEAD_WITHOUT_LINKEDIN = {
  leadId: 'lead-789',
  linkedin: '',
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('POST /api/crm/lists/:listId/leads/:leadId/sync-linkedin-messages', () => {
  const handler = findHandler(
    router,
    '/lists/:listId/leads/:leadId/sync-linkedin-messages',
    'post',
  );

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetLeadListById.mockResolvedValue(OWNED_LIST);
    mockGetLeadById.mockResolvedValue(LEAD_WITH_LINKEDIN);
    mockResolveAccountId.mockResolvedValue('unipile-acct-1');
    mockResolveProviderId.mockResolvedValue('provider-id-1');
    mockGetMessagesWithContact.mockResolvedValue([]);
    mockAddLinkedInMessageEvent.mockResolvedValue(undefined);
    mockUpdateLeadLinkedInSyncAt.mockResolvedValue(undefined);
  });

  it('route is registered', () => {
    expect(handler).toBeTruthy();
  });

  it('returns 401 when no user', async () => {
    const req: any = {
      user: undefined,
      params: { listId: 'list-123', leadId: 'lead-456' },
    };
    const res = makeRes();
    await handler!(req, res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('returns 404 when list not found', async () => {
    mockGetLeadListById.mockResolvedValue(null);
    const req: any = {
      user: { userId: 'test-user-id' },
      params: { listId: 'nonexistent', leadId: 'lead-456' },
    };
    const res = makeRes();
    await handler!(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('returns 403 when user does not own the list', async () => {
    mockGetLeadListById.mockResolvedValue({ listId: 'list-123', userId: 'other-user' });
    const req: any = {
      user: { userId: 'test-user-id' },
      params: { listId: 'list-123', leadId: 'lead-456' },
    };
    const res = makeRes();
    await handler!(req, res);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('returns 404 when lead not found', async () => {
    mockGetLeadById.mockResolvedValue(null);
    const req: any = {
      user: { userId: 'test-user-id' },
      params: { listId: 'list-123', leadId: 'lead-456' },
    };
    const res = makeRes();
    await handler!(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('returns 400 when lead has no LinkedIn URL', async () => {
    mockGetLeadById.mockResolvedValue(LEAD_WITHOUT_LINKEDIN);
    const req: any = {
      user: { userId: 'test-user-id' },
      params: { listId: 'list-123', leadId: 'lead-789' },
    };
    const res = makeRes();
    await handler!(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns 400 when no Unipile account is connected', async () => {
    mockResolveAccountId.mockResolvedValue(null);
    const req: any = {
      user: { userId: 'test-user-id' },
      params: { listId: 'list-123', leadId: 'lead-456' },
    };
    const res = makeRes();
    await handler!(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('syncs messages and returns count on happy path', async () => {
    const messages = [
      { id: 'msg-1', provider_id: 'p1', text: 'Hello!', is_sender: 1 as const, is_event: 0 as const, sender_id: 'unipile-acct-1', timestamp: '2026-01-01T10:00:00.000Z' },
      { id: 'msg-2', provider_id: 'p2', text: 'Hi there!', is_sender: 0 as const, is_event: 0 as const, sender_id: 'provider-id-1', timestamp: '2026-01-01T10:05:00.000Z' },
      { id: 'msg-3', provider_id: 'p3', text: 'Sounds great', is_sender: 0 as const, is_event: 0 as const, sender_id: 'provider-id-1', timestamp: '2026-01-01T10:10:00.000Z' },
    ];
    mockGetMessagesWithContact.mockResolvedValue(messages);

    const req: any = {
      user: { userId: 'test-user-id' },
      params: { listId: 'list-123', leadId: 'lead-456' },
    };
    const res = makeRes();
    await handler!(req, res);

    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ synced: 3 }),
    );
  });

  it('upserts both sent and received messages with correct eventType', async () => {
    const messages = [
      { id: 'msg-1', provider_id: 'p1', text: 'Hello!', is_sender: 1 as const, is_event: 0 as const, sender_id: 'acct', timestamp: '2026-01-01T10:00:00.000Z' },
      { id: 'msg-2', provider_id: 'p2', text: 'Thanks!', is_sender: 0 as const, is_event: 0 as const, sender_id: 'lead', timestamp: '2026-01-01T10:05:00.000Z' },
    ];
    mockGetMessagesWithContact.mockResolvedValue(messages);

    const req: any = {
      user: { userId: 'test-user-id' },
      params: { listId: 'list-123', leadId: 'lead-456' },
    };
    const res = makeRes();
    await handler!(req, res);

    expect(mockAddLinkedInMessageEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: 'linkedin_msg_msg-1', eventType: 'linkedin.message.sent' }),
    );
    expect(mockAddLinkedInMessageEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: 'linkedin_msg_msg-2', eventType: 'linkedin.message.received' }),
    );
  });

  it('updates the linkedinMessageSyncAt timestamp after sync', async () => {
    mockGetMessagesWithContact.mockResolvedValue([]);

    const req: any = {
      user: { userId: 'test-user-id' },
      params: { listId: 'list-123', leadId: 'lead-456' },
    };
    const res = makeRes();
    await handler!(req, res);

    expect(mockUpdateLeadLinkedInSyncAt).toHaveBeenCalledWith(
      'list-123',
      'lead-456',
      expect.any(String),
    );
  });

  it('resolves provider ID using lead LinkedIn URL', async () => {
    mockGetMessagesWithContact.mockResolvedValue([]);

    const req: any = {
      user: { userId: 'test-user-id' },
      params: { listId: 'list-123', leadId: 'lead-456' },
    };
    const res = makeRes();
    await handler!(req, res);

    expect(mockResolveProviderId).toHaveBeenCalledWith(
      LEAD_WITH_LINKEDIN.linkedin.toLowerCase(),
      true,
      'unipile-acct-1',
    );
    expect(mockGetMessagesWithContact).toHaveBeenCalledWith('provider-id-1');
  });
});
