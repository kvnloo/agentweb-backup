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

// Mock AWS config to prevent real DynamoDB connections during tests
jest.mock('../config/aws', () => ({
  dynamodb: {
    get: jest.fn().mockReturnValue({ promise: () => Promise.resolve({}) }),
    put: jest.fn().mockReturnValue({ promise: () => Promise.resolve({}) }),
    update: jest.fn().mockReturnValue({ promise: () => Promise.resolve({}) }),
    delete: jest.fn().mockReturnValue({ promise: () => Promise.resolve({}) }),
    query: jest.fn().mockReturnValue({ promise: () => Promise.resolve({ Items: [] }) }),
    scan: jest.fn().mockReturnValue({ promise: () => Promise.resolve({ Items: [] }) }),
  },
}));

import { Request, Response } from 'express';
import { crmDb, userDb } from '../services/db';
import { settingsService } from '../services/settingsService';
import { resendService } from '../services/resendService';
import { agentModeService } from '../services/agentModeService';
import { createLLMService } from '../utils/llmService';
import { emailEventsDb } from '../services/emailEventsDb';
import { validateLeadEmailInBackground } from '../services/enrichSoLeadValidation';
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
    updateSearchQueryTemplates: jest.fn().mockResolvedValue({}),
  },
  taskDb: {
    getTaskById: jest.fn(),
  },
  subscriberDb: {
    getAllTaskSubscribers: jest.fn(),
  },
  userDb: {
    getUserById: jest.fn(),
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
  }
}));
jest.mock('../services/enrichSoLeadValidation', () => ({
  validateLeadEmailInBackground: jest.fn(),
  validateLeadsInBackground: jest.fn(),
}));

const mockUploadFileToS3 = jest.fn();
jest.mock('../utils/s3Utils', () => ({
  uploadFileToS3: (...args: any[]) => mockUploadFileToS3(...args),
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
      
      expect(crmDb.createLeadList).toHaveBeenCalledWith('test-user-id', 'New List', 'Test description', undefined, null, false, undefined, undefined, undefined, undefined);
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
        false,
        undefined,
        undefined,
        undefined,
        undefined
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
        false,
        undefined,
        undefined,
        undefined,
        undefined
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

    it('should update engagedOnly for a lead list', async () => {
      const mockList = {
        listId: 'list1',
        name: 'Test List',
        userId: 'test-user-id',
      };

      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockList);
      (crmDb.getLeadsByListId as jest.Mock).mockResolvedValue({
        items: [],
        lastEvaluatedKey: null,
        hasMore: false,
      });
      (userDb.getUserById as jest.Mock).mockResolvedValue({
        userId: 'test-user-id',
        emailDomain: 'example.com',
      });
      (emailEventsDb.getEventsByEmailDomain as jest.Mock).mockResolvedValue([]);
      (crmDb.updateLeadList as jest.Mock).mockResolvedValue({
        ...mockList,
        engagedOnly: true,
      });

      mockRequest.params = { listId: 'list1' };
      mockRequest.body = { engagedOnly: true };

      const handler = router.stack.find((r: any) => r.route?.path === '/lists/:listId' && r.route?.methods?.put);
      if (handler && handler.route) {
        await handler.route.stack[0].handle(mockRequest as Request, mockResponse as Response, mockNext);
      }

      expect(crmDb.updateLeadList).toHaveBeenCalledWith('list1', {
        engagedOnly: true,
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

    it('should return 400 if engagedOnly is not a boolean', async () => {
      const mockList = {
        listId: 'list1',
        name: 'Test List',
        userId: 'test-user-id',
      };

      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockList);
      mockRequest.params = { listId: 'list1' };
      mockRequest.body = { engagedOnly: 'yes' };

      const handler = router.stack.find((r: any) => r.route?.path === '/lists/:listId' && r.route?.methods?.put);
      if (handler && handler.route) {
        await handler.route.stack[0].handle(mockRequest as Request, mockResponse as Response, mockNext);
      }

      expect(mockResponse.status).toHaveBeenCalledWith(400);
      expect(mockResponse.json).toHaveBeenCalledWith({ message: 'engagedOnly must be a boolean' });
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

    it('converts body.attribution into firstTouch + lastTouch, strips envelope', async () => {
      const mockList = { listId: 'list1', name: 'Test List', userId: 'test-user-id' };
      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockList);
      (crmDb.createLead as jest.Mock).mockResolvedValue({
        leadId: 'lead1',
        listId: 'list1',
        email: 'attr@example.com',
      });

      mockRequest.params = { listId: 'list1' };
      mockRequest.body = {
        email: 'attr@example.com',
        firstName: 'Ada',
        attribution: {
          timestamp: '2026-04-19T10:00:00.000Z',
          utm: { source: 'meta', medium: 'cpc', campaign: 'spring-2026' },
          landingUrl: 'https://agentweb.pro/?utm_source=meta',
        },
      };

      const handler = router.stack.find((r: any) =>
        r.route?.path === '/lists/:listId/leads' && r.route?.methods?.post
      );
      if (handler && handler.route) {
        await handler.route.stack[0].handle(mockRequest as Request, mockResponse as Response, mockNext);
      }

      expect(crmDb.createLead).toHaveBeenCalledWith(
        'list1',
        expect.objectContaining({
          email: 'attr@example.com',
          firstName: 'Ada',
          firstTouch: expect.objectContaining({
            utm: expect.objectContaining({ source: 'meta', medium: 'cpc' }),
          }),
          lastTouch: expect.objectContaining({
            utm: expect.objectContaining({ source: 'meta' }),
          }),
        })
      );
      // Envelope stripped so createLead doesn't see an unknown `attribution` key
      const call = (crmDb.createLead as jest.Mock).mock.calls[0][1];
      expect('attribution' in call).toBe(false);
      expect('utm' in call).toBe(false);
    });

    it('leaves firstTouch/lastTouch absent when no attribution is posted', async () => {
      const mockList = { listId: 'list1', name: 'Test List', userId: 'test-user-id' };
      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockList);
      (crmDb.createLead as jest.Mock).mockResolvedValue({
        leadId: 'lead1',
        listId: 'list1',
        email: 'plain@example.com',
      });

      mockRequest.params = { listId: 'list1' };
      mockRequest.body = { email: 'plain@example.com' };

      const handler = router.stack.find((r: any) =>
        r.route?.path === '/lists/:listId/leads' && r.route?.methods?.post
      );
      if (handler && handler.route) {
        await handler.route.stack[0].handle(mockRequest as Request, mockResponse as Response, mockNext);
      }

      const call = (crmDb.createLead as jest.Mock).mock.calls[0][1];
      expect(call.firstTouch).toBeUndefined();
      expect(call.lastTouch).toBeUndefined();
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

    it('triggers background email validation when email is updated', async () => {
      const mockList = {
        listId: 'list1',
        name: 'Test List',
        userId: 'test-user-id',
      };
      const updatedLead = {
        leadId: 'lead1',
        listId: 'list1',
        email: 'new@example.com',
      };
      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockList);
      (crmDb.updateLead as jest.Mock).mockResolvedValue(updatedLead);

      mockRequest.params = { listId: 'list1', leadId: 'lead1' };
      mockRequest.body = { email: 'new@example.com' };

      const handler = router.stack.find((r: any) =>
        r.route?.path === '/lists/:listId/leads/:leadId' && r.route?.methods?.put
      );
      if (handler && handler.route) {
        await handler.route.stack[0].handle(mockRequest as Request, mockResponse as Response, mockNext);
      }

      expect(crmDb.updateLead).toHaveBeenCalledWith('list1', 'lead1', expect.objectContaining({ email: 'new@example.com' }));
      expect(validateLeadEmailInBackground).toHaveBeenCalledWith('list1', 'lead1', 'new@example.com', 'test-user-id');
      expect(mockResponse.json).toHaveBeenCalledWith(updatedLead);
    });
  });

  describe('POST /api/crm/lists/:listId/leads/match-icps', () => {
    const findMatchIcpsPostHandler = () => router.stack.find((r: any) =>
      r.route?.path === '/lists/:listId/leads/match-icps' && r.route?.methods?.post
    );

    it('should use gpt-5.2-chat for ICP matching', async () => {
      const mockList = {
        listId: 'list1',
        name: 'Test List',
        userId: 'test-user-id',
      };

      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockList);
      (userDb.getUserById as jest.Mock).mockResolvedValue({
        userId: 'test-user-id',
        marketStrategy: {
          businessOverview: 'B2B SaaS',
          icp: [
            {
              title: 'SaaS founders',
              description: 'Early-stage SaaS founders',
              valueProposition: 'Automation',
            },
          ],
        },
      });
      (crmDb.getLeadsByListId as jest.Mock).mockResolvedValue({
        items: [
          {
            leadId: 'lead1',
            firstName: 'John',
            lastName: 'Doe',
            email: 'john@example.com',
            company: 'Acme',
            title: 'Founder',
          },
        ],
        lastEvaluatedKey: null,
      });

      const mockLlmService = {
        generateJSONContent: jest.fn().mockResolvedValue([
          {
            index: 1,
            categoryMatches: [
              {
                icpTitle: 'SaaS founders',
                isMatch: true,
                score: 88,
                reason: 'Founder aligns with ICP.',
              },
            ],
          },
        ]),
      };
      (createLLMService as jest.Mock).mockReturnValue(mockLlmService);

      mockRequest.params = { listId: 'list1' };
      mockRequest.query = { mode: 'match' };
      mockRequest.body = {};

      const handler = findMatchIcpsPostHandler();
      if (handler && handler.route) {
        await handler.route.stack[0].handle(mockRequest as Request, mockResponse as Response, mockNext);
      }

      expect(createLLMService).toHaveBeenCalledWith('gpt-5.2-chat', 1);
      expect(crmDb.updateLead).toHaveBeenCalledWith('list1', 'lead1', {
        icpMatch: {
          isMatch: true,   // score 88 >= threshold 70
          score: 88,
          reason: 'Founder aligns with ICP.',
          matchedIcpTitle: 'SaaS founders',
          matchedAt: expect.any(String),
          categoryMatches: [
            {
              icpTitle: 'SaaS founders',
              isMatch: true,
              score: 88,
              reason: 'Founder aligns with ICP.',
            },
          ],
        },
      });
      expect(mockResponse.json).toHaveBeenCalledWith(expect.objectContaining({
        success: true,
        processedCount: 1,
      }));
    });

    it('should clamp out-of-range scores to 0-100', async () => {
      const mockList = { listId: 'list1', name: 'Test List', userId: 'test-user-id' };
      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockList);
      (userDb.getUserById as jest.Mock).mockResolvedValue({
        userId: 'test-user-id',
        marketStrategy: {
          businessOverview: 'B2B SaaS',
          icp: [{ title: 'SaaS founders', description: 'Early-stage', valueProposition: 'Automation' }],
        },
      });
      (crmDb.getLeadsByListId as jest.Mock).mockResolvedValue({
        items: [{ leadId: 'lead1', firstName: 'John', lastName: 'Doe', email: 'john@example.com' }],
        lastEvaluatedKey: null,
      });

      const mockLlmService = {
        generateJSONContent: jest.fn().mockResolvedValue([
          {
            index: 1,
            categoryMatches: [
              { icpTitle: 'SaaS founders', isMatch: true, score: 150, reason: 'Over max score.' },
            ],
          },
        ]),
      };
      (createLLMService as jest.Mock).mockReturnValue(mockLlmService);

      mockRequest.params = { listId: 'list1' };
      mockRequest.query = { mode: 'match' };
      mockRequest.body = {};

      const handler = findMatchIcpsPostHandler();
      if (handler && handler.route) {
        await handler.route.stack[0].handle(mockRequest as Request, mockResponse as Response, mockNext);
      }

      expect(crmDb.updateLead).toHaveBeenCalledWith('list1', 'lead1', expect.objectContaining({
        icpMatch: expect.objectContaining({ score: 100 }),
      }));
    });

    it('should use fallback reason when LLM returns empty categoryMatches', async () => {
      const mockList = { listId: 'list1', name: 'Test List', userId: 'test-user-id' };
      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockList);
      (userDb.getUserById as jest.Mock).mockResolvedValue({
        userId: 'test-user-id',
        marketStrategy: {
          businessOverview: 'B2B SaaS',
          icp: [{ title: 'SaaS founders', description: 'Early-stage', valueProposition: 'Automation' }],
        },
      });
      (crmDb.getLeadsByListId as jest.Mock).mockResolvedValue({
        items: [{ leadId: 'lead1', firstName: 'John', lastName: 'Doe', email: 'john@example.com' }],
        lastEvaluatedKey: null,
      });

      const mockLlmService = {
        generateJSONContent: jest.fn().mockResolvedValue([
          { index: 1, categoryMatches: [] },
        ]),
      };
      (createLLMService as jest.Mock).mockReturnValue(mockLlmService);

      mockRequest.params = { listId: 'list1' };
      mockRequest.query = { mode: 'match' };
      mockRequest.body = {};

      const handler = findMatchIcpsPostHandler();
      if (handler && handler.route) {
        await handler.route.stack[0].handle(mockRequest as Request, mockResponse as Response, mockNext);
      }

      expect(crmDb.updateLead).toHaveBeenCalledWith('list1', 'lead1', expect.objectContaining({
        icpMatch: expect.objectContaining({
          isMatch: false,
          score: 0,
          reason: 'Insufficient lead data to evaluate against ICP categories.',
        }),
      }));
    });

    it('persists isMatch=false and no matchedIcpTitle when winner score is below threshold', async () => {
      // Coverage gap from initial PR: winner exists but score < 70.
      // matchedIcpTitle must stay undefined so the frontend doesn't render a
      // stale title on a non-match.
      const mockList = { listId: 'list1', name: 'Test List', userId: 'test-user-id' };
      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockList);
      (userDb.getUserById as jest.Mock).mockResolvedValue({
        userId: 'test-user-id',
        marketStrategy: {
          businessOverview: 'B2B SaaS',
          icp: [{ title: 'SaaS founders', description: 'Early-stage', valueProposition: 'Automation' }],
        },
      });
      (crmDb.getLeadsByListId as jest.Mock).mockResolvedValue({
        items: [{ leadId: 'lead1', firstName: 'John', lastName: 'Doe', email: 'john@example.com' }],
        lastEvaluatedKey: null,
      });

      const mockLlmService = {
        generateJSONContent: jest.fn().mockResolvedValue([
          {
            index: 1,
            categoryMatches: [
              { icpTitle: 'SaaS founders', isMatch: false, score: 50, reason: 'Wrong segment.' },
            ],
          },
        ]),
      };
      (createLLMService as jest.Mock).mockReturnValue(mockLlmService);

      mockRequest.params = { listId: 'list1' };
      mockRequest.query = { mode: 'match' };
      mockRequest.body = {};

      const handler = findMatchIcpsPostHandler();
      if (handler && handler.route) {
        await handler.route.stack[0].handle(mockRequest as Request, mockResponse as Response, mockNext);
      }

      const updateCall = (crmDb.updateLead as jest.Mock).mock.calls[0][2];
      expect(updateCall.icpMatch.isMatch).toBe(false);
      expect(updateCall.icpMatch.score).toBe(50);
      expect(updateCall.icpMatch.matchedIcpTitle).toBeUndefined();
    });

    it('coerces non-numeric scores (string, NaN) to 0 so DDB writes do not fail', async () => {
      // `cat.score ?? 0` only catches null/undefined. A string like "high" or
      // NaN survives the ?? then poisons Math.max with NaN, which would crash
      // the DDB write for the whole chunk. Coercion must use Number.isFinite.
      const mockList = { listId: 'list1', name: 'Test List', userId: 'test-user-id' };
      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockList);
      (userDb.getUserById as jest.Mock).mockResolvedValue({
        userId: 'test-user-id',
        marketStrategy: {
          businessOverview: 'B2B SaaS',
          icp: [{ title: 'SaaS founders', description: 'Early-stage', valueProposition: 'Automation' }],
        },
      });
      (crmDb.getLeadsByListId as jest.Mock).mockResolvedValue({
        items: [{ leadId: 'lead1', firstName: 'John', lastName: 'Doe', email: 'john@example.com' }],
        lastEvaluatedKey: null,
      });

      const mockLlmService = {
        generateJSONContent: jest.fn().mockResolvedValue([
          {
            index: 1,
            categoryMatches: [
              { icpTitle: 'SaaS founders', isMatch: false, score: 'high' as unknown as number, reason: 'LLM hallucinated string score.' },
            ],
          },
        ]),
      };
      (createLLMService as jest.Mock).mockReturnValue(mockLlmService);

      mockRequest.params = { listId: 'list1' };
      mockRequest.query = { mode: 'match' };
      mockRequest.body = {};

      const handler = findMatchIcpsPostHandler();
      if (handler && handler.route) {
        await handler.route.stack[0].handle(mockRequest as Request, mockResponse as Response, mockNext);
      }

      const updateCall = (crmDb.updateLead as jest.Mock).mock.calls[0][2];
      expect(updateCall.icpMatch.score).toBe(0);
      expect(Number.isNaN(updateCall.icpMatch.score)).toBe(false);
      // Stored categoryMatches must also have the coerced score so the
      // frontend doesn't read NaN out of DynamoDB later.
      expect(updateCall.icpMatch.categoryMatches[0].score).toBe(0);
    });
  });

  describe('POST /api/crm/lists/:listId/leads/enrich-web', () => {
    const findEnrichWebPostHandler = () => router.stack.find((r: any) =>
      r.route?.path === '/lists/:listId/leads/enrich-web' && r.route?.methods?.post
    );

    const mockPreview = jest.fn();
    const mockExecute = jest.fn();

    jest.mock('../services/crmEnrichmentService', () => ({
      CrmEnrichmentService: jest.fn().mockImplementation(() => ({
        preview: mockPreview,
        execute: mockExecute,
      })),
    }));

    it('should return preview counts', async () => {
      const mockList = {
        listId: 'list1',
        name: 'Test List',
        userId: 'test-user-id',
      };

      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockList);

      mockPreview.mockResolvedValue({
        totalLeads: 3,
        leadsToProcess: 1,
        alreadyEnriched: 1,
        samples: [{ leadId: 'lead1', lead: { email: 'a@test.com' }, enrichedFields: { web_company_info: 'Info' } }],
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
        leadsToProcess: 1,
        alreadyEnrichedCount: 1,
      }));
    });

    it('should delegate to CrmEnrichmentService.execute for enrich mode', async () => {
      const mockList = {
        listId: 'list1',
        name: 'Test List',
        userId: 'test-user-id',
      };

      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockList);

      mockExecute.mockResolvedValue({
        processedCount: 3,
        failedCount: 1,
        totalToProcess: 4,
        failureBreakdown: { searchWebFailed: 1, linkedinFailed: 0, llmOrParseFailed: 0, updateFailed: 0 },
      });

      mockRequest.params = { listId: 'list1' };
      mockRequest.query = { mode: 'enrich' };
      mockRequest.body = { socketId: 'sock-1', forceEnrich: true };

      const handler = findEnrichWebPostHandler();
      if (handler && handler.route) {
        await handler.route.stack[0].handle(mockRequest as Request, mockResponse as Response, mockNext);
      }

      expect(mockResponse.json).toHaveBeenCalledWith(expect.objectContaining({
        success: true,
        processedCount: 3,
        failedCount: 1,
      }));
    });

    it('should persist config after preview mode', async () => {
      (crmDb.getLeadListById as jest.Mock).mockResolvedValue({ listId: 'list1', userId: 'test-user-id' });
      (crmDb.updateSearchQueryTemplates as jest.Mock).mockResolvedValue({});
      mockPreview.mockResolvedValue({
        totalLeads: 2,
        leadsToProcess: 2,
        alreadyEnriched: 0,
        samples: [],
      });

      mockRequest.params = { listId: 'list1' };
      mockRequest.query = { mode: 'preview' };
      mockRequest.body = {
        instruction: 'Find company info',
        outputFields: ['company_info'],
        sources: ['web_search', 'linkedin'],
        webSearchTemplate: '{{company}} overview',
        linkedinSearchTemplate: '{{firstName}} {{company}}',
        sourcesPerField: { company_info: ['web_search'] },
      };

      const handler = findEnrichWebPostHandler();
      if (handler && handler.route) {
        await handler.route.stack[0].handle(mockRequest as Request, mockResponse as Response, mockNext);
      }

      // Allow fire-and-forget promise to settle
      await Promise.resolve();

      expect(crmDb.updateSearchQueryTemplates).toHaveBeenCalledWith(
        'list1',
        {},
        { company_info: ['web_search'] },
        'Find company info',
        ['company_info'],
        '{{company}} overview',
        '{{firstName}} {{company}}',
        ['web_search', 'linkedin'],
        undefined,
      );
    });

    it('should persist config after enrich mode', async () => {
      (crmDb.getLeadListById as jest.Mock).mockResolvedValue({ listId: 'list1', userId: 'test-user-id' });
      (crmDb.updateSearchQueryTemplates as jest.Mock).mockResolvedValue({});
      mockExecute.mockResolvedValue({
        processedCount: 1,
        failedCount: 0,
        totalToProcess: 1,
        failureBreakdown: { searchWebFailed: 0, linkedinFailed: 0, llmOrParseFailed: 0, updateFailed: 0 },
      });

      mockRequest.params = { listId: 'list1' };
      mockRequest.query = { mode: 'enrich' };
      mockRequest.body = {
        instruction: 'Find funding data',
        outputFields: ['funding_stage'],
        sources: ['web_search'],
      };

      const handler = findEnrichWebPostHandler();
      if (handler && handler.route) {
        await handler.route.stack[0].handle(mockRequest as Request, mockResponse as Response, mockNext);
      }

      await Promise.resolve();

      expect(crmDb.updateSearchQueryTemplates).toHaveBeenCalledWith(
        'list1',
        {},
        undefined,
        'Find funding data',
        ['funding_stage'],
        undefined,
        undefined,
        ['web_search'],
        undefined,
      );
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

    it('should filter leads server-side when engagedOnly is enabled', async () => {
      const mockList = {
        listId: 'list1',
        name: 'Test List',
        userId: 'test-user-id',
        engagedOnly: true,
      };

      const mockLeads = [
        { leadId: 'lead1', email: 'engaged@example.com', engagements: [] },
        { leadId: 'lead2', email: 'cold@example.com', engagements: [] },
      ];

      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockList);
      (crmDb.getLeadsByListId as jest.Mock).mockResolvedValue({
        items: mockLeads,
        lastEvaluatedKey: null,
        hasMore: false,
      });
      (crmDb.getLeadsByEngagedFlag as jest.Mock).mockResolvedValue({
        items: mockLeads,
        lastEvaluatedKey: null,
        hasMore: false,
      });
      (userDb.getUserById as jest.Mock).mockResolvedValue({
        userId: 'test-user-id',
        emailDomain: 'example.com',
      });
      (emailEventsDb.getEventsByEmailDomain as jest.Mock).mockResolvedValue([
        {
          eventType: 'email.clicked',
          leadEmail: 'engaged@example.com',
          data: {},
        },
      ]);
      (crmDb.getLeadEngagementCount as jest.Mock).mockResolvedValue({
        total: 1,
        last7Days: 1,
        totalAllMessages: 1,
      });

      mockRequest.params = { listId: 'list1' };
      mockRequest.query = { page: '1', limit: '50' };

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
      expect(emailEventsDb.getEventsByEmailDomain).toHaveBeenCalledWith('example.com');
      expect(emailEventsDb.getEventsByEmailDomain).toHaveBeenCalledWith('linkedin-list1');
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
        mergedCount: 0,
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
          mergedCount: 0,
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
      (userDb.getUserById as jest.Mock).mockResolvedValue({ connected_accounts: [] });

      const handler = router.stack.find((r: any) =>
        r.route?.path === '/sender-emails' && r.route?.methods?.get
      );
      if (handler && handler.route) {
        await handler.route.stack[0].handle(mockRequest as Request, mockResponse as Response, mockNext);
      }

      expect(mockResponse.json).toHaveBeenCalledWith({
        senders: [],
        defaultSenderId: null,
        connectedGmailAccounts: [],
      });
    });

    it('should include defaultLinkedInAccountId from stored config', async () => {
      const mockSetting = {
        settingName: 'crm_sender_emails_test-user-id',
        settingValue: JSON.stringify({
          senders: [],
          defaultSenderId: null,
          defaultLinkedInAccountId: 'linkedin-acc-42',
        }),
      };
      (settingsService.getSetting as jest.Mock).mockResolvedValue(mockSetting);

      const handler = router.stack.find((r: any) =>
        r.route?.path === '/sender-emails' && r.route?.methods?.get
      );
      if (handler && handler.route) {
        await handler.route.stack[0].handle(mockRequest as Request, mockResponse as Response, mockNext);
      }

      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({ defaultLinkedInAccountId: 'linkedin-acc-42' })
      );
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

    it('should save defaultLinkedInAccountId when provided', async () => {
      (settingsService.setSetting as jest.Mock).mockResolvedValue(undefined);

      mockRequest.body = {
        senders: [{ id: '1', email: 'sender@example.com', fromName: 'Sender' }],
        defaultSenderId: '1',
        defaultLinkedInAccountId: 'li-acc-xyz',
      };

      const handler = router.stack.find((r: any) =>
        r.route?.path === '/sender-emails' && r.route?.methods?.post
      );
      if (handler && handler.route) {
        await handler.route.stack[0].handle(mockRequest as Request, mockResponse as Response, mockNext);
      }

      expect(settingsService.setSetting).toHaveBeenCalled();
      const savedConfig = JSON.parse((settingsService.setSetting as jest.Mock).mock.calls[0][1]);
      expect(savedConfig.defaultLinkedInAccountId).toBe('li-acc-xyz');
    });

    it('should return 400 if defaultLinkedInAccountId is not a string', async () => {
      mockRequest.body = {
        senders: [{ id: '1', email: 'sender@example.com', fromName: 'Sender' }],
        defaultLinkedInAccountId: 12345,
      };

      const handler = router.stack.find((r: any) =>
        r.route?.path === '/sender-emails' && r.route?.methods?.post
      );
      if (handler && handler.route) {
        await handler.route.stack[0].handle(mockRequest as Request, mockResponse as Response, mockNext);
      }

      expect(mockResponse.status).toHaveBeenCalledWith(400);
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

    it('should accept autoSendEnabled parameter', async () => {
      const mockList = {
        listId: 'list1',
        name: 'Test List',
        userId: 'test-user-id',
      };

      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockList);
      (crmDb.updateLeadList as jest.Mock).mockResolvedValue({
        ...mockList,
        autoDraftEnabled: true,
        autoDraftInstruction: '',
        autoSendEnabled: true,
      });

      mockRequest.params = { listId: 'list1' };
      mockRequest.body = { enabled: true, autoSendEnabled: true };

      const handler = router.stack.find((r: any) =>
        r.route?.path === '/lists/:listId/auto-draft' && r.route?.methods?.put
      );
      if (handler && handler.route) {
        await handler.route.stack[0].handle(mockRequest as Request, mockResponse as Response, mockNext);
      }

      expect(crmDb.updateLeadList).toHaveBeenCalledWith('list1', expect.objectContaining({
        autoDraftEnabled: true,
        autoSendEnabled: true,
      }));
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          autoDraftEnabled: true,
          autoSendEnabled: true,
        })
      );
    });

    it('should return 400 when autoSendEnabled is not a boolean', async () => {
      mockRequest.params = { listId: 'list1' };
      mockRequest.body = { enabled: true, autoSendEnabled: 'yes' };

      const handler = router.stack.find((r: any) =>
        r.route?.path === '/lists/:listId/auto-draft' && r.route?.methods?.put
      );
      if (handler && handler.route) {
        await handler.route.stack[0].handle(mockRequest as Request, mockResponse as Response, mockNext);
      }

      expect(mockResponse.status).toHaveBeenCalledWith(400);
      expect(mockResponse.json).toHaveBeenCalledWith({ message: 'autoSendEnabled must be a boolean' });
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

  describe('POST /api/crm/lists/:listId/leads/export', () => {
    it('should export leads to CSV and return export entry', async () => {
      const mockList = {
        listId: 'list1',
        name: 'Test List',
        userId: 'test-user-id',
        fieldNames: ['email', 'firstName', 'customField1'],
        csvExportHistory: [],
      };

      const mockLeads = [
        { leadId: 'lead1', email: 'john@example.com', firstName: 'John', lastName: 'Doe', customFields: { customField1: 'value1' } },
        { leadId: 'lead2', email: 'jane@example.com', firstName: 'Jane', lastName: 'Smith', customFields: { customField1: 'value2' } },
      ];

      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockList);
      (crmDb.getLeadsByListId as jest.Mock).mockResolvedValue({
        items: mockLeads,
        lastEvaluatedKey: null,
        hasMore: false,
      });
      (crmDb.updateLeadList as jest.Mock).mockResolvedValue({});
      mockUploadFileToS3.mockResolvedValue({
        success: true,
        url: 'https://s3.amazonaws.com/bucket/test-export.csv',
        key: 'test-export.csv',
      });

      mockRequest.params = { listId: 'list1' };
      mockRequest.body = {};

      const handler = router.stack.find((r: any) =>
        r.route?.path === '/lists/:listId/leads/export' && r.route?.methods?.post
      );
      if (handler && handler.route) {
        await handler.route.stack[0].handle(mockRequest as Request, mockResponse as Response, mockNext);
      }

      expect(crmDb.getLeadsByListId).toHaveBeenCalledWith('list1', 200, undefined);
      expect(mockUploadFileToS3).toHaveBeenCalledWith(
        expect.any(Buffer),
        expect.stringContaining('Test_List_export_'),
        'test-user-id',
        'text/csv'
      );
      expect(crmDb.updateLeadList).toHaveBeenCalledWith('list1', {
        csvExportHistory: expect.arrayContaining([
          expect.objectContaining({
            recordCount: 2,
            fileUrl: 'https://s3.amazonaws.com/bucket/test-export.csv',
          }),
        ]),
      });
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          export: expect.objectContaining({
            recordCount: 2,
            fileUrl: 'https://s3.amazonaws.com/bucket/test-export.csv',
          }),
        })
      );
    });

    it('should return 400 if no leads to export', async () => {
      const mockList = {
        listId: 'list1',
        name: 'Test List',
        userId: 'test-user-id',
      };

      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockList);
      (crmDb.getLeadsByListId as jest.Mock).mockResolvedValue({
        items: [],
        lastEvaluatedKey: null,
        hasMore: false,
      });

      mockRequest.params = { listId: 'list1' };
      mockRequest.body = {};

      const handler = router.stack.find((r: any) =>
        r.route?.path === '/lists/:listId/leads/export' && r.route?.methods?.post
      );
      if (handler && handler.route) {
        await handler.route.stack[0].handle(mockRequest as Request, mockResponse as Response, mockNext);
      }

      expect(mockResponse.status).toHaveBeenCalledWith(400);
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'No leads to export' })
      );
    });

    it('should return 403 if user does not own the list', async () => {
      const mockList = {
        listId: 'list1',
        name: 'Test List',
        userId: 'other-user-id',
      };

      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockList);

      mockRequest.params = { listId: 'list1' };
      mockRequest.body = {};

      const handler = router.stack.find((r: any) =>
        r.route?.path === '/lists/:listId/leads/export' && r.route?.methods?.post
      );
      if (handler && handler.route) {
        await handler.route.stack[0].handle(mockRequest as Request, mockResponse as Response, mockNext);
      }

      expect(mockResponse.status).toHaveBeenCalledWith(403);
    });

    it('should return 404 if list not found', async () => {
      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(null);

      mockRequest.params = { listId: 'nonexistent' };
      mockRequest.body = {};

      const handler = router.stack.find((r: any) =>
        r.route?.path === '/lists/:listId/leads/export' && r.route?.methods?.post
      );
      if (handler && handler.route) {
        await handler.route.stack[0].handle(mockRequest as Request, mockResponse as Response, mockNext);
      }

      expect(mockResponse.status).toHaveBeenCalledWith(404);
    });

    it('should cap export history at 50 entries', async () => {
      const existingHistory = Array.from({ length: 50 }, (_, i) => ({
        exportId: `exp_old_${i}`,
        recordCount: 5,
        exportedAt: '2026-01-01T00:00:00.000Z',
        fileUrl: `https://s3.amazonaws.com/bucket/old_${i}.csv`,
        filename: `old_${i}.csv`,
      }));

      const mockList = {
        listId: 'list1',
        name: 'Test List',
        userId: 'test-user-id',
        csvExportHistory: existingHistory,
      };

      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockList);
      (crmDb.getLeadsByListId as jest.Mock).mockResolvedValue({
        items: [{ leadId: 'lead1', email: 'test@example.com', firstName: 'Test' }],
        lastEvaluatedKey: null,
        hasMore: false,
      });
      (crmDb.updateLeadList as jest.Mock).mockResolvedValue({});
      mockUploadFileToS3.mockResolvedValue({
        success: true,
        url: 'https://s3.amazonaws.com/bucket/new-export.csv',
        key: 'new-export.csv',
      });

      mockRequest.params = { listId: 'list1' };
      mockRequest.body = {};

      const handler = router.stack.find((r: any) =>
        r.route?.path === '/lists/:listId/leads/export' && r.route?.methods?.post
      );
      if (handler && handler.route) {
        await handler.route.stack[0].handle(mockRequest as Request, mockResponse as Response, mockNext);
      }

      const updateCall = (crmDb.updateLeadList as jest.Mock).mock.calls[0];
      const updatedHistory = updateCall[1].csvExportHistory;
      expect(updatedHistory).toHaveLength(50);
      expect(updatedHistory[0].fileUrl).toBe('https://s3.amazonaws.com/bucket/new-export.csv');
    });

    it('should return 500 if S3 upload fails', async () => {
      const mockList = {
        listId: 'list1',
        name: 'Test List',
        userId: 'test-user-id',
      };

      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockList);
      (crmDb.getLeadsByListId as jest.Mock).mockResolvedValue({
        items: [{ leadId: 'lead1', email: 'test@example.com', firstName: 'Test' }],
        lastEvaluatedKey: null,
        hasMore: false,
      });
      mockUploadFileToS3.mockResolvedValue({
        success: false,
        error: 'Upload failed',
      });

      mockRequest.params = { listId: 'list1' };
      mockRequest.body = {};

      const handler = router.stack.find((r: any) =>
        r.route?.path === '/lists/:listId/leads/export' && r.route?.methods?.post
      );
      if (handler && handler.route) {
        await handler.route.stack[0].handle(mockRequest as Request, mockResponse as Response, mockNext);
      }

      expect(mockResponse.status).toHaveBeenCalledWith(500);
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Failed to upload CSV to storage' })
      );
    });
  });

  describe('GET /api/crm/lists/:listId/export-history', () => {
    it('should return export history for a list', async () => {
      const mockHistory = [
        {
          exportId: 'exp_1',
          recordCount: 10,
          exportedAt: '2026-02-18T00:00:00.000Z',
          fileUrl: 'https://s3.amazonaws.com/bucket/export.csv',
          filename: 'export.csv',
        },
      ];

      const mockList = {
        listId: 'list1',
        name: 'Test List',
        userId: 'test-user-id',
        csvExportHistory: mockHistory,
      };

      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockList);

      mockRequest.params = { listId: 'list1' };

      const handler = router.stack.find((r: any) =>
        r.route?.path === '/lists/:listId/export-history' && r.route?.methods?.get
      );
      if (handler && handler.route) {
        await handler.route.stack[0].handle(mockRequest as Request, mockResponse as Response, mockNext);
      }

      expect(mockResponse.json).toHaveBeenCalledWith({ history: mockHistory });
    });

    it('should return empty array when no export history exists', async () => {
      const mockList = {
        listId: 'list1',
        name: 'Test List',
        userId: 'test-user-id',
      };

      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockList);

      mockRequest.params = { listId: 'list1' };

      const handler = router.stack.find((r: any) =>
        r.route?.path === '/lists/:listId/export-history' && r.route?.methods?.get
      );
      if (handler && handler.route) {
        await handler.route.stack[0].handle(mockRequest as Request, mockResponse as Response, mockNext);
      }

      expect(mockResponse.json).toHaveBeenCalledWith({ history: [] });
    });

    it('should return 403 if user does not own the list', async () => {
      const mockList = {
        listId: 'list1',
        name: 'Test List',
        userId: 'other-user-id',
      };

      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockList);

      mockRequest.params = { listId: 'list1' };

      const handler = router.stack.find((r: any) =>
        r.route?.path === '/lists/:listId/export-history' && r.route?.methods?.get
      );
      if (handler && handler.route) {
        await handler.route.stack[0].handle(mockRequest as Request, mockResponse as Response, mockNext);
      }

      expect(mockResponse.status).toHaveBeenCalledWith(403);
    });

    it('should return 404 if list not found', async () => {
      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(null);

      mockRequest.params = { listId: 'nonexistent' };

      const handler = router.stack.find((r: any) =>
        r.route?.path === '/lists/:listId/export-history' && r.route?.methods?.get
      );
      if (handler && handler.route) {
        await handler.route.stack[0].handle(mockRequest as Request, mockResponse as Response, mockNext);
      }

      expect(mockResponse.status).toHaveBeenCalledWith(404);
    });
  });

  describe('PUT /api/crm/lists/:listId - statusConfig', () => {
    it('should update statusConfig for a lead list', async () => {
      const mockList = {
        listId: 'list1',
        name: 'Test List',
        userId: 'test-user-id',
      };

      const statusConfig = [
        { value: 'new', label: 'New', color: 'gray', type: 'active' },
        { value: 'won', label: 'Won', color: 'green', type: 'won' },
      ];

      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockList);
      (crmDb.updateLeadList as jest.Mock).mockResolvedValue({ ...mockList, statusConfig });

      mockRequest.params = { listId: 'list1' };
      mockRequest.body = { statusConfig };

      const handler = router.stack.find((r: any) => r.route?.path === '/lists/:listId' && r.route?.methods?.put);
      if (handler && handler.route) {
        await handler.route.stack[0].handle(mockRequest as Request, mockResponse as Response, mockNext);
      }

      expect(crmDb.updateLeadList).toHaveBeenCalledWith('list1', { statusConfig });
    });

    it('should return 400 if statusConfig is not an array', async () => {
      const mockList = { listId: 'list1', name: 'Test', userId: 'test-user-id' };
      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockList);

      mockRequest.params = { listId: 'list1' };
      mockRequest.body = { statusConfig: 'not-an-array' };

      const handler = router.stack.find((r: any) => r.route?.path === '/lists/:listId' && r.route?.methods?.put);
      if (handler && handler.route) {
        await handler.route.stack[0].handle(mockRequest as Request, mockResponse as Response, mockNext);
      }

      expect(mockResponse.status).toHaveBeenCalledWith(400);
      expect(mockResponse.json).toHaveBeenCalledWith({ message: 'statusConfig must be an array' });
    });

    it('should return 400 if statusConfig entry missing required fields', async () => {
      const mockList = { listId: 'list1', name: 'Test', userId: 'test-user-id' };
      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockList);

      mockRequest.params = { listId: 'list1' };
      mockRequest.body = { statusConfig: [{ value: 'new', label: 'New' }] };

      const handler = router.stack.find((r: any) => r.route?.path === '/lists/:listId' && r.route?.methods?.put);
      if (handler && handler.route) {
        await handler.route.stack[0].handle(mockRequest as Request, mockResponse as Response, mockNext);
      }

      expect(mockResponse.status).toHaveBeenCalledWith(400);
      expect(mockResponse.json).toHaveBeenCalledWith({ message: 'Each statusConfig entry must have value, label, color, and type' });
    });

    it('should return 400 if statusConfig type is invalid', async () => {
      const mockList = { listId: 'list1', name: 'Test', userId: 'test-user-id' };
      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockList);

      mockRequest.params = { listId: 'list1' };
      mockRequest.body = { statusConfig: [{ value: 'x', label: 'X', color: 'gray', type: 'invalid' }] };

      const handler = router.stack.find((r: any) => r.route?.path === '/lists/:listId' && r.route?.methods?.put);
      if (handler && handler.route) {
        await handler.route.stack[0].handle(mockRequest as Request, mockResponse as Response, mockNext);
      }

      expect(mockResponse.status).toHaveBeenCalledWith(400);
      expect(mockResponse.json).toHaveBeenCalledWith({ message: 'statusConfig type must be one of: active, won, lost, churned' });
    });
  });

  describe('PUT /api/crm/lists/:listId - listType', () => {
    it('should set listType when not already set', async () => {
      const mockList = { listId: 'list1', name: 'Test', userId: 'test-user-id' };
      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockList);
      (crmDb.updateLeadList as jest.Mock).mockResolvedValue({ ...mockList, listType: 'customers' });

      mockRequest.params = { listId: 'list1' };
      mockRequest.body = { listType: 'customers' };

      const handler = router.stack.find((r: any) => r.route?.path === '/lists/:listId' && r.route?.methods?.put);
      if (handler && handler.route) {
        await handler.route.stack[0].handle(mockRequest as Request, mockResponse as Response, mockNext);
      }

      expect(crmDb.updateLeadList).toHaveBeenCalledWith('list1', { listType: 'customers' });
    });

    it('should return 400 if listType already set', async () => {
      const mockList = { listId: 'list1', name: 'Test', userId: 'test-user-id', listType: 'sales' };
      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockList);

      mockRequest.params = { listId: 'list1' };
      mockRequest.body = { listType: 'customers' };

      const handler = router.stack.find((r: any) => r.route?.path === '/lists/:listId' && r.route?.methods?.put);
      if (handler && handler.route) {
        await handler.route.stack[0].handle(mockRequest as Request, mockResponse as Response, mockNext);
      }

      expect(mockResponse.status).toHaveBeenCalledWith(400);
      expect(mockResponse.json).toHaveBeenCalledWith({ message: 'listType is already set and cannot be changed' });
    });

    it('should return 400 if listType is invalid', async () => {
      const mockList = { listId: 'list1', name: 'Test', userId: 'test-user-id' };
      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockList);

      mockRequest.params = { listId: 'list1' };
      mockRequest.body = { listType: 'invalid' };

      const handler = router.stack.find((r: any) => r.route?.path === '/lists/:listId' && r.route?.methods?.put);
      if (handler && handler.route) {
        await handler.route.stack[0].handle(mockRequest as Request, mockResponse as Response, mockNext);
      }

      expect(mockResponse.status).toHaveBeenCalledWith(400);
      expect(mockResponse.json).toHaveBeenCalledWith({ message: 'listType must be "sales" or "customers"' });
    });
  });

  describe('PUT /api/crm/lists/:listId/leads/:leadId - status change', () => {
    it('should create status.changed engagement when status changes', async () => {
      const mockList = { listId: 'list1', name: 'Test', userId: 'test-user-id' };
      const existingLead = { leadId: 'lead1', status: 'new', email: 'test@example.com' };

      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockList);
      (crmDb.getLeadById as jest.Mock).mockResolvedValue(existingLead);
      (crmDb.updateLead as jest.Mock).mockResolvedValue({ ...existingLead, status: 'qualified' });
      (crmDb.addLeadEngagement as jest.Mock).mockResolvedValue({});

      mockRequest.params = { listId: 'list1', leadId: 'lead1' };
      mockRequest.body = { status: 'qualified' };

      const handler = router.stack.find((r: any) =>
        r.route?.path === '/lists/:listId/leads/:leadId' && r.route?.methods?.put
      );
      if (handler && handler.route) {
        await handler.route.stack[0].handle(mockRequest as Request, mockResponse as Response, mockNext);
      }

      expect(crmDb.addLeadEngagement).toHaveBeenCalledWith('list1', 'lead1', expect.objectContaining({
        eventType: 'status.changed',
        eventData: expect.objectContaining({
          from: 'new',
          to: 'qualified',
        }),
      }));
      expect(crmDb.updateLead).toHaveBeenCalled();
    });

    it('should not create engagement when status is unchanged', async () => {
      const mockList = { listId: 'list1', name: 'Test', userId: 'test-user-id' };
      const existingLead = { leadId: 'lead1', status: 'new', email: 'test@example.com' };

      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockList);
      (crmDb.getLeadById as jest.Mock).mockResolvedValue(existingLead);
      (crmDb.updateLead as jest.Mock).mockResolvedValue(existingLead);

      mockRequest.params = { listId: 'list1', leadId: 'lead1' };
      mockRequest.body = { status: 'new' };

      const handler = router.stack.find((r: any) =>
        r.route?.path === '/lists/:listId/leads/:leadId' && r.route?.methods?.put
      );
      if (handler && handler.route) {
        await handler.route.stack[0].handle(mockRequest as Request, mockResponse as Response, mockNext);
      }

      expect(crmDb.addLeadEngagement).not.toHaveBeenCalled();
      expect(crmDb.updateLead).toHaveBeenCalled();
    });

    it('should update lead with dealValue and dealCurrency', async () => {
      const mockList = { listId: 'list1', name: 'Test', userId: 'test-user-id' };
      const existingLead = { leadId: 'lead1', status: 'negotiating', email: 'test@example.com' };

      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockList);
      (crmDb.getLeadById as jest.Mock).mockResolvedValue(existingLead);
      (crmDb.updateLead as jest.Mock).mockResolvedValue({ ...existingLead, status: 'won', dealValue: 10000, dealCurrency: 'USD' });
      (crmDb.addLeadEngagement as jest.Mock).mockResolvedValue({});

      mockRequest.params = { listId: 'list1', leadId: 'lead1' };
      mockRequest.body = { status: 'won', dealValue: 10000, dealCurrency: 'USD' };

      const handler = router.stack.find((r: any) =>
        r.route?.path === '/lists/:listId/leads/:leadId' && r.route?.methods?.put
      );
      if (handler && handler.route) {
        await handler.route.stack[0].handle(mockRequest as Request, mockResponse as Response, mockNext);
      }

      expect(crmDb.addLeadEngagement).toHaveBeenCalledWith('list1', 'lead1', expect.objectContaining({
        eventType: 'status.changed',
        eventData: expect.objectContaining({
          from: 'negotiating',
          to: 'won',
          dealValue: 10000,
          dealCurrency: 'USD',
        }),
      }));
      expect(crmDb.updateLead).toHaveBeenCalledWith('list1', 'lead1', expect.objectContaining({
        status: 'won',
        dealValue: 10000,
        dealCurrency: 'USD',
      }));
    });
  });

  describe('POST /api/crm/lists/:listId/leads/:leadId/fields/:field/reject', () => {
    const findRejectHandler = () => router.stack.find((r: any) =>
      r.route?.path === '/lists/:listId/leads/:leadId/fields/:field/reject' && r.route?.methods?.post
    );

    it('preserves a custom field value (does not null out customFields[field]) when marked wrong', async () => {
      const mockList = { listId: 'list1', name: 'Test', userId: 'test-user-id' };
      const existingLead = {
        leadId: 'lead1',
        email: 'a@b.com',
        customFields: { funding_stage: 'Series B', industry: 'SaaS' },
        enrichmentMetadata: { funding_stage: { provider: 'enrich.so' } },
      };

      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockList);
      (crmDb.getLeadById as jest.Mock).mockResolvedValue(existingLead);
      (crmDb.updateLead as jest.Mock).mockResolvedValue(existingLead);

      mockRequest.params = { listId: 'list1', leadId: 'lead1', field: 'funding_stage' };
      mockRequest.body = { reason: 'outdated' };

      const handler = findRejectHandler();
      if (handler && handler.route) {
        await handler.route.stack[0].handle(mockRequest as Request, mockResponse as Response, mockNext);
      }

      const updateCall = (crmDb.updateLead as jest.Mock).mock.calls[0];
      expect(updateCall).toBeDefined();
      const updates = updateCall[2];
      expect(updates).not.toHaveProperty('customFields');
    });

    it('stamps enrichmentMetadata[field] with rejectedReason and rejectedAt while preserving prior metadata', async () => {
      const mockList = { listId: 'list1', name: 'Test', userId: 'test-user-id' };
      const priorMeta = { provider: 'enrich.so', enrichedAt: '2026-01-01T00:00:00.000Z', sourceQuote: 'q' };
      const existingLead = {
        leadId: 'lead1',
        email: 'a@b.com',
        customFields: { funding_stage: 'Series B' },
        enrichmentMetadata: { funding_stage: priorMeta, industry: { provider: 'web' } },
      };

      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockList);
      (crmDb.getLeadById as jest.Mock).mockResolvedValue(existingLead);
      (crmDb.updateLead as jest.Mock).mockResolvedValue(existingLead);

      mockRequest.params = { listId: 'list1', leadId: 'lead1', field: 'funding_stage' };
      mockRequest.body = { reason: 'outdated' };

      const handler = findRejectHandler();
      if (handler && handler.route) {
        await handler.route.stack[0].handle(mockRequest as Request, mockResponse as Response, mockNext);
      }

      const updates = (crmDb.updateLead as jest.Mock).mock.calls[0][2];
      expect(updates.enrichmentMetadata.funding_stage).toEqual(expect.objectContaining({
        ...priorMeta,
        rejectedReason: 'outdated',
        rejectedAt: expect.any(String),
      }));
      // prior metadata for other fields is preserved
      expect(updates.enrichmentMetadata.industry).toEqual({ provider: 'web' });
    });

    it("defaults rejectedReason to 'user-rejected' when no reason is provided", async () => {
      const mockList = { listId: 'list1', name: 'Test', userId: 'test-user-id' };
      const existingLead = {
        leadId: 'lead1',
        email: 'a@b.com',
        customFields: { funding_stage: 'Series B' },
        enrichmentMetadata: {},
      };

      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockList);
      (crmDb.getLeadById as jest.Mock).mockResolvedValue(existingLead);
      (crmDb.updateLead as jest.Mock).mockResolvedValue(existingLead);

      mockRequest.params = { listId: 'list1', leadId: 'lead1', field: 'funding_stage' };
      mockRequest.body = {};

      const handler = findRejectHandler();
      if (handler && handler.route) {
        await handler.route.stack[0].handle(mockRequest as Request, mockResponse as Response, mockNext);
      }

      const updates = (crmDb.updateLead as jest.Mock).mock.calls[0][2];
      expect(updates.enrichmentMetadata.funding_stage.rejectedReason).toBe('user-rejected');
    });

    it('strips a prior verifiedBy stamp when re-marking the same field wrong', async () => {
      const mockList = { listId: 'list1', name: 'Test', userId: 'test-user-id' };
      const priorMeta = {
        provider: 'enrich.so',
        sourceUrl: 'https://x.example',
        verifiedBy: { userId: 'someone', at: '2026-01-01T00:00:00.000Z' },
      };
      const existingLead = {
        leadId: 'lead1',
        customFields: { funding_stage: 'Series B' },
        enrichmentMetadata: { funding_stage: priorMeta },
      };

      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockList);
      (crmDb.getLeadById as jest.Mock).mockResolvedValue(existingLead);
      (crmDb.updateLead as jest.Mock).mockResolvedValue(existingLead);

      mockRequest.params = { listId: 'list1', leadId: 'lead1', field: 'funding_stage' };
      mockRequest.body = { reason: 'changed-my-mind' };

      const handler = findRejectHandler();
      if (handler && handler.route) {
        await handler.route.stack[0].handle(mockRequest as Request, mockResponse as Response, mockNext);
      }

      const updated = (crmDb.updateLead as jest.Mock).mock.calls[0][2].enrichmentMetadata.funding_stage;
      expect(updated).not.toHaveProperty('verifiedBy');
      expect(updated.rejectedReason).toBe('changed-my-mind');
      expect(updated.provider).toBe('enrich.so');
      expect(updated.sourceUrl).toBe('https://x.example');
    });
  });

  describe('POST /api/crm/lists/:listId/leads/:leadId/fields/:field/verify', () => {
    const findVerifyHandler = () => router.stack.find((r: any) =>
      r.route?.path === '/lists/:listId/leads/:leadId/fields/:field/verify' && r.route?.methods?.post
    );

    it('stamps verifiedBy with userId and timestamp on a fresh field', async () => {
      const mockList = { listId: 'list1', name: 'Test', userId: 'test-user-id' };
      const existingLead = {
        leadId: 'lead1',
        customFields: { funding_stage: 'Series B' },
        enrichmentMetadata: { funding_stage: { provider: 'enrich.so' } },
      };

      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockList);
      (crmDb.getLeadById as jest.Mock).mockResolvedValue(existingLead);
      (crmDb.updateLead as jest.Mock).mockResolvedValue(existingLead);

      mockRequest.params = { listId: 'list1', leadId: 'lead1', field: 'funding_stage' };
      mockRequest.body = {};

      const handler = findVerifyHandler();
      if (handler && handler.route) {
        await handler.route.stack[0].handle(mockRequest as Request, mockResponse as Response, mockNext);
      }

      const updated = (crmDb.updateLead as jest.Mock).mock.calls[0][2].enrichmentMetadata.funding_stage;
      expect(updated.verifiedBy).toEqual({ userId: 'test-user-id', at: expect.any(String) });
      expect(updated.provider).toBe('enrich.so');
    });

    it('strips prior rejectedReason and rejectedAt when verifying a previously-wrong field', async () => {
      const mockList = { listId: 'list1', name: 'Test', userId: 'test-user-id' };
      const priorMeta = {
        provider: 'enrich.so',
        sourceUrl: 'https://x.example',
        rejectedReason: 'marked-wrong',
        rejectedAt: '2026-01-01T00:00:00.000Z',
      };
      const existingLead = {
        leadId: 'lead1',
        customFields: { funding_stage: 'Series B' },
        enrichmentMetadata: { funding_stage: priorMeta },
      };

      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockList);
      (crmDb.getLeadById as jest.Mock).mockResolvedValue(existingLead);
      (crmDb.updateLead as jest.Mock).mockResolvedValue(existingLead);

      mockRequest.params = { listId: 'list1', leadId: 'lead1', field: 'funding_stage' };
      mockRequest.body = {};

      const handler = findVerifyHandler();
      if (handler && handler.route) {
        await handler.route.stack[0].handle(mockRequest as Request, mockResponse as Response, mockNext);
      }

      const updated = (crmDb.updateLead as jest.Mock).mock.calls[0][2].enrichmentMetadata.funding_stage;
      expect(updated).not.toHaveProperty('rejectedReason');
      expect(updated).not.toHaveProperty('rejectedAt');
      expect(updated.verifiedBy).toEqual({ userId: 'test-user-id', at: expect.any(String) });
      expect(updated.provider).toBe('enrich.so');
      expect(updated.sourceUrl).toBe('https://x.example');
    });

    it('does not affect metadata for other fields on the lead', async () => {
      const mockList = { listId: 'list1', name: 'Test', userId: 'test-user-id' };
      const existingLead = {
        leadId: 'lead1',
        customFields: {},
        enrichmentMetadata: {
          funding_stage: { provider: 'enrich.so' },
          industry:      { provider: 'web', rejectedAt: '2026-01-01T00:00:00.000Z' },
        },
      };

      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockList);
      (crmDb.getLeadById as jest.Mock).mockResolvedValue(existingLead);
      (crmDb.updateLead as jest.Mock).mockResolvedValue(existingLead);

      mockRequest.params = { listId: 'list1', leadId: 'lead1', field: 'funding_stage' };
      mockRequest.body = {};

      const handler = findVerifyHandler();
      if (handler && handler.route) {
        await handler.route.stack[0].handle(mockRequest as Request, mockResponse as Response, mockNext);
      }

      const updatedMeta = (crmDb.updateLead as jest.Mock).mock.calls[0][2].enrichmentMetadata;
      // Other field's reject stamp must NOT be cleared by a verify on a sibling.
      expect(updatedMeta.industry).toEqual({ provider: 'web', rejectedAt: '2026-01-01T00:00:00.000Z' });
    });
  });

  describe('GET /api/crm/lists/:listId/leads - status filtering', () => {
    it('should use status GSI when status filter is provided alone', async () => {
      const mockList = { listId: 'list1', name: 'Test', userId: 'test-user-id' };
      const mockLeads = [
        { leadId: 'lead1', email: 'a@test.com', status: 'qualified' },
        { leadId: 'lead2', email: 'b@test.com', status: 'qualified' },
      ];

      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockList);
      (crmDb.getLeadsByStatus as jest.Mock).mockResolvedValue({
        items: mockLeads,
        lastEvaluatedKey: null,
        hasMore: false,
      });
      (crmDb.getLeadEngagementCount as jest.Mock).mockResolvedValue({
        total: 0, last7Days: 0, totalAllMessages: 0,
      });

      mockRequest.params = { listId: 'list1' };
      mockRequest.query = { page: '1', limit: '50', status: 'qualified' };

      const handler = router.stack.find((r: any) =>
        r.route?.path === '/lists/:listId/leads' && r.route?.methods?.get
      );
      if (handler && handler.route) {
        await handler.route.stack[0].handle(mockRequest as Request, mockResponse as Response, mockNext);
      }

      expect(crmDb.getLeadsByStatus).toHaveBeenCalledWith('list1', 'qualified', expect.any(Number), undefined);
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          leads: expect.arrayContaining([
            expect.objectContaining({ leadId: 'lead1' }),
            expect.objectContaining({ leadId: 'lead2' }),
          ]),
          totalFilteredCount: 2,
        })
      );
    });

    it('should filter by status in-memory when combined with ICP filter', async () => {
      const mockList = { listId: 'list1', name: 'Test', userId: 'test-user-id', icpsOnly: true };
      const mockLeads = [
        { leadId: 'lead1', email: 'a@test.com', status: 'qualified', isICP: 1 },
        { leadId: 'lead2', email: 'b@test.com', status: 'new', isICP: 1 },
      ];

      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockList);
      (crmDb.getLeadsByICPFlag as jest.Mock).mockResolvedValue({
        items: mockLeads,
        lastEvaluatedKey: null,
        hasMore: false,
      });
      (crmDb.getLeadEngagementCount as jest.Mock).mockResolvedValue({
        total: 0, last7Days: 0, totalAllMessages: 0,
      });

      mockRequest.params = { listId: 'list1' };
      mockRequest.query = { page: '1', limit: '50', status: 'qualified' };

      const handler = router.stack.find((r: any) =>
        r.route?.path === '/lists/:listId/leads' && r.route?.methods?.get
      );
      if (handler && handler.route) {
        await handler.route.stack[0].handle(mockRequest as Request, mockResponse as Response, mockNext);
      }

      // Should use ICP index, not status index
      expect(crmDb.getLeadsByICPFlag).toHaveBeenCalled();
      expect(crmDb.getLeadsByStatus).not.toHaveBeenCalled();

      const responsePayload = (mockResponse.json as jest.Mock).mock.calls[0][0];
      expect(responsePayload.leads).toHaveLength(1);
      expect(responsePayload.leads[0].leadId).toBe('lead1');
      expect(responsePayload.totalFilteredCount).toBe(1);
    });
  });
});
