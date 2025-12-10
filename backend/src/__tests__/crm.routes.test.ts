// Unit tests for CRM routes
import { Request, Response } from 'express';
import { crmDb } from '../services/db';
import { settingsService } from '../services/settingsService';
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
  }
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
  }
}));

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, res: any, next: any) => {
    // Mock authenticated user
    req.user = { userId: 'test-user-id', email: 'test@example.com' };
    next();
  },
  AuthenticatedRequest: {}
}));

describe('CRM Routes', () => {
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

  describe('GET /api/crm/lists', () => {
    it('should return all lead lists for the authenticated user', async () => {
      const mockLists = [
        { listId: 'list1', name: 'List 1', userId: 'test-user-id' },
        { listId: 'list2', name: 'List 2', userId: 'test-user-id' },
      ];
      
      (crmDb.getLeadListsByUserId as jest.Mock).mockResolvedValue(mockLists);
      
      mockRequest.method = 'GET';
      mockRequest.url = '/lists';
      
      // Simulate route handler
      const handler = router.stack.find((r: any) => r.route?.path === '/lists' && r.route?.methods?.get);
      if (handler && handler.route) {
        await handler.route.stack[0].handle(mockRequest as Request, mockResponse as Response, mockNext);
      }
      
      expect(crmDb.getLeadListsByUserId).toHaveBeenCalledWith('test-user-id');
      expect(mockResponse.json).toHaveBeenCalledWith(mockLists);
    });

    it('should return 401 if user is not authenticated', async () => {
      mockRequest.user = undefined;
      
      // The middleware would handle this, but we test the handler logic
      const handler = router.stack.find((r: any) => r.route?.path === '/lists' && r.route?.methods?.get);
      if (handler && handler.route) {
        await handler.route.stack[0].handle(mockRequest as Request, mockResponse as Response, mockNext);
      }
      
      expect(mockResponse.status).toHaveBeenCalledWith(401);
    });
  });

  describe('POST /api/crm/lists', () => {
    it('should create a new lead list', async () => {
      const mockList = {
        listId: 'list1',
        name: 'New List',
        description: 'Test description',
        userId: 'test-user-id',
        createdAt: new Date().toISOString(),
      };
      
      (crmDb.createLeadList as jest.Mock).mockResolvedValue(mockList);
      
      mockRequest.method = 'POST';
      mockRequest.url = '/lists';
      mockRequest.body = { name: 'New List', description: 'Test description' };
      
      const handler = router.stack.find((r: any) => r.route?.path === '/lists' && r.route?.methods?.post);
      if (handler && handler.route) {
        await handler.route.stack[0].handle(mockRequest as Request, mockResponse as Response, mockNext);
      }
      
      expect(crmDb.createLeadList).toHaveBeenCalledWith('test-user-id', 'New List', 'Test description');
      expect(mockResponse.status).toHaveBeenCalledWith(201);
      expect(mockResponse.json).toHaveBeenCalledWith(mockList);
    });

    it('should return 400 if name is missing', async () => {
      mockRequest.body = { description: 'Test description' };
      
      const handler = router.stack.find((r: any) => r.route?.path === '/lists' && r.route?.methods?.post);
      if (handler && handler.route) {
        await handler.route.stack[0].handle(mockRequest as Request, mockResponse as Response, mockNext);
      }
      
      expect(mockResponse.status).toHaveBeenCalledWith(400);
      expect(mockResponse.json).toHaveBeenCalledWith({ message: 'List name is required' });
    });

    it('should return 400 if name is empty string', async () => {
      mockRequest.body = { name: '   ' };
      
      const handler = router.stack.find((r: any) => r.route?.path === '/lists' && r.route?.methods?.post);
      if (handler && handler.route) {
        await handler.route.stack[0].handle(mockRequest as Request, mockResponse as Response, mockNext);
      }
      
      expect(mockResponse.status).toHaveBeenCalledWith(400);
    });
  });

  describe('GET /api/crm/lists/:listId', () => {
    it('should return a specific lead list', async () => {
      const mockList = {
        listId: 'list1',
        name: 'Test List',
        userId: 'test-user-id',
      };
      
      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockList);
      
      mockRequest.params = { listId: 'list1' };
      
      const handler = router.stack.find((r: any) => r.route?.path === '/lists/:listId' && r.route?.methods?.get);
      if (handler && handler.route) {
        await handler.route.stack[0].handle(mockRequest as Request, mockResponse as Response, mockNext);
      }
      
      expect(crmDb.getLeadListById).toHaveBeenCalledWith('list1');
      expect(mockResponse.json).toHaveBeenCalledWith(mockList);
    });

    it('should return 404 if list not found', async () => {
      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(null);
      
      mockRequest.params = { listId: 'nonexistent' };
      
      const handler = router.stack.find((r: any) => r.route?.path === '/lists/:listId' && r.route?.methods?.get);
      if (handler && handler.route) {
        await handler.route.stack[0].handle(mockRequest as Request, mockResponse as Response, mockNext);
      }
      
      expect(mockResponse.status).toHaveBeenCalledWith(404);
    });

    it('should return 403 if user does not own the list', async () => {
      const mockList = {
        listId: 'list1',
        name: 'Test List',
        userId: 'other-user-id',
      };
      
      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockList);
      
      mockRequest.params = { listId: 'list1' };
      
      const handler = router.stack.find((r: any) => r.route?.path === '/lists/:listId' && r.route?.methods?.get);
      if (handler && handler.route) {
        await handler.route.stack[0].handle(mockRequest as Request, mockResponse as Response, mockNext);
      }
      
      expect(mockResponse.status).toHaveBeenCalledWith(403);
    });
  });

  describe('PUT /api/crm/lists/:listId', () => {
    it('should update a lead list', async () => {
      const mockList = {
        listId: 'list1',
        name: 'Updated List',
        userId: 'test-user-id',
      };
      
      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockList);
      (crmDb.updateLeadList as jest.Mock).mockResolvedValue({ ...mockList, name: 'Updated List' });
      
      mockRequest.params = { listId: 'list1' };
      mockRequest.body = { name: 'Updated List', displayFields: ['email', 'firstName'] };
      
      const handler = router.stack.find((r: any) => r.route?.path === '/lists/:listId' && r.route?.methods?.put);
      if (handler && handler.route) {
        await handler.route.stack[0].handle(mockRequest as Request, mockResponse as Response, mockNext);
      }
      
      expect(crmDb.updateLeadList).toHaveBeenCalledWith('list1', {
        name: 'Updated List',
        displayFields: ['email', 'firstName'],
      });
    });

    it('should return 400 if displayFields is not an array', async () => {
      const mockList = {
        listId: 'list1',
        name: 'Test List',
        userId: 'test-user-id',
      };
      
      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockList);
      
      mockRequest.params = { listId: 'list1' };
      mockRequest.body = { displayFields: 'not-an-array' };
      
      const handler = router.stack.find((r: any) => r.route?.path === '/lists/:listId' && r.route?.methods?.put);
      if (handler && handler.route) {
        await handler.route.stack[0].handle(mockRequest as Request, mockResponse as Response, mockNext);
      }
      
      expect(mockResponse.status).toHaveBeenCalledWith(400);
    });
  });

  describe('POST /api/crm/lists/:listId/leads', () => {
    it('should create a new lead', async () => {
      const mockList = {
        listId: 'list1',
        name: 'Test List',
        userId: 'test-user-id',
      };
      
      const mockLead = {
        leadId: 'lead1',
        listId: 'list1',
        email: 'test@example.com',
        firstName: 'John',
        lastName: 'Doe',
      };
      
      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockList);
      (crmDb.createLead as jest.Mock).mockResolvedValue(mockLead);
      
      mockRequest.params = { listId: 'list1' };
      mockRequest.body = {
        email: 'test@example.com',
        firstName: 'John',
        lastName: 'Doe',
      };
      
      const handler = router.stack.find((r: any) => 
        r.route?.path === '/lists/:listId/leads' && r.route?.methods?.post
      );
      if (handler && handler.route) {
        await handler.route.stack[0].handle(mockRequest as Request, mockResponse as Response, mockNext);
      }
      
      expect(crmDb.createLead).toHaveBeenCalledWith('list1', mockRequest.body);
      expect(mockResponse.status).toHaveBeenCalledWith(201);
      expect(mockResponse.json).toHaveBeenCalledWith(mockLead);
    });
  });

  describe('GET /api/crm/lists/:listId/leads', () => {
    it('should return leads with pagination', async () => {
      const mockList = {
        listId: 'list1',
        name: 'Test List',
        userId: 'test-user-id',
      };
      
      const mockLeads = [
        { leadId: 'lead1', email: 'test1@example.com' },
        { leadId: 'lead2', email: 'test2@example.com' },
      ];
      
      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockList);
      (crmDb.getLeadsByListId as jest.Mock).mockResolvedValue({
        items: mockLeads,
        lastEvaluatedKey: null,
        hasMore: false,
      });
      (crmDb.getLeadEngagementCount as jest.Mock).mockResolvedValue({
        total: 5,
        last7Days: 2,
      });
      
      mockRequest.params = { listId: 'list1' };
      mockRequest.query = { page: '1', limit: '50' };
      
      const handler = router.stack.find((r: any) => 
        r.route?.path === '/lists/:listId/leads' && r.route?.methods?.get
      );
      if (handler && handler.route) {
        await handler.route.stack[0].handle(mockRequest as Request, mockResponse as Response, mockNext);
      }
      
      expect(crmDb.getLeadsByListId).toHaveBeenCalled();
      expect(mockResponse.json).toHaveBeenCalled();
    });
  });

  describe('POST /api/crm/lists/:listId/leads/import', () => {
    it('should import leads from CSV', async () => {
      const mockList = {
        listId: 'list1',
        name: 'Test List',
        userId: 'test-user-id',
      };
      
      const csvContent = 'email,firstName,lastName\njohn@example.com,John,Doe';
      const mockFile = {
        buffer: Buffer.from(csvContent),
        originalname: 'leads.csv',
        mimetype: 'text/csv',
      };
      
      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockList);
      (crmDb.batchCreateLeads as jest.Mock).mockResolvedValue({
        successCount: 1,
        errorCount: 0,
        errors: [],
      });
      
      // Setup proper request for multer middleware
      mockRequest.params = { listId: 'list1' };
      mockRequest.file = mockFile as any;
      mockRequest.headers = {
        'content-type': 'multipart/form-data',
      } as any;
      mockRequest.body = {};
      
      const handler = router.stack.find((r: any) => 
        r.route?.path === '/lists/:listId/leads/import' && r.route?.methods?.post
      );
      if (handler && handler.route) {
        // Skip multer middleware and call the route handler directly
        // Find the actual route handler (not the multer middleware)
        const routeHandler = handler.route.stack.find((layer: any) => 
          layer.name !== 'multerMiddleware' && typeof layer.handle === 'function'
        );
        if (routeHandler) {
          // Manually set file on request to simulate multer
          (mockRequest as any).file = mockFile;
          await routeHandler.handle(mockRequest as Request, mockResponse as Response, mockNext);
        }
      }
      
      expect(crmDb.batchCreateLeads).toHaveBeenCalled();
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          successCount: 1,
        })
      );
    });

    it('should return 400 if no file is provided', async () => {
      const mockList = {
        listId: 'list1',
        name: 'Test List',
        userId: 'test-user-id',
      };
      
      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockList);
      
      mockRequest.params = { listId: 'list1' };
      mockRequest.file = undefined;
      mockRequest.headers = {
        'content-type': 'multipart/form-data',
      } as any;
      mockRequest.body = {};
      
      const handler = router.stack.find((r: any) => 
        r.route?.path === '/lists/:listId/leads/import' && r.route?.methods?.post
      );
      if (handler && handler.route) {
        // Skip multer middleware and call the route handler directly
        const routeHandler = handler.route.stack.find((layer: any) => 
          layer.name !== 'multerMiddleware' && typeof layer.handle === 'function'
        );
        if (routeHandler) {
          // Manually set file to undefined to simulate no file
          (mockRequest as any).file = undefined;
          await routeHandler.handle(mockRequest as Request, mockResponse as Response, mockNext);
        }
      }
      
      expect(mockResponse.status).toHaveBeenCalledWith(400);
    });
  });

  describe('GET /api/crm/sender-emails', () => {
    it('should return sender emails configuration', async () => {
      const mockSetting = {
        settingName: 'crm_sender_emails_test-user-id',
        settingValue: JSON.stringify({
          senders: [
            { id: '1', email: 'sender@example.com', fromName: 'Sender Name' },
          ],
          defaultSenderId: '1',
        }),
      };
      
      (settingsService.getSetting as jest.Mock).mockResolvedValue(mockSetting);
      
      const handler = router.stack.find((r: any) => 
        r.route?.path === '/sender-emails' && r.route?.methods?.get
      );
      if (handler && handler.route) {
        await handler.route.stack[0].handle(mockRequest as Request, mockResponse as Response, mockNext);
      }
      
      expect(settingsService.getSetting).toHaveBeenCalledWith('crm_sender_emails_test-user-id');
      expect(mockResponse.json).toHaveBeenCalled();
    });

    it('should return empty configuration if not set', async () => {
      (settingsService.getSetting as jest.Mock).mockResolvedValue(null);
      
      const handler = router.stack.find((r: any) => 
        r.route?.path === '/sender-emails' && r.route?.methods?.get
      );
      if (handler && handler.route) {
        await handler.route.stack[0].handle(mockRequest as Request, mockResponse as Response, mockNext);
      }
      
      expect(mockResponse.json).toHaveBeenCalledWith({
        senders: [],
        defaultSenderId: null,
      });
    });
  });

  describe('POST /api/crm/sender-emails', () => {
    it('should save sender emails configuration', async () => {
      const senders = [
        { id: '1', email: 'sender@example.com', fromName: 'Sender Name', notes: 'Test notes' },
      ];
      
      (settingsService.setSetting as jest.Mock).mockResolvedValue(undefined);
      
      mockRequest.body = {
        senders,
        defaultSenderId: '1',
      };
      
      const handler = router.stack.find((r: any) => 
        r.route?.path === '/sender-emails' && r.route?.methods?.post
      );
      if (handler && handler.route) {
        await handler.route.stack[0].handle(mockRequest as Request, mockResponse as Response, mockNext);
      }
      
      expect(settingsService.setSetting).toHaveBeenCalled();
      expect(mockResponse.json).toHaveBeenCalled();
    });

    it('should return 400 if senders is not an array', async () => {
      mockRequest.body = {
        senders: 'not-an-array',
      };
      
      const handler = router.stack.find((r: any) => 
        r.route?.path === '/sender-emails' && r.route?.methods?.post
      );
      if (handler && handler.route) {
        await handler.route.stack[0].handle(mockRequest as Request, mockResponse as Response, mockNext);
      }
      
      expect(mockResponse.status).toHaveBeenCalledWith(400);
    });

    it('should return 400 if sender is missing email or fromName', async () => {
      mockRequest.body = {
        senders: [{ email: 'test@example.com' }], // missing fromName
      };
      
      const handler = router.stack.find((r: any) => 
        r.route?.path === '/sender-emails' && r.route?.methods?.post
      );
      if (handler && handler.route) {
        await handler.route.stack[0].handle(mockRequest as Request, mockResponse as Response, mockNext);
      }
      
      expect(mockResponse.status).toHaveBeenCalledWith(400);
    });
  });

  describe('POST /api/crm/lists/:listId/leads/:leadId/send-email', () => {
    it('should send email and remove draft', async () => {
      const mockList = {
        listId: 'list1',
        name: 'Test List',
        userId: 'test-user-id',
      };
      
      const mockLead = {
        leadId: 'lead1',
        listId: 'list1',
        email: 'lead@example.com',
      };
      
      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockList);
      (crmDb.getLeadById as jest.Mock).mockResolvedValue(mockLead);
      (resendService.sendEmail as jest.Mock).mockResolvedValue({ id: 'email-id-123' });
      (crmDb.updateLead as jest.Mock).mockResolvedValue({ ...mockLead, emailDraft: null });
      
      mockRequest.params = { listId: 'list1', leadId: 'lead1' };
      mockRequest.body = {
        senderEmail: 'sender@example.com',
        senderName: 'Sender Name',
        subject: 'Test Subject',
        htmlContent: '<p>Test content</p>',
      };
      
      const handler = router.stack.find((r: any) => 
        r.route?.path === '/lists/:listId/leads/:leadId/send-email' && r.route?.methods?.post
      );
      if (handler && handler.route) {
        await handler.route.stack[0].handle(mockRequest as Request, mockResponse as Response, mockNext);
      }
      
      expect(resendService.sendEmail).toHaveBeenCalledWith({
        from: 'Sender Name <sender@example.com>',
        to: 'lead@example.com',
        subject: 'Test Subject',
        html: '<p>Test content</p>',
      });
      expect(crmDb.updateLead).toHaveBeenCalledWith('list1', 'lead1', { emailDraft: null });
      expect(mockResponse.json).toHaveBeenCalled();
    });

    it('should send email with text content', async () => {
      const mockList = {
        listId: 'list1',
        name: 'Test List',
        userId: 'test-user-id',
      };
      
      const mockLead = {
        leadId: 'lead1',
        listId: 'list1',
        email: 'lead@example.com',
      };
      
      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockList);
      (crmDb.getLeadById as jest.Mock).mockResolvedValue(mockLead);
      (resendService.sendEmail as jest.Mock).mockResolvedValue({ id: 'email-id-123' });
      (crmDb.updateLead as jest.Mock).mockResolvedValue({ ...mockLead, emailDraft: null });
      
      mockRequest.params = { listId: 'list1', leadId: 'lead1' };
      mockRequest.body = {
        senderEmail: 'sender@example.com',
        senderName: 'Sender Name',
        subject: 'Test Subject',
        textContent: 'Plain text content without HTML',
      };
      
      const handler = router.stack.find((r: any) => 
        r.route?.path === '/lists/:listId/leads/:leadId/send-email' && r.route?.methods?.post
      );
      if (handler && handler.route) {
        await handler.route.stack[0].handle(mockRequest as Request, mockResponse as Response, mockNext);
      }
      
      expect(resendService.sendEmail).toHaveBeenCalledWith({
        from: 'Sender Name <sender@example.com>',
        to: 'lead@example.com',
        subject: 'Test Subject',
        text: 'Plain text content without HTML',
      });
      expect(crmDb.updateLead).toHaveBeenCalledWith('list1', 'lead1', { emailDraft: null });
      expect(mockResponse.json).toHaveBeenCalled();
    });

    it('should send email with both HTML and text content', async () => {
      const mockList = {
        listId: 'list1',
        name: 'Test List',
        userId: 'test-user-id',
      };
      
      const mockLead = {
        leadId: 'lead1',
        listId: 'list1',
        email: 'lead@example.com',
      };
      
      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockList);
      (crmDb.getLeadById as jest.Mock).mockResolvedValue(mockLead);
      (resendService.sendEmail as jest.Mock).mockResolvedValue({ id: 'email-id-123' });
      (crmDb.updateLead as jest.Mock).mockResolvedValue({ ...mockLead, emailDraft: null });
      
      mockRequest.params = { listId: 'list1', leadId: 'lead1' };
      mockRequest.body = {
        senderEmail: 'sender@example.com',
        senderName: 'Sender Name',
        subject: 'Test Subject',
        htmlContent: '<p>HTML content</p>',
        textContent: 'Plain text content',
      };
      
      const handler = router.stack.find((r: any) => 
        r.route?.path === '/lists/:listId/leads/:leadId/send-email' && r.route?.methods?.post
      );
      if (handler && handler.route) {
        await handler.route.stack[0].handle(mockRequest as Request, mockResponse as Response, mockNext);
      }
      
      expect(resendService.sendEmail).toHaveBeenCalledWith({
        from: 'Sender Name <sender@example.com>',
        to: 'lead@example.com',
        subject: 'Test Subject',
        html: '<p>HTML content</p>',
        text: 'Plain text content',
      });
      expect(crmDb.updateLead).toHaveBeenCalledWith('list1', 'lead1', { emailDraft: null });
      expect(mockResponse.json).toHaveBeenCalled();
    });

    it('should return 400 if neither htmlContent nor textContent is provided', async () => {
      const mockList = {
        listId: 'list1',
        name: 'Test List',
        userId: 'test-user-id',
      };
      
      const mockLead = {
        leadId: 'lead1',
        listId: 'list1',
        email: 'lead@example.com',
      };
      
      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockList);
      (crmDb.getLeadById as jest.Mock).mockResolvedValue(mockLead);
      
      mockRequest.params = { listId: 'list1', leadId: 'lead1' };
      mockRequest.body = {
        senderEmail: 'sender@example.com',
        senderName: 'Sender Name',
        subject: 'Test Subject',
        // Missing both htmlContent and textContent
      };
      
      const handler = router.stack.find((r: any) => 
        r.route?.path === '/lists/:listId/leads/:leadId/send-email' && r.route?.methods?.post
      );
      if (handler && handler.route) {
        await handler.route.stack[0].handle(mockRequest as Request, mockResponse as Response, mockNext);
      }
      
      expect(mockResponse.status).toHaveBeenCalledWith(400);
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('either htmlContent or textContent'),
        })
      );
    });
  });
});

