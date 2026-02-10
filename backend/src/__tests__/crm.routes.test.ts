// Unit tests for CRM routes

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
import { crmDb } from '../services/db';
import { settingsService } from '../services/settingsService';
import { resendService } from '../services/resendService';
import { agentModeService } from '../services/agentModeService';
import { createLLMService } from '../utils/llmService';
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
  },
  taskDb: {
    getTaskById: jest.fn(),
  },
  subscriberDb: {
    getAllTaskSubscribers: jest.fn(),
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
      
      expect(crmDb.createLeadList).toHaveBeenCalledWith('test-user-id', 'New List', 'Test description', undefined, null, false);
      expect(mockResponse.status).toHaveBeenCalledWith(201);
      expect(mockResponse.json).toHaveBeenCalledWith(mockList);
    });

    it('should normalize alert events when creating a lead list', async () => {
      const mockList = {
        listId: 'list2',
        name: 'Alerts List',
        description: 'Alert description',
        userId: 'test-user-id',
        createdAt: new Date().toISOString(),
      };

      (crmDb.createLeadList as jest.Mock).mockResolvedValue(mockList);

      mockRequest.method = 'POST';
      mockRequest.url = '/lists';
      mockRequest.body = {
        name: 'Alerts List',
        description: 'Alert description',
        alertEvents: [' email.received ', 'EMAIL.CLICKED', 'email.received'],
      };

      const handler = router.stack.find((r: any) => r.route?.path === '/lists' && r.route?.methods?.post);
      if (handler && handler.route) {
        await handler.route.stack[0].handle(mockRequest as Request, mockResponse as Response, mockNext);
      }

      expect(crmDb.createLeadList).toHaveBeenCalledWith(
        'test-user-id',
        'Alerts List',
        'Alert description',
        ['email.received', 'email.clicked'],
        null,
        false
      );
      expect(mockResponse.status).toHaveBeenCalledWith(201);
    });

    it('should return 400 if alertEvents is not an array', async () => {
      mockRequest.method = 'POST';
      mockRequest.url = '/lists';
      mockRequest.body = { name: 'Bad List', alertEvents: 'email.received' };

      const handler = router.stack.find((r: any) => r.route?.path === '/lists' && r.route?.methods?.post);
      if (handler && handler.route) {
        await handler.route.stack[0].handle(mockRequest as Request, mockResponse as Response, mockNext);
      }

      expect(mockResponse.status).toHaveBeenCalledWith(400);
      expect(mockResponse.json).toHaveBeenCalledWith({ message: 'alertEvents must be an array' });
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

    it('should return 400 if listSenderId is not configured', async () => {
      mockRequest.method = 'POST';
      mockRequest.url = '/lists';
      mockRequest.body = {
        name: 'Bad Sender List',
        listSenderId: 'missing-sender',
      };

      (settingsService.getSetting as jest.Mock).mockResolvedValue({
        settingValue: JSON.stringify({
          senders: [{ id: 'sender-1', email: 'sender@example.com', fromName: 'Sender' }],
          defaultSenderId: 'sender-1',
        }),
      });

      const handler = router.stack.find((r: any) => r.route?.path === '/lists' && r.route?.methods?.post);
      if (handler && handler.route) {
        await handler.route.stack[0].handle(mockRequest as Request, mockResponse as Response, mockNext);
      }

      expect(crmDb.createLeadList).not.toHaveBeenCalled();
      expect(mockResponse.status).toHaveBeenCalledWith(400);
      expect(mockResponse.json).toHaveBeenCalledWith({ message: 'listSenderId must reference a configured sender' });
    });

    it('should allow listSenderId when configured', async () => {
      const mockList = {
        listId: 'list3',
        name: 'PoC List',
        description: '',
        userId: 'test-user-id',
      };

      (crmDb.createLeadList as jest.Mock).mockResolvedValue(mockList);
      (settingsService.getSetting as jest.Mock).mockResolvedValue({
        settingValue: JSON.stringify({
          senders: [{ id: 'sender-1', email: 'sender@example.com', fromName: 'Sender' }],
          defaultSenderId: 'sender-1',
        }),
      });

      mockRequest.method = 'POST';
      mockRequest.url = '/lists';
      mockRequest.body = { name: 'PoC List', listSenderId: 'sender-1' };

      const handler = router.stack.find((r: any) => r.route?.path === '/lists' && r.route?.methods?.post);
      if (handler && handler.route) {
        await handler.route.stack[0].handle(mockRequest as Request, mockResponse as Response, mockNext);
      }

      expect(crmDb.createLeadList).toHaveBeenCalledWith(
        'test-user-id',
        'PoC List',
        undefined,
        undefined,
        'sender-1',
        false
      );
      expect(mockResponse.status).toHaveBeenCalledWith(201);
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

    it('should normalize alert events when updating a lead list', async () => {
      const mockList = {
        listId: 'list1',
        name: 'Updated List',
        userId: 'test-user-id',
      };

      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockList);
      (crmDb.updateLeadList as jest.Mock).mockResolvedValue(mockList);

      mockRequest.params = { listId: 'list1' };
      mockRequest.body = { alertEvents: [' Email.Received ', 'custom.linkedin', 'email.received'] };

      const handler = router.stack.find((r: any) => r.route?.path === '/lists/:listId' && r.route?.methods?.put);
      if (handler && handler.route) {
        await handler.route.stack[0].handle(mockRequest as Request, mockResponse as Response, mockNext);
      }

      expect(crmDb.updateLeadList).toHaveBeenCalledWith('list1', {
        alertEvents: ['email.received', 'custom.linkedin'],
      });
    });

    it('should update sort config for a lead list', async () => {
      const mockList = {
        listId: 'list1',
        name: 'Test List',
        userId: 'test-user-id',
      };

      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockList);
      (crmDb.updateLeadList as jest.Mock).mockResolvedValue({
        ...mockList,
        sortConfig: { column: 'email', direction: 'desc' },
      });

      mockRequest.params = { listId: 'list1' };
      mockRequest.body = { sortConfig: { column: 'email', direction: 'desc' } };

      const handler = router.stack.find((r: any) => r.route?.path === '/lists/:listId' && r.route?.methods?.put);
      if (handler && handler.route) {
        await handler.route.stack[0].handle(mockRequest as Request, mockResponse as Response, mockNext);
      }

      expect(crmDb.updateLeadList).toHaveBeenCalledWith('list1', {
        sortConfig: { column: 'email', direction: 'desc' },
      });
    });

    it('should return 400 if sortConfig direction is invalid', async () => {
      const mockList = {
        listId: 'list1',
        name: 'Test List',
        userId: 'test-user-id',
      };

      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockList);

      mockRequest.params = { listId: 'list1' };
      mockRequest.body = { sortConfig: { column: 'email', direction: 'down' } };

      const handler = router.stack.find((r: any) => r.route?.path === '/lists/:listId' && r.route?.methods?.put);
      if (handler && handler.route) {
        await handler.route.stack[0].handle(mockRequest as Request, mockResponse as Response, mockNext);
      }

      expect(mockResponse.status).toHaveBeenCalledWith(400);
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

    it('should return 400 if selectedSenderId is not configured', async () => {
      const mockList = {
        listId: 'list1',
        name: 'Test List',
        userId: 'test-user-id',
      };

      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockList);
      (settingsService.getSetting as jest.Mock).mockResolvedValue({
        settingValue: JSON.stringify({
          senders: [{ id: 'sender-1', email: 'sender@example.com', fromName: 'Sender' }],
          defaultSenderId: 'sender-1',
        }),
      });

      mockRequest.params = { listId: 'list1' };
      mockRequest.body = {
        email: 'test@example.com',
        firstName: 'John',
        selectedSenderId: 'missing-sender',
      };

      const handler = router.stack.find((r: any) => 
        r.route?.path === '/lists/:listId/leads' && r.route?.methods?.post
      );
      if (handler && handler.route) {
        await handler.route.stack[0].handle(mockRequest as Request, mockResponse as Response, mockNext);
      }

      expect(crmDb.createLead).not.toHaveBeenCalled();
      expect(mockResponse.status).toHaveBeenCalledWith(400);
      expect(mockResponse.json).toHaveBeenCalledWith({ message: 'selectedSenderId must reference a configured sender' });
    });
  });

  describe('PUT /api/crm/lists/:listId/leads/:leadId', () => {
    it('should return 400 if selectedSenderId is not configured', async () => {
      const mockList = {
        listId: 'list1',
        name: 'Test List',
        userId: 'test-user-id',
      };

      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockList);
      (settingsService.getSetting as jest.Mock).mockResolvedValue({
        settingValue: JSON.stringify({
          senders: [{ id: 'sender-1', email: 'sender@example.com', fromName: 'Sender' }],
          defaultSenderId: 'sender-1',
        }),
      });

      mockRequest.params = { listId: 'list1', leadId: 'lead1' };
      mockRequest.body = {
        selectedSenderId: 'missing-sender',
      };

      const handler = router.stack.find((r: any) => 
        r.route?.path === '/lists/:listId/leads/:leadId' && r.route?.methods?.put
      );
      if (handler && handler.route) {
        await handler.route.stack[0].handle(mockRequest as Request, mockResponse as Response, mockNext);
      }

      expect(crmDb.updateLead).not.toHaveBeenCalled();
      expect(mockResponse.status).toHaveBeenCalledWith(400);
      expect(mockResponse.json).toHaveBeenCalledWith({ message: 'selectedSenderId must reference a configured sender' });
    });
  });

  describe('POST /api/crm/lists/:listId/leads/enrich-web', () => {
    const findEnrichWebPostHandler = () => router.stack.find((r: any) =>
      r.route?.path === '/lists/:listId/leads/enrich-web' && r.route?.methods?.post
    );

    it('should return preview counts', async () => {
      const mockList = {
        listId: 'list1',
        name: 'Test List',
        userId: 'test-user-id',
      };

      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockList);
      (crmDb.getLeadsByListId as jest.Mock).mockResolvedValue({
        items: [
          { leadId: 'lead1', company: 'Acme', customFields: {} },
          { leadId: 'lead2', company: 'Beta', customFields: { web_company_info: 'Existing info' } },
          { leadId: 'lead3', company: '' },
        ],
        lastEvaluatedKey: null,
      });

      mockRequest.params = { listId: 'list1' };
      mockRequest.query = { mode: 'preview' };
      mockRequest.body = { forceEnrich: false };

      const handler = findEnrichWebPostHandler();
      if (handler && handler.route) {
        await handler.route.stack[0].handle(mockRequest as Request, mockResponse as Response, mockNext);
      }

      expect(mockResponse.json).toHaveBeenCalledWith(expect.objectContaining({
        success: true,
        totalLeads: 3,
        leadsWithCompany: 2,
        alreadyEnrichedLeads: 1,
        couldBeEnrichedLeads: 1,
        leadsToProcess: 1,
      }));
    });

    it('should set "Company information not found" when search has no results', async () => {
      const mockList = {
        listId: 'list1',
        name: 'Test List',
        userId: 'test-user-id',
      };

      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockList);
      (crmDb.getLeadsByListId as jest.Mock).mockResolvedValue({
        items: [
          {
            leadId: 'lead1',
            company: 'Unknown Co',
            customFields: {},
          },
        ],
        lastEvaluatedKey: null,
      });
      (agentModeService.searchWeb as jest.Mock).mockResolvedValue({
        success: false,
        error: 'No search results found',
      });

      mockRequest.params = { listId: 'list1' };
      mockRequest.query = { mode: 'enrich' };
      mockRequest.body = {};

      const handler = findEnrichWebPostHandler();
      if (handler && handler.route) {
        await handler.route.stack[0].handle(mockRequest as Request, mockResponse as Response, mockNext);
      }

      expect(crmDb.updateLead).toHaveBeenCalledWith('list1', 'lead1', {
        customFields: {
          web_company_info: 'Company information not found',
        },
      });
      expect(mockResponse.json).toHaveBeenCalledWith(expect.objectContaining({
        success: true,
        processedCount: 1,
        failedCount: 0,
      }));
    });

    it('should retry with stricter JSON instructions when first JSON parse fails', async () => {
      const mockList = {
        listId: 'list1',
        name: 'Test List',
        userId: 'test-user-id',
      };

      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockList);
      (crmDb.getLeadsByListId as jest.Mock).mockResolvedValue({
        items: [
          {
            leadId: 'lead-json-retry',
            company: 'Acme',
            customFields: {},
          },
        ],
        lastEvaluatedKey: null,
      });
      (agentModeService.searchWeb as jest.Mock).mockResolvedValue({
        success: true,
        results: [{ title: 'Acme', url: 'https://acme.test', snippet: 'Acme overview' }],
      });

      const mockLlmService = {
        generateJSONContent: jest.fn().mockRejectedValue(new SyntaxError('Bad JSON')),
        generateContent: jest.fn().mockResolvedValue('{"web_company_info":"Acme builds B2B software."}'),
      };
      (createLLMService as jest.Mock).mockReturnValue(mockLlmService);

      mockRequest.params = { listId: 'list1' };
      mockRequest.query = { mode: 'enrich' };
      mockRequest.body = {};

      const handler = findEnrichWebPostHandler();
      if (handler && handler.route) {
        await handler.route.stack[0].handle(mockRequest as Request, mockResponse as Response, mockNext);
      }

      expect(mockLlmService.generateJSONContent).toHaveBeenCalled();
      expect(mockLlmService.generateContent).toHaveBeenCalled();
      expect(crmDb.updateLead).toHaveBeenCalledWith('list1', 'lead-json-retry', {
        customFields: {
          web_company_info: 'Acme builds B2B software.',
        },
      });
      expect(mockResponse.json).toHaveBeenCalledWith(expect.objectContaining({
        success: true,
        processedCount: 1,
        failedCount: 0,
      }));
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

    it('should filter leads server-side when search query is provided', async () => {
      const mockList = {
        listId: 'list1',
        name: 'Test List',
        userId: 'test-user-id',
      };

      const mockLeads = [
        {
          leadId: 'lead1',
          email: 'john@example.com',
          firstName: 'John',
          lastName: 'Doe',
          company: 'Alpha Co',
          customFields: { role: 'Founder' },
        },
        {
          leadId: 'lead2',
          email: 'jane@example.com',
          firstName: 'Jane',
          lastName: 'Smith',
          company: 'Beta Co',
          customFields: { role: 'Designer' },
        },
      ];

      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockList);
      (crmDb.getLeadsByListId as jest.Mock).mockResolvedValue({
        items: mockLeads,
        lastEvaluatedKey: null,
        hasMore: false,
      });
      (crmDb.getLeadEngagementCount as jest.Mock).mockResolvedValue({
        total: 0,
        last7Days: 0,
        totalAllMessages: 0,
      });

      mockRequest.params = { listId: 'list1' };
      mockRequest.query = { page: '1', limit: '50', search: 'alpha' };

      const handler = router.stack.find((r: any) =>
        r.route?.path === '/lists/:listId/leads' && r.route?.methods?.get
      );
      if (handler && handler.route) {
        await handler.route.stack[0].handle(mockRequest as Request, mockResponse as Response, mockNext);
      }

      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          leads: expect.arrayContaining([
            expect.objectContaining({ leadId: 'lead1' }),
          ]),
          totalFilteredCount: 1,
        })
      );

      const responsePayload = (mockResponse.json as jest.Mock).mock.calls[0][0];
      expect(responsePayload.leads).toHaveLength(1);
      expect(responsePayload.leads[0].leadId).toBe('lead1');
    });

    it('should match search query against custom field keys and values', async () => {
      const mockList = {
        listId: 'list1',
        name: 'Test List',
        userId: 'test-user-id',
      };

      const mockLeads = [
        {
          leadId: 'lead1',
          email: 'john@example.com',
          customFields: { Industry: 'SaaS' },
        },
        {
          leadId: 'lead2',
          email: 'jane@example.com',
          customFields: { Title: 'Designer' },
        },
      ];

      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockList);
      (crmDb.getLeadsByListId as jest.Mock).mockResolvedValue({
        items: mockLeads,
        lastEvaluatedKey: null,
        hasMore: false,
      });
      (crmDb.getLeadEngagementCount as jest.Mock).mockResolvedValue({
        total: 0,
        last7Days: 0,
        totalAllMessages: 0,
      });

      mockRequest.params = { listId: 'list1' };
      mockRequest.query = { page: '1', limit: '50', search: 'industry' };

      const handler = router.stack.find((r: any) =>
        r.route?.path === '/lists/:listId/leads' && r.route?.methods?.get
      );
      if (handler && handler.route) {
        await handler.route.stack[0].handle(mockRequest as Request, mockResponse as Response, mockNext);
      }

      const responsePayload = (mockResponse.json as jest.Mock).mock.calls[0][0];
      expect(responsePayload.leads).toHaveLength(1);
      expect(responsePayload.leads[0].leadId).toBe('lead1');
      expect(responsePayload.totalFilteredCount).toBe(1);
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

  describe('PUT /api/crm/lists/:listId/auto-draft', () => {
    it('should update auto draft settings with instruction', async () => {
      const mockList = {
        listId: 'list1',
        name: 'Test List',
        userId: 'test-user-id',
      };

      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockList);
      (crmDb.updateLeadList as jest.Mock).mockResolvedValue({
        ...mockList,
        autoDraftEnabled: true,
        autoDraftInstruction: 'Use an urgent but friendly tone.',
      });

      mockRequest.params = { listId: 'list1' };
      mockRequest.body = { enabled: true, instruction: 'Use an urgent but friendly tone.' };

      const handler = router.stack.find((r: any) =>
        r.route?.path === '/lists/:listId/auto-draft' && r.route?.methods?.put
      );
      if (handler && handler.route) {
        await handler.route.stack[0].handle(mockRequest as Request, mockResponse as Response, mockNext);
      }

      expect(crmDb.updateLeadList).toHaveBeenCalledWith('list1', {
        autoDraftEnabled: true,
        autoDraftInstruction: 'Use an urgent but friendly tone.'
      });
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          autoDraftEnabled: true,
          autoDraftInstruction: 'Use an urgent but friendly tone.',
        })
      );
    });

    it('should return 400 when instruction is not a string', async () => {
      mockRequest.params = { listId: 'list1' };
      mockRequest.body = { enabled: true, instruction: 123 };

      const handler = router.stack.find((r: any) =>
        r.route?.path === '/lists/:listId/auto-draft' && r.route?.methods?.put
      );
      if (handler && handler.route) {
        await handler.route.stack[0].handle(mockRequest as Request, mockResponse as Response, mockNext);
      }

      expect(mockResponse.status).toHaveBeenCalledWith(400);
      expect(mockResponse.json).toHaveBeenCalledWith({ message: 'instruction must be a string' });
    });
  });

  describe('POST /api/crm/sync-subscribers', () => {
    const { taskDb, subscriberDb } = require('../services/db');

    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('should sync subscribers to CRM lead list', async () => {
      const mockTask = {
        taskId: 'task1',
        name: 'Test Task',
        userId: 'test-user-id',
      };

      const mockSubscribers = [
        {
          email: 'subscriber1@example.com',
          firstName: 'John',
          lastName: 'Doe',
          unsubscribed: false,
          subscribedAt: '2024-01-01T00:00:00Z',
        },
        {
          email: 'subscriber2@example.com',
          unsubscribed: true,
          subscribedAt: '2024-01-02T00:00:00Z',
        },
      ];

      const mockLeadList = {
        listId: 'list1',
        name: 'Test Task Subscribers',
        userId: 'test-user-id',
      };

      const mockBatchResult = {
        successCount: 2,
        newCount: 2,
        mergedCount: 0,
        errorCount: 0,
        errors: [],
      };

      (taskDb.getTaskById as jest.Mock).mockResolvedValue(mockTask);
      (subscriberDb.getAllTaskSubscribers as jest.Mock).mockResolvedValue(mockSubscribers);
      (crmDb.getLeadListsByUserId as jest.Mock).mockResolvedValue([]);
      (crmDb.createLeadList as jest.Mock).mockResolvedValue(mockLeadList);
      (crmDb.batchCreateLeads as jest.Mock).mockResolvedValue(mockBatchResult);

      mockRequest.method = 'POST';
      mockRequest.url = '/sync-subscribers';
      mockRequest.body = { taskId: 'task1' };

      const handler = router.stack.find((r: any) => 
        r.route?.path === '/sync-subscribers' && r.route?.methods?.post
      );
      if (handler && handler.route) {
        await handler.route.stack[0].handle(mockRequest as Request, mockResponse as Response, mockNext);
      }

      expect(taskDb.getTaskById).toHaveBeenCalledWith('task1');
      expect(subscriberDb.getAllTaskSubscribers).toHaveBeenCalledWith('task1');
      expect(crmDb.createLeadList).toHaveBeenCalledWith(
        'test-user-id',
        'Test Task Subscribers',
        'Subscribers synced from task: Test Task'
      );
      expect(crmDb.batchCreateLeads).toHaveBeenCalled();
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          listId: 'list1',
          listName: 'Test Task Subscribers',
          successCount: 2,
        })
      );
    });

    it('should use existing lead list if it exists', async () => {
      const mockTask = {
        taskId: 'task1',
        name: 'Test Task',
        userId: 'test-user-id',
      };

      const mockSubscribers = [
        {
          email: 'subscriber1@example.com',
          unsubscribed: false,
          subscribedAt: '2024-01-01T00:00:00Z',
        },
      ];

      const mockExistingList = {
        listId: 'existing-list',
        name: 'Test Task Subscribers',
        userId: 'test-user-id',
      };

      const mockBatchResult = {
        successCount: 1,
        newCount: 0,
        mergedCount: 1,
        errorCount: 0,
        errors: [],
      };

      (taskDb.getTaskById as jest.Mock).mockResolvedValue(mockTask);
      (subscriberDb.getAllTaskSubscribers as jest.Mock).mockResolvedValue(mockSubscribers);
      (crmDb.getLeadListsByUserId as jest.Mock).mockResolvedValue([mockExistingList]);
      (crmDb.batchCreateLeads as jest.Mock).mockResolvedValue(mockBatchResult);

      mockRequest.method = 'POST';
      mockRequest.url = '/sync-subscribers';
      mockRequest.body = { taskId: 'task1' };

      const handler = router.stack.find((r: any) => 
        r.route?.path === '/sync-subscribers' && r.route?.methods?.post
      );
      if (handler && handler.route) {
        await handler.route.stack[0].handle(mockRequest as Request, mockResponse as Response, mockNext);
      }

      expect(crmDb.createLeadList).not.toHaveBeenCalled();
      expect(crmDb.batchCreateLeads).toHaveBeenCalledWith('existing-list', expect.any(Array));
    });

    it('should return 400 if no subscribers to sync', async () => {
      const mockTask = {
        taskId: 'task1',
        name: 'Test Task',
        userId: 'test-user-id',
      };

      (taskDb.getTaskById as jest.Mock).mockResolvedValue(mockTask);
      (subscriberDb.getAllTaskSubscribers as jest.Mock).mockResolvedValue([]);

      mockRequest.method = 'POST';
      mockRequest.url = '/sync-subscribers';
      mockRequest.body = { taskId: 'task1' };

      const handler = router.stack.find((r: any) => 
        r.route?.path === '/sync-subscribers' && r.route?.methods?.post
      );
      if (handler && handler.route) {
        await handler.route.stack[0].handle(mockRequest as Request, mockResponse as Response, mockNext);
      }

      expect(mockResponse.status).toHaveBeenCalledWith(400);
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'No subscribers to sync',
        })
      );
    });

    it('should return 403 if user does not own the task', async () => {
      const mockTask = {
        taskId: 'task1',
        name: 'Test Task',
        userId: 'other-user-id',
      };

      (taskDb.getTaskById as jest.Mock).mockResolvedValue(mockTask);

      mockRequest.method = 'POST';
      mockRequest.url = '/sync-subscribers';
      mockRequest.body = { taskId: 'task1' };

      const handler = router.stack.find((r: any) => 
        r.route?.path === '/sync-subscribers' && r.route?.methods?.post
      );
      if (handler && handler.route) {
        await handler.route.stack[0].handle(mockRequest as Request, mockResponse as Response, mockNext);
      }

      expect(mockResponse.status).toHaveBeenCalledWith(403);
    });

    it('should include subscribed field in customFields', async () => {
      const mockTask = {
        taskId: 'task1',
        name: 'Test Task',
        userId: 'test-user-id',
      };

      const mockSubscribers = [
        {
          email: 'subscriber1@example.com',
          unsubscribed: false,
          subscribedAt: '2024-01-01T00:00:00Z',
        },
        {
          email: 'subscriber2@example.com',
          unsubscribed: true,
          subscribedAt: '2024-01-02T00:00:00Z',
        },
      ];

      const mockLeadList = {
        listId: 'list1',
        name: 'Test Task Subscribers',
        userId: 'test-user-id',
      };

      (taskDb.getTaskById as jest.Mock).mockResolvedValue(mockTask);
      (subscriberDb.getAllTaskSubscribers as jest.Mock).mockResolvedValue(mockSubscribers);
      (crmDb.getLeadListsByUserId as jest.Mock).mockResolvedValue([]);
      (crmDb.createLeadList as jest.Mock).mockResolvedValue(mockLeadList);
      (crmDb.batchCreateLeads as jest.Mock).mockResolvedValue({
        successCount: 2,
        newCount: 2,
        mergedCount: 0,
        errorCount: 0,
        errors: [],
      });

      mockRequest.method = 'POST';
      mockRequest.url = '/sync-subscribers';
      mockRequest.body = { taskId: 'task1' };

      const handler = router.stack.find((r: any) => 
        r.route?.path === '/sync-subscribers' && r.route?.methods?.post
      );
      if (handler && handler.route) {
        await handler.route.stack[0].handle(mockRequest as Request, mockResponse as Response, mockNext);
      }

      expect(crmDb.batchCreateLeads).toHaveBeenCalled();
      const leadsPassed = (crmDb.batchCreateLeads as jest.Mock).mock.calls[0][1];
      expect(leadsPassed[0].customFields.subscribed).toBe('yes');
      expect(leadsPassed[1].customFields.subscribed).toBe('no');
    });
  });
});
