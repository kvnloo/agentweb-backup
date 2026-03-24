// Unit tests for CRM email domain self-serve endpoints

// Mock server and templates controller FIRST before any imports
jest.mock('../server', () => ({
  io: {
    to: jest.fn().mockReturnValue({
      emit: jest.fn(),
    }),
    emit: jest.fn(),
  },
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

// Mock dependencies
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
  taskDb: {
    getTaskById: jest.fn(),
  },
  subscriberDb: {
    getAllTaskSubscribers: jest.fn(),
  },
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
  agentModeService: {
    searchWeb: jest.fn(),
  },
}));

jest.mock('../utils/llmService', () => ({
  createLLMService: jest.fn(),
}));

jest.mock('../services/settingsService', () => ({
  settingsService: {
    getSetting: jest.fn(),
    setSetting: jest.fn(),
  }
}));

jest.mock('../services/resendService', () => ({
  resendService: {
    sendEmail: jest.fn(),
    createDomain: jest.fn(),
    getDomain: jest.fn(),
    verifyDomain: jest.fn(),
    listDomains: jest.fn(),
  }
}));

jest.mock('../utils/s3Utils', () => ({
  uploadFileToS3: jest.fn(),
}));

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, res: any, next: any) => {
    req.user = { userId: 'test-user-id', email: 'test@example.com' };
    next();
  },
  AuthenticatedRequest: {}
}));

jest.mock('../services/leadListAlertService', () => ({
  leadListAlertService: {
    processEmailReceivedEvent: jest.fn(),
  }
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
  const layer = router.stack.find((r: any) =>
    r.route?.path === path && r.route?.methods?.[method]
  );
  if (!layer || !layer.route) throw new Error(`Route ${method.toUpperCase()} ${path} not found`);
  return layer.route.stack[0].handle;
}

describe('CRM Email Domain Endpoints', () => {
  let mockRequest: Partial<Request>;
  let mockResponse: Partial<Response>;
  let mockNext: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();

    mockRequest = {
      user: { userId: 'test-user-id', email: 'test@example.com' },
      params: {},
      query: {},
      body: {},
    };

    mockResponse = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };

    mockNext = jest.fn();
  });

  describe('POST /email-domain', () => {
    it('should return 400 if domain is missing', async () => {
      mockRequest.body = {};

      const handle = getHandler('/email-domain', 'post');
      await handle(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockResponse.status).toHaveBeenCalledWith(400);
      expect(mockResponse.json).toHaveBeenCalledWith({ message: 'Domain is required' });
    });

    it('should return 400 for invalid domain format', async () => {
      mockRequest.body = { domain: 'not a domain' };

      const handle = getHandler('/email-domain', 'post');
      await handle(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockResponse.status).toHaveBeenCalledWith(400);
      expect(mockResponse.json).toHaveBeenCalledWith({ message: 'Invalid domain format' });
    });

    it('should return 409 if domain is used by another user', async () => {
      mockRequest.body = { domain: 'taken.com' };
      (userDb.getUsersByEmailDomain as jest.Mock).mockResolvedValue([
        { userId: 'other-user-id', emailDomain: 'taken.com' }
      ]);

      const handle = getHandler('/email-domain', 'post');
      await handle(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockResponse.status).toHaveBeenCalledWith(409);
      expect(mockResponse.json).toHaveBeenCalledWith({ message: 'This domain is already in use by another account' });
    });

    it('should allow same user to re-register their domain', async () => {
      mockRequest.body = { domain: 'mycompany.com' };
      (userDb.getUsersByEmailDomain as jest.Mock).mockResolvedValue([
        { userId: 'test-user-id', emailDomain: 'mycompany.com' }
      ]);
      (resendService.listDomains as jest.Mock).mockResolvedValue([]);
      (resendService.createDomain as jest.Mock).mockResolvedValue({
        id: 'domain-123',
        name: 'mycompany.com',
        status: 'not_started',
        records: [{ record: 'SPF', name: 'mycompany.com', value: 'v=spf1', type: 'TXT', ttl: '3600', status: 'not_started' }],
      });
      (userDb.updateUser as jest.Mock).mockResolvedValue({});

      const handle = getHandler('/email-domain', 'post');
      await handle(mockRequest as Request, mockResponse as Response, mockNext);

      expect(resendService.createDomain).toHaveBeenCalledWith('mycompany.com');
      expect(userDb.updateUser).toHaveBeenCalledWith('test-user-id', {
        emailDomain: 'mycompany.com',
        resendDomainId: 'domain-123',
      });
      expect(mockResponse.json).toHaveBeenCalled();
    });

    it('should reuse existing Resend domain if it already exists', async () => {
      mockRequest.body = { domain: 'existing.com' };
      (userDb.getUsersByEmailDomain as jest.Mock).mockResolvedValue([]);
      (resendService.listDomains as jest.Mock).mockResolvedValue([
        { id: 'domain-existing', name: 'existing.com', status: 'verified' }
      ]);
      (resendService.getDomain as jest.Mock).mockResolvedValue({
        id: 'domain-existing',
        name: 'existing.com',
        status: 'verified',
        records: [],
      });
      (userDb.updateUser as jest.Mock).mockResolvedValue({});

      const handle = getHandler('/email-domain', 'post');
      await handle(mockRequest as Request, mockResponse as Response, mockNext);

      expect(resendService.createDomain).not.toHaveBeenCalled();
      expect(userDb.updateUser).toHaveBeenCalledWith('test-user-id', {
        emailDomain: 'existing.com',
        resendDomainId: 'domain-existing',
      });
      const jsonCall = (mockResponse.json as jest.Mock).mock.calls[0][0];
      expect(jsonCall.alreadyExists).toBe(true);
    });

    it('should create a new domain in Resend and save to user', async () => {
      mockRequest.body = { domain: 'newdomain.com' };
      (userDb.getUsersByEmailDomain as jest.Mock).mockResolvedValue([]);
      (resendService.listDomains as jest.Mock).mockResolvedValue([]);
      (resendService.createDomain as jest.Mock).mockResolvedValue({
        id: 'domain-new',
        name: 'newdomain.com',
        status: 'not_started',
        records: [
          { record: 'SPF', name: 'newdomain.com', value: 'v=spf1 include:resend', type: 'TXT', ttl: '3600', status: 'not_started' },
          { record: 'DKIM', name: 'resend._domainkey.newdomain.com', value: 'dkim-value', type: 'CNAME', ttl: '3600', status: 'not_started' },
        ],
      });
      (userDb.updateUser as jest.Mock).mockResolvedValue({});

      const handle = getHandler('/email-domain', 'post');
      await handle(mockRequest as Request, mockResponse as Response, mockNext);

      expect(resendService.createDomain).toHaveBeenCalledWith('newdomain.com');
      expect(userDb.updateUser).toHaveBeenCalledWith('test-user-id', {
        emailDomain: 'newdomain.com',
        resendDomainId: 'domain-new',
      });
      const jsonCall = (mockResponse.json as jest.Mock).mock.calls[0][0];
      expect(jsonCall.domain.id).toBe('domain-new');
      expect(jsonCall.domain.records).toHaveLength(2);
    });
  });

  describe('POST /email-domain/verify', () => {
    it('should return 400 if no domain is configured', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'test-user-id' });

      const handle = getHandler('/email-domain/verify', 'post');
      await handle(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockResponse.status).toHaveBeenCalledWith(400);
    });

    it('should trigger verification and return domain status', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue({
        userId: 'test-user-id',
        resendDomainId: 'domain-123',
      });
      (resendService.verifyDomain as jest.Mock).mockResolvedValue(true);
      (resendService.getDomain as jest.Mock).mockResolvedValue({
        id: 'domain-123',
        name: 'example.com',
        status: 'verified',
        records: [],
      });

      const handle = getHandler('/email-domain/verify', 'post');
      await handle(mockRequest as Request, mockResponse as Response, mockNext);

      expect(resendService.verifyDomain).toHaveBeenCalledWith('domain-123');
      const jsonCall = (mockResponse.json as jest.Mock).mock.calls[0][0];
      expect(jsonCall.domain.status).toBe('verified');
      expect(jsonCall.message).toContain('verified successfully');
    });

    it('should return pending message when DNS not propagated yet', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue({
        userId: 'test-user-id',
        resendDomainId: 'domain-123',
      });
      (resendService.verifyDomain as jest.Mock).mockResolvedValue(true);
      (resendService.getDomain as jest.Mock).mockResolvedValue({
        id: 'domain-123',
        name: 'example.com',
        status: 'pending',
        records: [
          { record: 'SPF', name: 'example.com', value: 'v=spf1', type: 'TXT', ttl: '3600', status: 'pending' },
        ],
      });

      const handle = getHandler('/email-domain/verify', 'post');
      await handle(mockRequest as Request, mockResponse as Response, mockNext);

      const jsonCall = (mockResponse.json as jest.Mock).mock.calls[0][0];
      expect(jsonCall.domain.status).toBe('pending');
      expect(jsonCall.message).toContain('propagate');
    });
  });

  describe('DELETE /email-domain', () => {
    it('should return 400 if no domain configured', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'test-user-id' });

      const handle = getHandler('/email-domain', 'delete');
      await handle(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockResponse.status).toHaveBeenCalledWith(400);
      expect(mockResponse.json).toHaveBeenCalledWith({ message: 'No domain configured to reset' });
    });

    it('should clear domain fields from user record', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue({
        userId: 'test-user-id',
        emailDomain: 'old.com',
        resendDomainId: 'domain-old',
      });
      (userDb.updateUser as jest.Mock).mockResolvedValue({});

      const handle = getHandler('/email-domain', 'delete');
      await handle(mockRequest as Request, mockResponse as Response, mockNext);

      expect(userDb.updateUser).toHaveBeenCalledWith('test-user-id', {
        emailDomain: '',
        resendDomainId: '',
      });
      const jsonCall = (mockResponse.json as jest.Mock).mock.calls[0][0];
      expect(jsonCall.message).toContain('reset');
    });

    it('should work when only emailDomain is set (no resendDomainId)', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue({
        userId: 'test-user-id',
        emailDomain: 'legacy.com',
      });
      (userDb.updateUser as jest.Mock).mockResolvedValue({});

      const handle = getHandler('/email-domain', 'delete');
      await handle(mockRequest as Request, mockResponse as Response, mockNext);

      expect(userDb.updateUser).toHaveBeenCalledWith('test-user-id', {
        emailDomain: '',
        resendDomainId: '',
      });
      expect(mockResponse.json).toHaveBeenCalled();
    });
  });

  describe('GET /email-domain/status', () => {
    it('should return empty status if no domain configured', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'test-user-id' });

      const handle = getHandler('/email-domain/status', 'get');
      await handle(mockRequest as Request, mockResponse as Response, mockNext);

      const jsonCall = (mockResponse.json as jest.Mock).mock.calls[0][0];
      expect(jsonCall.hasEmailDomain).toBe(false);
      expect(jsonCall.resendDomainId).toBeNull();
      expect(jsonCall.records).toEqual([]);
    });

    it('should return legacy domain status (no resendDomainId)', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue({
        userId: 'test-user-id',
        emailDomain: 'legacy.com',
      });

      const handle = getHandler('/email-domain/status', 'get');
      await handle(mockRequest as Request, mockResponse as Response, mockNext);

      const jsonCall = (mockResponse.json as jest.Mock).mock.calls[0][0];
      expect(jsonCall.hasEmailDomain).toBe(true);
      expect(jsonCall.emailDomain).toBe('legacy.com');
      expect(jsonCall.resendDomainId).toBeNull();
    });

    it('should return full domain status with DNS records', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue({
        userId: 'test-user-id',
        emailDomain: 'verified.com',
        resendDomainId: 'domain-456',
      });
      (resendService.getDomain as jest.Mock).mockResolvedValue({
        id: 'domain-456',
        name: 'verified.com',
        status: 'verified',
        records: [
          { record: 'SPF', name: 'verified.com', value: 'v=spf1', type: 'TXT', ttl: '3600', status: 'verified' },
          { record: 'DKIM', name: 'resend._domainkey.verified.com', value: 'dkim-value', type: 'CNAME', ttl: '3600', status: 'verified' },
        ],
      });

      const handle = getHandler('/email-domain/status', 'get');
      await handle(mockRequest as Request, mockResponse as Response, mockNext);

      const jsonCall = (mockResponse.json as jest.Mock).mock.calls[0][0];
      expect(jsonCall.hasEmailDomain).toBe(true);
      expect(jsonCall.domainStatus).toBe('verified');
      expect(jsonCall.records).toHaveLength(2);
    });
  });
});
