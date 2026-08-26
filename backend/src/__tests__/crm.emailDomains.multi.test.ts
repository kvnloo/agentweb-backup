// ENG-265: unit tests for the new plural /api/crm/email-domains endpoints
// (multi-domain support). Modeled on the existing crm.emailDomain.test.ts
// conventions for the singular endpoints, which stay untouched/unmigrated.

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

import { Request, Response } from 'express';
import { userDb } from '../services/db';
import { resendService } from '../services/resendService';
import router from '../routes/crm';

jest.mock('../services/db', () => ({
  crmDb: {
    getLeadListsByUserId: jest.fn(),
    createLeadList: jest.fn(),
    getLeadListById: jest.fn(),
    updateLeadList: jest.fn(),
    deleteLeadList: jest.fn(),
    getLeadsByListId: jest.fn(),
    getLeadsByICPFlag: jest.fn(),
    getLeadsByEngagedFlag: jest.fn(),
    getLeadsByStatus: jest.fn(),
    createLead: jest.fn(),
    getLeadById: jest.fn(),
    updateLead: jest.fn(),
    deleteLead: jest.fn(),
    batchCreateLeads: jest.fn(),
    getLeadEngagements: jest.fn(),
    addLeadEngagement: jest.fn(),
    updateLeadEngagement: jest.fn(),
    deleteLeadEngagement: jest.fn(),
    getLeadEngagementCount: jest.fn(),
  },
  taskDb: { getTaskById: jest.fn() },
  subscriberDb: { getAllTaskSubscribers: jest.fn() },
  userDb: {
    getUserById: jest.fn(),
    getUsersByEmailDomain: jest.fn(),
    updateUser: jest.fn(),
  },
}));

jest.mock('../services/emailEventsDb', () => ({
  emailEventsDb: {
    getEventsByEmailDomain: jest.fn(),
    getEventsByEmailDomainAndLeadEmail: jest.fn(),
  },
}));

jest.mock('../services/agentModeService', () => ({
  agentModeService: { searchWeb: jest.fn() },
}));

jest.mock('../utils/llmService', () => ({ createLLMService: jest.fn() }));

jest.mock('../services/settingsService', () => ({
  settingsService: { getSetting: jest.fn(), setSetting: jest.fn() },
}));

jest.mock('../services/resendService', () => ({
  resendService: {
    sendEmail: jest.fn(),
    createDomain: jest.fn(),
    getDomain: jest.fn(),
    verifyDomain: jest.fn(),
    listDomains: jest.fn(),
  },
}));

jest.mock('../utils/s3Utils', () => ({ uploadFileToS3: jest.fn() }));

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, res: any, next: any) => {
    req.user = { userId: 'test-user-id', email: 'test@example.com' };
    next();
  },
  AuthenticatedRequest: {},
}));

jest.mock('../services/leadListAlertService', () => ({
  leadListAlertService: { processEmailReceivedEvent: jest.fn() },
}));

jest.mock('../utils/emailVariables', () => ({
  substituteVariables: jest.fn(),
  extractVariables: jest.fn(),
  leadHasVariable: jest.fn(),
}));

jest.mock('../config/aws', () => ({
  dynamodb: { query: jest.fn().mockReturnValue({ promise: jest.fn() }) },
}));

jest.mock('../utils/leadContactStatus', () => ({
  isDoNotContact: jest.fn().mockReturnValue(false),
}));

function getHandler(path: string, method: string) {
  const layer = router.stack.find((r: any) => r.route?.path === path && r.route?.methods?.[method]);
  if (!layer || !layer.route) throw new Error(`Route ${method.toUpperCase()} ${path} not found`);
  return layer.route.stack[0].handle;
}

describe('CRM multi-domain endpoints (ENG-265)', () => {
  let mockRequest: Partial<Request>;
  let mockResponse: Partial<Response>;
  let mockNext: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockRequest = { user: { userId: 'test-user-id', email: 'test@example.com' }, params: {}, query: {}, body: {} };
    mockResponse = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
    mockNext = jest.fn();
  });

  describe('POST /email-domains', () => {
    it('rejects a domain that collides with another account (data-integrity invariant)', async () => {
      mockRequest.body = { domain: 'taken.com' };
      (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'test-user-id', emailDomains: [] });
      (userDb.getUsersByEmailDomain as jest.Mock).mockResolvedValue([
        { userId: 'other-user-id', emailDomains: [{ id: 'd1', domain: 'taken.com', status: 'verified', addedAt: '2026-01-01T00:00:00.000Z' }] },
      ]);

      const handle = getHandler('/email-domains', 'post');
      await handle(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockResponse.status).toHaveBeenCalledWith(409);
      expect(mockResponse.json).toHaveBeenCalledWith({ message: 'This domain is already in use by another account' });
      expect(resendService.createDomain).not.toHaveBeenCalled();
    });

    it('rejects re-adding a domain the same user already registered, without hitting Resend again', async () => {
      const existing = { id: 'd1', domain: 'mine.com', status: 'verified', addedAt: '2026-01-01T00:00:00.000Z' };
      mockRequest.body = { domain: 'mine.com' };
      (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'test-user-id', emailDomains: [existing] });

      const handle = getHandler('/email-domains', 'post');
      await handle(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockResponse.status).toHaveBeenCalledWith(409);
      expect(userDb.getUsersByEmailDomain).not.toHaveBeenCalled();
      expect(resendService.createDomain).not.toHaveBeenCalled();
    });

    it('appends a second domain to an existing array rather than overwriting it', async () => {
      const first = { id: 'd1', domain: 'first.com', status: 'verified', addedAt: '2026-01-01T00:00:00.000Z' };
      mockRequest.body = { domain: 'second.com' };
      (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'test-user-id', emailDomains: [first] });
      (userDb.getUsersByEmailDomain as jest.Mock).mockResolvedValue([]);
      (resendService.listDomains as jest.Mock).mockResolvedValue([]);
      (resendService.createDomain as jest.Mock).mockResolvedValue({
        id: 'd2', name: 'second.com', status: 'not_started', records: [],
      });
      (userDb.updateUser as jest.Mock).mockResolvedValue({});

      const handle = getHandler('/email-domains', 'post');
      await handle(mockRequest as Request, mockResponse as Response, mockNext);

      expect(userDb.updateUser).toHaveBeenCalledWith('test-user-id', {
        emailDomains: [first, { id: 'd2', domain: 'second.com', status: 'not_started', addedAt: expect.any(String) }],
        emailDomainList: ['first.com', 'second.com'],
      }, {
        condition: {
          expression: 'size(#emailDomains) = :expectedSize',
          names: { '#emailDomains': 'emailDomains' },
          values: { ':expectedSize': 1 },
        },
      });
      expect(mockResponse.json).toHaveBeenCalled();
    });

    it('retries once against a fresh read when a concurrent write races the conditional check', async () => {
      const first = { id: 'd1', domain: 'first.com', status: 'verified', addedAt: '2026-01-01T00:00:00.000Z' };
      const racedIn = { id: 'd-raced', domain: 'raced.com', status: 'verified', addedAt: '2026-01-01T00:00:01.000Z' };
      mockRequest.body = { domain: 'second.com' };
      (userDb.getUserById as jest.Mock)
        .mockResolvedValueOnce({ userId: 'test-user-id', emailDomains: [first] })
        .mockResolvedValueOnce({ userId: 'test-user-id', emailDomains: [first, racedIn] });
      (userDb.getUsersByEmailDomain as jest.Mock).mockResolvedValue([]);
      (resendService.listDomains as jest.Mock).mockResolvedValue([]);
      (resendService.createDomain as jest.Mock).mockResolvedValue({
        id: 'd2', name: 'second.com', status: 'not_started', records: [],
      });
      (userDb.updateUser as jest.Mock)
        .mockRejectedValueOnce({ code: 'ConditionalCheckFailedException' })
        .mockResolvedValueOnce({});

      const handle = getHandler('/email-domains', 'post');
      await handle(mockRequest as Request, mockResponse as Response, mockNext);

      expect(userDb.updateUser).toHaveBeenCalledTimes(2);
      expect(userDb.updateUser).toHaveBeenLastCalledWith('test-user-id', {
        emailDomains: [first, racedIn, { id: 'd2', domain: 'second.com', status: 'not_started', addedAt: expect.any(String) }],
        emailDomainList: ['first.com', 'raced.com', 'second.com'],
      }, {
        condition: {
          expression: 'size(#emailDomains) = :expectedSize',
          names: { '#emailDomains': 'emailDomains' },
          values: { ':expectedSize': 2 },
        },
      });
      expect(mockResponse.json).toHaveBeenCalled();
    });

    it('returns 400 for invalid domain format', async () => {
      mockRequest.body = { domain: 'not a domain' };
      const handle = getHandler('/email-domains', 'post');
      await handle(mockRequest as Request, mockResponse as Response, mockNext);
      expect(mockResponse.status).toHaveBeenCalledWith(400);
    });

    it('re-checks the cap against the fresh read on a retry, not just the value from the top of the request (CodeRabbit)', async () => {
      // 19 real domains at the top of the request — under the 20 cap — but a concurrent
      // request landed the 20th between the read and the write, so the retry's fresh read
      // shows 20. Appending a 21st on top of that must be rejected, not silently allowed.
      const nineteen = Array.from({ length: 19 }, (_, i) => ({
        id: `d${i}`, domain: `d${i}.com`, status: 'verified', addedAt: '2026-01-01T00:00:00.000Z',
      }));
      const twenty = [...nineteen, { id: 'd19', domain: 'd19.com', status: 'verified', addedAt: '2026-01-01T00:00:01.000Z' }];
      mockRequest.body = { domain: 'onemore.com' };
      (userDb.getUserById as jest.Mock)
        .mockResolvedValueOnce({ userId: 'test-user-id', emailDomains: nineteen })
        .mockResolvedValueOnce({ userId: 'test-user-id', emailDomains: twenty });
      (userDb.getUsersByEmailDomain as jest.Mock).mockResolvedValue([]);
      (resendService.listDomains as jest.Mock).mockResolvedValue([]);
      (resendService.createDomain as jest.Mock).mockResolvedValue({
        id: 'd-new', name: 'onemore.com', status: 'not_started', records: [],
      });
      (userDb.updateUser as jest.Mock).mockRejectedValueOnce({ code: 'ConditionalCheckFailedException' });

      const handle = getHandler('/email-domains', 'post');
      await handle(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockResponse.status).toHaveBeenCalledWith(400);
      expect(mockResponse.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'EMAIL_DOMAIN_CAP_EXCEEDED' }));
      // Only the one failed conditional write — no second write is attempted once the
      // re-checked cap rejects the retry.
      expect(userDb.updateUser).toHaveBeenCalledTimes(1);
    });

    it('counts the legacy scalar domain too when re-checking the cap on a retry (CodeRabbit)', async () => {
      // 18 stored + 1 legacy scalar domain = 19 effective, under the cap — but a concurrent
      // request pushes the stored array to 19 real entries (still 20 effective with the
      // legacy one) before the retry's fresh read. Appending a 21st effective domain on top
      // must be rejected — a check against the fresh STORED count alone (19) would wrongly
      // allow it.
      const eighteen = Array.from({ length: 18 }, (_, i) => ({
        id: `d${i}`, domain: `d${i}.com`, status: 'verified', addedAt: '2026-01-01T00:00:00.000Z',
      }));
      const nineteenStored = [...eighteen, { id: 'd18', domain: 'd18.com', status: 'verified', addedAt: '2026-01-01T00:00:01.000Z' }];
      mockRequest.body = { domain: 'onemore.com' };
      (userDb.getUserById as jest.Mock)
        .mockResolvedValueOnce({ userId: 'test-user-id', emailDomains: eighteen, emailDomain: 'legacy.com', resendDomainId: 'legacy-id' })
        .mockResolvedValueOnce({ userId: 'test-user-id', emailDomains: nineteenStored, emailDomain: 'legacy.com', resendDomainId: 'legacy-id' });
      (userDb.getUsersByEmailDomain as jest.Mock).mockResolvedValue([]);
      (resendService.listDomains as jest.Mock).mockResolvedValue([]);
      (resendService.createDomain as jest.Mock).mockResolvedValue({
        id: 'd-new', name: 'onemore.com', status: 'not_started', records: [],
      });
      (userDb.updateUser as jest.Mock).mockRejectedValueOnce({ code: 'ConditionalCheckFailedException' });

      const handle = getHandler('/email-domains', 'post');
      await handle(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockResponse.status).toHaveBeenCalledWith(400);
      expect(mockResponse.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'EMAIL_DOMAIN_CAP_EXCEEDED' }));
      expect(userDb.updateUser).toHaveBeenCalledTimes(1);
    });

    it('counts a legacy scalar-only domain toward the cap/duplicate check without breaking the CAS write (CodeRabbit)', async () => {
      // A user who registered before ENG-265 has emailDomain/resendDomainId set but no
      // emailDomains[] array at all — the new domain being added is still distinct, so this
      // should succeed, and critically the conditional write must be keyed off the REAL
      // (empty) array, not a count that silently includes the synthesized legacy entry.
      mockRequest.body = { domain: 'second.com' };
      (userDb.getUserById as jest.Mock).mockResolvedValue({
        userId: 'test-user-id', emailDomain: 'legacy.com', resendDomainId: 'legacy-id',
      });
      (userDb.getUsersByEmailDomain as jest.Mock).mockResolvedValue([]);
      (resendService.listDomains as jest.Mock).mockResolvedValue([]);
      (resendService.createDomain as jest.Mock).mockResolvedValue({
        id: 'd2', name: 'second.com', status: 'not_started', records: [],
      });
      (userDb.updateUser as jest.Mock).mockResolvedValue({});

      const handle = getHandler('/email-domains', 'post');
      await handle(mockRequest as Request, mockResponse as Response, mockNext);

      expect(userDb.updateUser).toHaveBeenCalledWith('test-user-id', {
        emailDomains: [{ id: 'd2', domain: 'second.com', status: 'not_started', addedAt: expect.any(String) }],
        emailDomainList: ['second.com'],
      }, {
        condition: {
          expression: 'attribute_not_exists(#emailDomains) OR size(#emailDomains) = :expectedSize',
          names: { '#emailDomains': 'emailDomains' },
          values: { ':expectedSize': 0 },
        },
      });
    });

    it('rejects re-registering the legacy scalar domain itself as a spurious "new" domain', async () => {
      mockRequest.body = { domain: 'legacy.com' };
      (userDb.getUserById as jest.Mock).mockResolvedValue({
        userId: 'test-user-id', emailDomain: 'legacy.com', resendDomainId: 'legacy-id',
      });

      const handle = getHandler('/email-domains', 'post');
      await handle(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockResponse.status).toHaveBeenCalledWith(409);
      expect(resendService.createDomain).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /email-domains/:domainId', () => {
    it('removes only the targeted domain, leaving others intact', async () => {
      const keep = { id: 'keep', domain: 'keep.com', status: 'verified', addedAt: '2026-01-01T00:00:00.000Z' };
      const remove = { id: 'remove', domain: 'remove.com', status: 'verified', addedAt: '2026-01-02T00:00:00.000Z' };
      mockRequest.params = { domainId: 'remove' };
      (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'test-user-id', emailDomains: [keep, remove] });
      (userDb.updateUser as jest.Mock).mockResolvedValue({});

      const handle = getHandler('/email-domains/:domainId', 'delete');
      await handle(mockRequest as Request, mockResponse as Response, mockNext);

      expect(userDb.updateUser).toHaveBeenCalledWith('test-user-id', {
        emailDomains: [keep],
        emailDomainList: ['keep.com'],
      }, {
        condition: {
          expression: 'size(#emailDomains) = :expectedSize',
          names: { '#emailDomains': 'emailDomains' },
          values: { ':expectedSize': 2 },
        },
      });
    });

    it('short-circuits on a race if the fresh read shows the domain was already removed', async () => {
      const keep = { id: 'keep', domain: 'keep.com', status: 'verified', addedAt: '2026-01-01T00:00:00.000Z' };
      const remove = { id: 'remove', domain: 'remove.com', status: 'verified', addedAt: '2026-01-02T00:00:00.000Z' };
      mockRequest.params = { domainId: 'remove' };
      (userDb.getUserById as jest.Mock)
        .mockResolvedValueOnce({ userId: 'test-user-id', emailDomains: [keep, remove] })
        .mockResolvedValueOnce({ userId: 'test-user-id', emailDomains: [keep] });
      (userDb.updateUser as jest.Mock)
        .mockRejectedValueOnce({ code: 'ConditionalCheckFailedException' });

      const handle = getHandler('/email-domains/:domainId', 'delete');
      await handle(mockRequest as Request, mockResponse as Response, mockNext);

      expect(userDb.updateUser).toHaveBeenCalledTimes(1);
      expect(mockResponse.json).toHaveBeenCalledWith({ message: 'Domain removed.' });
    });

    it('returns 404 for an unknown domainId', async () => {
      mockRequest.params = { domainId: 'nope' };
      (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'test-user-id', emailDomains: [] });

      const handle = getHandler('/email-domains/:domainId', 'delete');
      await handle(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockResponse.status).toHaveBeenCalledWith(404);
      expect(userDb.updateUser).not.toHaveBeenCalled();
    });

    it('removes a legacy scalar-only domain by clearing the scalar fields, not by filtering the (nonexistent) array (CodeRabbit)', async () => {
      mockRequest.params = { domainId: 'legacy-id' };
      (userDb.getUserById as jest.Mock).mockResolvedValue({
        userId: 'test-user-id', emailDomain: 'legacy.com', resendDomainId: 'legacy-id',
      });
      (userDb.updateUser as jest.Mock).mockResolvedValue({});

      const handle = getHandler('/email-domains/:domainId', 'delete');
      await handle(mockRequest as Request, mockResponse as Response, mockNext);

      expect(userDb.updateUser).toHaveBeenCalledWith('test-user-id', { emailDomain: '', resendDomainId: '' });
      expect(mockResponse.json).toHaveBeenCalledWith({ message: 'Domain removed.' });
    });
  });

  describe('POST /email-domains/:domainId/verify', () => {
    it('returns 404 when the domainId does not belong to the user', async () => {
      mockRequest.params = { domainId: 'nope' };
      (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'test-user-id', emailDomains: [] });

      const handle = getHandler('/email-domains/:domainId/verify', 'post');
      await handle(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockResponse.status).toHaveBeenCalledWith(404);
      expect(resendService.verifyDomain).not.toHaveBeenCalled();
    });

    it('verifies the targeted domain by id', async () => {
      const entry = { id: 'd1', domain: 'mine.com', status: 'pending', addedAt: '2026-01-01T00:00:00.000Z' };
      mockRequest.params = { domainId: 'd1' };
      (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'test-user-id', emailDomains: [entry] });
      (resendService.verifyDomain as jest.Mock).mockResolvedValue(true);
      (resendService.getDomain as jest.Mock).mockResolvedValue({ id: 'd1', name: 'mine.com', status: 'verified', records: [] });

      const handle = getHandler('/email-domains/:domainId/verify', 'post');
      await handle(mockRequest as Request, mockResponse as Response, mockNext);

      expect(resendService.verifyDomain).toHaveBeenCalledWith('d1');
      const jsonCall = (mockResponse.json as jest.Mock).mock.calls[0][0];
      expect(jsonCall.domain.status).toBe('verified');
    });

    it('verifies a legacy scalar-only domain too (CodeRabbit)', async () => {
      mockRequest.params = { domainId: 'legacy-id' };
      (userDb.getUserById as jest.Mock).mockResolvedValue({
        userId: 'test-user-id', emailDomain: 'legacy.com', resendDomainId: 'legacy-id',
      });
      (resendService.verifyDomain as jest.Mock).mockResolvedValue(true);
      (resendService.getDomain as jest.Mock).mockResolvedValue({ id: 'legacy-id', name: 'legacy.com', status: 'verified', records: [] });

      const handle = getHandler('/email-domains/:domainId/verify', 'post');
      await handle(mockRequest as Request, mockResponse as Response, mockNext);

      expect(resendService.verifyDomain).toHaveBeenCalledWith('legacy-id');
    });
  });

  describe('GET /email-domains', () => {
    it('returns each registered domain enriched with live Resend status', async () => {
      const entries = [
        { id: 'd1', domain: 'first.com', status: 'pending', addedAt: '2026-01-01T00:00:00.000Z' },
        { id: 'd2', domain: 'second.com', status: 'pending', addedAt: '2026-01-02T00:00:00.000Z' },
      ];
      (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'test-user-id', emailDomains: entries });
      (resendService.getDomain as jest.Mock)
        .mockResolvedValueOnce({ id: 'd1', name: 'first.com', status: 'verified', records: [] })
        .mockResolvedValueOnce({ id: 'd2', name: 'second.com', status: 'pending', records: [{ record: 'SPF' }] });

      const handle = getHandler('/email-domains', 'get');
      await handle(mockRequest as Request, mockResponse as Response, mockNext);

      const jsonCall = (mockResponse.json as jest.Mock).mock.calls[0][0];
      expect(jsonCall.domains).toHaveLength(2);
      expect(jsonCall.domains[0].status).toBe('verified');
      expect(jsonCall.domains[1].records).toHaveLength(1);
    });

    it('returns an empty list for a user with no domains', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'test-user-id' });

      const handle = getHandler('/email-domains', 'get');
      await handle(mockRequest as Request, mockResponse as Response, mockNext);

      const jsonCall = (mockResponse.json as jest.Mock).mock.calls[0][0];
      expect(jsonCall.domains).toEqual([]);
    });

    it('surfaces a legacy scalar-only domain (registered before ENG-265) alongside the array (CodeRabbit)', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue({
        userId: 'test-user-id', emailDomain: 'legacy.com', resendDomainId: 'legacy-id',
      });
      (resendService.getDomain as jest.Mock).mockResolvedValue({ id: 'legacy-id', name: 'legacy.com', status: 'verified', records: [] });

      const handle = getHandler('/email-domains', 'get');
      await handle(mockRequest as Request, mockResponse as Response, mockNext);

      const jsonCall = (mockResponse.json as jest.Mock).mock.calls[0][0];
      expect(jsonCall.domains).toHaveLength(1);
      expect(jsonCall.domains[0]).toEqual(expect.objectContaining({ id: 'legacy-id', domain: 'legacy.com', status: 'verified' }));
    });

    it('does not double-count a legacy domain that has already been folded into emailDomains[]', async () => {
      const migrated = { id: 'legacy-id', domain: 'legacy.com', status: 'verified', addedAt: '2026-01-01T00:00:00.000Z' };
      (userDb.getUserById as jest.Mock).mockResolvedValue({
        userId: 'test-user-id', emailDomain: 'legacy.com', resendDomainId: 'legacy-id', emailDomains: [migrated],
      });
      (resendService.getDomain as jest.Mock).mockResolvedValue({ id: 'legacy-id', name: 'legacy.com', status: 'verified', records: [] });

      const handle = getHandler('/email-domains', 'get');
      await handle(mockRequest as Request, mockResponse as Response, mockNext);

      const jsonCall = (mockResponse.json as jest.Mock).mock.calls[0][0];
      expect(jsonCall.domains).toHaveLength(1);
    });

    it('falls back to the stored status for one domain whose live Resend lookup fails, instead of failing the whole list (CodeRabbit)', async () => {
      const entries = [
        { id: 'd1', domain: 'first.com', status: 'pending', addedAt: '2026-01-01T00:00:00.000Z' },
        { id: 'd2', domain: 'second.com', status: 'verified', addedAt: '2026-01-02T00:00:00.000Z' },
      ];
      (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'test-user-id', emailDomains: entries });
      (resendService.getDomain as jest.Mock)
        .mockRejectedValueOnce(new Error('Resend timed out'))
        .mockResolvedValueOnce({ id: 'd2', name: 'second.com', status: 'verified', records: [] });

      const handle = getHandler('/email-domains', 'get');
      await handle(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockResponse.status).not.toHaveBeenCalledWith(500);
      const jsonCall = (mockResponse.json as jest.Mock).mock.calls[0][0];
      expect(jsonCall.domains).toHaveLength(2);
      expect(jsonCall.domains[0]).toEqual(expect.objectContaining({ id: 'd1', status: 'pending', records: [] }));
      expect(jsonCall.domains[1]).toEqual(expect.objectContaining({ id: 'd2', status: 'verified' }));
    });
  });
});
