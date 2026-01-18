import request from 'supertest';
import express from 'express';
import webhookRouter from '../routes/webhooks';
import { crmDb } from '../services/db';
import { leadListAlertService } from '../services/leadListAlertService';

// Mock dependencies
jest.mock('../services/db', () => ({
  crmDb: {
    getLeadListByApiKey: jest.fn(),
    createLead: jest.fn(),
  },
}));

jest.mock('../services/leadListAlertService', () => ({
  leadListAlertService: {
    notifyLeadListOwnerIfConfigured: jest.fn(),
  },
}));

jest.mock('../services/webhookService', () => ({
  webhookService: {
    initialize: jest.fn(),
    verifyWebhook: jest.fn(),
    extractEmailDomain: jest.fn(),
    generateEventId: jest.fn(),
  },
}));

jest.mock('../services/emailEventsDb', () => ({
  emailEventsDb: {
    eventExists: jest.fn(),
    addEmailEvent: jest.fn(),
  },
}));

const app = express();
app.use(express.json());
app.use('/api/webhooks', webhookRouter);

describe('Lead Forwarding API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /api/webhooks/forward-lead', () => {
    const validApiKey = 'aw_valid_key_123';
    const mockLeadList = {
      listId: 'list_123',
      userId: 'user_123',
      name: 'Test List',
      apiKey: validApiKey,
    };

    it('should reject requests without API key', async () => {
      const response = await request(app)
        .post('/api/webhooks/forward-lead')
        .send({
          email: 'test@example.com',
          firstName: 'John',
          lastName: 'Doe',
        });

      expect(response.status).toBe(401);
      expect(response.body.success).toBe(false);
      expect(response.body.message).toContain('API key is required');
    });

    it('should reject requests with invalid API key', async () => {
      (crmDb.getLeadListByApiKey as jest.Mock).mockResolvedValue(null);

      const response = await request(app)
        .post('/api/webhooks/forward-lead')
        .set('X-API-Key', 'invalid_key')
        .send({
          email: 'test@example.com',
          firstName: 'John',
          lastName: 'Doe',
        });

      expect(response.status).toBe(401);
      expect(response.body.success).toBe(false);
      expect(response.body.message).toBe('Invalid API key');
    });

    it('should reject requests without email', async () => {
      (crmDb.getLeadListByApiKey as jest.Mock).mockResolvedValue(mockLeadList);

      const response = await request(app)
        .post('/api/webhooks/forward-lead')
        .set('X-API-Key', validApiKey)
        .send({
          firstName: 'John',
          lastName: 'Doe',
        });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.message).toBe('Email is required');
    });

    it('should successfully forward a lead with minimal data', async () => {
      const mockLead = {
        leadId: 'lead_123',
        listId: 'list_123',
        email: 'test@example.com',
        firstName: '',
        lastName: '',
        customFields: {
          source: 'api',
          forwardedAt: expect.any(String),
        },
      };

      (crmDb.getLeadListByApiKey as jest.Mock).mockResolvedValue(mockLeadList);
      (crmDb.createLead as jest.Mock).mockResolvedValue(mockLead);

      const response = await request(app)
        .post('/api/webhooks/forward-lead')
        .set('X-API-Key', validApiKey)
        .send({
          email: 'test@example.com',
        });

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.leadId).toBe('lead_123');
      expect(response.body.listId).toBe('list_123');

      // Verify lead was created with correct data
      expect(crmDb.createLead).toHaveBeenCalledWith(
        'list_123',
        expect.objectContaining({
          email: 'test@example.com',
          customFields: expect.objectContaining({
            source: 'api',
            forwardedAt: expect.any(String),
          }),
        })
      );
    });

    it('should successfully forward a lead with full data', async () => {
      const mockLead = {
        leadId: 'lead_123',
        listId: 'list_123',
        email: 'john@example.com',
        firstName: 'John',
        lastName: 'Doe',
        phone: '+1234567890',
        company: 'Acme Corp',
        title: 'CEO',
        notes: 'Test notes',
        linkedin: 'https://linkedin.com/in/johndoe',
        customFields: {
          source: 'website_contact_form',
          forwardedAt: expect.any(String),
          campaign: 'spring2024',
        },
      };

      (crmDb.getLeadListByApiKey as jest.Mock).mockResolvedValue(mockLeadList);
      (crmDb.createLead as jest.Mock).mockResolvedValue(mockLead);

      const response = await request(app)
        .post('/api/webhooks/forward-lead')
        .set('X-API-Key', validApiKey)
        .send({
          email: 'john@example.com',
          firstName: 'John',
          lastName: 'Doe',
          phone: '+1234567890',
          company: 'Acme Corp',
          title: 'CEO',
          notes: 'Test notes',
          linkedin: 'https://linkedin.com/in/johndoe',
          source: 'website_contact_form',
          customFields: {
            campaign: 'spring2024',
          },
        });

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.leadId).toBe('lead_123');

      // Verify lead was created with correct data
      expect(crmDb.createLead).toHaveBeenCalledWith(
        'list_123',
        expect.objectContaining({
          email: 'john@example.com',
          firstName: 'John',
          lastName: 'Doe',
          phone: '+1234567890',
          company: 'Acme Corp',
          title: 'CEO',
          notes: 'Test notes',
          linkedin: 'https://linkedin.com/in/johndoe',
          customFields: expect.objectContaining({
            source: 'website_contact_form',
            forwardedAt: expect.any(String),
            campaign: 'spring2024',
          }),
        })
      );
    });

    it('should trigger api.lead_added alert on success', async () => {
      const mockLead = {
        leadId: 'lead_123',
        listId: 'list_123',
        email: 'test@example.com',
        firstName: 'John',
        lastName: 'Doe',
        customFields: {
          source: 'website',
          forwardedAt: expect.any(String),
        },
      };

      (crmDb.getLeadListByApiKey as jest.Mock).mockResolvedValue(mockLeadList);
      (crmDb.createLead as jest.Mock).mockResolvedValue(mockLead);

      const response = await request(app)
        .post('/api/webhooks/forward-lead')
        .set('X-API-Key', validApiKey)
        .send({
          email: 'test@example.com',
          firstName: 'John',
          lastName: 'Doe',
          source: 'website',
        });

      expect(response.status).toBe(201);
      expect(leadListAlertService.notifyLeadListOwnerIfConfigured).toHaveBeenCalledWith(
        mockLeadList,
        mockLead,
        'api.lead_added',
        expect.objectContaining({
          source: 'website',
          forwardedAt: expect.any(String),
        }),
        expect.any(String)
      );
    });

    it('should trigger api.lead_failed alert on error', async () => {
      (crmDb.getLeadListByApiKey as jest.Mock).mockResolvedValue(mockLeadList);
      (crmDb.createLead as jest.Mock).mockRejectedValue(new Error('Duplicate email'));

      const response = await request(app)
        .post('/api/webhooks/forward-lead')
        .set('X-API-Key', validApiKey)
        .send({
          email: 'test@example.com',
          firstName: 'John',
          source: 'website',
        });

      expect(response.status).toBe(500);
      expect(leadListAlertService.notifyLeadListOwnerIfConfigured).toHaveBeenCalledWith(
        mockLeadList,
        expect.objectContaining({
          leadId: 'failed',
          email: 'test@example.com',
        }),
        'api.lead_failed',
        expect.objectContaining({
          error: 'Duplicate email',
          source: 'website',
          email: 'test@example.com',
        }),
        expect.any(String)
      );
    });

    it('should handle duplicate email error gracefully', async () => {
      (crmDb.getLeadListByApiKey as jest.Mock).mockResolvedValue(mockLeadList);
      (crmDb.createLead as jest.Mock).mockRejectedValue(
        new Error('Lead with this email already exists')
      );

      const response = await request(app)
        .post('/api/webhooks/forward-lead')
        .set('X-API-Key', validApiKey)
        .send({
          email: 'test@example.com',
          firstName: 'John',
          lastName: 'Doe',
        });

      expect(response.status).toBe(409);
      expect(response.body.success).toBe(false);
      expect(response.body.message).toContain('already exists');
    });

    it('should accept API key in request body', async () => {
      const mockLead = {
        leadId: 'lead_123',
        listId: 'list_123',
        email: 'test@example.com',
      };

      (crmDb.getLeadListByApiKey as jest.Mock).mockResolvedValue(mockLeadList);
      (crmDb.createLead as jest.Mock).mockResolvedValue(mockLead);

      const response = await request(app)
        .post('/api/webhooks/forward-lead')
        .send({
          apiKey: validApiKey,
          email: 'test@example.com',
        });

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
    });

    it('should add forwardedAt timestamp to customFields', async () => {
      const beforeRequest = new Date().toISOString();

      const mockLead = {
        leadId: 'lead_123',
        listId: 'list_123',
        email: 'test@example.com',
      };

      (crmDb.getLeadListByApiKey as jest.Mock).mockResolvedValue(mockLeadList);
      (crmDb.createLead as jest.Mock).mockResolvedValue(mockLead);

      await request(app)
        .post('/api/webhooks/forward-lead')
        .set('X-API-Key', validApiKey)
        .send({
          email: 'test@example.com',
        });

      const afterRequest = new Date().toISOString();

      // Verify forwardedAt was added
      const createLeadCall = (crmDb.createLead as jest.Mock).mock.calls[0];
      const leadData = createLeadCall[1];
      expect(leadData.customFields.forwardedAt).toBeDefined();
      expect(leadData.customFields.forwardedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

      // Verify timestamp is reasonable (within test execution time)
      expect(leadData.customFields.forwardedAt >= beforeRequest).toBe(true);
      expect(leadData.customFields.forwardedAt <= afterRequest).toBe(true);
    });
  });
});
