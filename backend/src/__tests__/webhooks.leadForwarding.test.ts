import request from 'supertest';
import express from 'express';
import webhookRouter from '../routes/webhooks';
import { crmDb } from '../services/db';
import { leadListAlertService } from '../services/leadListAlertService';
import { agentModeService } from '../services/agentModeService';
import { resendService } from '../services/resendService';

// Mock dependencies
jest.mock('../services/db', () => ({
  crmDb: {
    getLeadListById: jest.fn(),
    getLeadByEmail: jest.fn(),
    createLead: jest.fn(),
    updateLead: jest.fn(),
    getLeadById: jest.fn(),
  },
}));

jest.mock('../services/leadListAlertService', () => ({
  leadListAlertService: {
    notifyLeadListOwnerIfConfigured: jest.fn(),
  },
}));

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    updateEmailDraftForLead: jest.fn(),
    getCrmSenders: jest.fn(),
    queueLinkedInConnectionForLead: jest.fn(),
  },
}));

jest.mock('../services/resendService', () => ({
  resendService: {
    sendEmail: jest.fn(),
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

describe('Lead Forwarding API (List ID Authentication)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (crmDb.getLeadByEmail as jest.Mock).mockResolvedValue(null);
    (crmDb.updateLead as jest.Mock).mockResolvedValue(undefined);
    (agentModeService.updateEmailDraftForLead as jest.Mock).mockResolvedValue({
      success: true,
      message: 'Email and message drafts created successfully',
    });
  });

  describe('POST /api/webhooks/forward-lead', () => {
    const mockLeadList = {
      listId: 'list_123',
      userId: 'user_123',
      name: 'Test List',
      publicAccessEnabled: true,
      autoDraftEnabled: true,
    };

    it('should reject requests without listId', async () => {
      const response = await request(app)
        .post('/api/webhooks/forward-lead')
        .send({
          email: 'test@example.com',
          firstName: 'John',
          lastName: 'Doe',
        });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.message).toContain('listId is required');
    });

    it('should reject requests with non-existent listId', async () => {
      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(null);

      const response = await request(app)
        .post('/api/webhooks/forward-lead')
        .send({
          listId: 'list_nonexistent',
          email: 'test@example.com',
          firstName: 'John',
          lastName: 'Doe',
        });

      expect(response.status).toBe(404);
      expect(response.body.success).toBe(false);
      expect(response.body.message).toBe('Lead list not found');
    });

    it('should reject requests when public access is disabled', async () => {
      (crmDb.getLeadListById as jest.Mock).mockResolvedValue({
        ...mockLeadList,
        publicAccessEnabled: false,
      });

      const response = await request(app)
        .post('/api/webhooks/forward-lead')
        .send({
          listId: 'list_123',
          email: 'test@example.com',
          firstName: 'John',
          lastName: 'Doe',
        });

      expect(response.status).toBe(403);
      expect(response.body.success).toBe(false);
      expect(response.body.message).toContain('Public access is not enabled');
    });

    it('should reject requests when public access is undefined (default disabled)', async () => {
      (crmDb.getLeadListById as jest.Mock).mockResolvedValue({
        listId: 'list_123',
        userId: 'user_123',
        name: 'Test List',
        // publicAccessEnabled: undefined (not set)
      });

      const response = await request(app)
        .post('/api/webhooks/forward-lead')
        .send({
          listId: 'list_123',
          email: 'test@example.com',
        });

      expect(response.status).toBe(403);
      expect(response.body.success).toBe(false);
    });

    it('should reject requests without email', async () => {
      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockLeadList);

      const response = await request(app)
        .post('/api/webhooks/forward-lead')
        .send({
          listId: 'list_123',
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

      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockLeadList);
      (crmDb.createLead as jest.Mock).mockResolvedValue(mockLead);

      const response = await request(app)
        .post('/api/webhooks/forward-lead')
        .send({
          listId: 'list_123',
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

      expect(agentModeService.updateEmailDraftForLead).toHaveBeenCalledWith(
        'list_123',
        'lead_123',
        expect.stringContaining('Create an initial outreach message for this new lead'),
        expect.stringMatching(/^auto_draft_/),
        'user_123',
        'text'
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

      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockLeadList);
      (crmDb.createLead as jest.Mock).mockResolvedValue(mockLead);

      const response = await request(app)
        .post('/api/webhooks/forward-lead')
        .send({
          listId: 'list_123',
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

    it('should merge and return lead.updated when lead with same email exists', async () => {
      const existingLead = {
        leadId: 'lead_existing',
        listId: 'list_123',
        email: 'test@example.com',
        firstName: 'Old',
        lastName: 'Name',
        phone: '',
        company: 'Old Corp',
        title: '',
        notes: '',
        linkedin: '',
        customFields: { source: 'manual' },
      };

      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockLeadList);
      (crmDb.getLeadByEmail as jest.Mock).mockResolvedValue(existingLead);

      const response = await request(app)
        .post('/api/webhooks/forward-lead')
        .send({
          listId: 'list_123',
          email: 'test@example.com',
          firstName: 'John',
          lastName: 'Doe',
          company: 'New Corp',
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.event).toBe('lead.updated');
      expect(response.body.leadId).toBe('lead_existing');

      // Should NOT create a new lead
      expect(crmDb.createLead).not.toHaveBeenCalled();

      // Should update the existing lead with merged data
      expect(crmDb.updateLead).toHaveBeenCalledWith(
        'list_123',
        'lead_existing',
        expect.objectContaining({
          firstName: 'John',
          lastName: 'Doe',
          company: 'New Corp',
        })
      );

      // Should trigger auto draft for updated leads (autoDraftEnabled is true on mockLeadList)
      expect(agentModeService.updateEmailDraftForLead).toHaveBeenCalledWith(
        'list_123',
        'lead_existing',
        expect.any(String),
        expect.stringMatching(/^auto_draft_/),
        'user_123',
        'text'
      );
    });

    it('should return lead.unchanged and not fire alert or draft when same record sent twice', async () => {
      const existingLead = {
        leadId: 'lead_existing',
        listId: 'list_123',
        email: 'test@example.com',
        firstName: 'John',
        lastName: 'Doe',
        phone: '',
        company: '',
        title: '',
        notes: '',
        linkedin: '',
        customFields: { source: 'api' },
      };

      // Even with autoDraftEnabled on, unchanged leads should NOT trigger drafts
      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockLeadList);
      (crmDb.getLeadByEmail as jest.Mock).mockResolvedValue(existingLead);

      const response = await request(app)
        .post('/api/webhooks/forward-lead')
        .send({
          listId: 'list_123',
          email: 'test@example.com',
          firstName: 'John',
          lastName: 'Doe',
        });

      expect(response.status).toBe(200);
      expect(response.body.event).toBe('lead.unchanged');
      expect(response.body.leadId).toBe('lead_existing');
      expect(crmDb.updateLead).not.toHaveBeenCalled();
      expect(crmDb.createLead).not.toHaveBeenCalled();
      expect(agentModeService.updateEmailDraftForLead).not.toHaveBeenCalled();
      expect(leadListAlertService.notifyLeadListOwnerIfConfigured).not.toHaveBeenCalled();
    });

    it('should not create auto draft when autoDraftEnabled is off', async () => {
      const leadListWithoutAutoDraft = {
        ...mockLeadList,
        autoDraftEnabled: false,
      };
      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(leadListWithoutAutoDraft);
      (crmDb.createLead as jest.Mock).mockResolvedValue({
        leadId: 'lead_999',
        listId: 'list_123',
        email: 'no-draft@example.com',
      });

      const response = await request(app)
        .post('/api/webhooks/forward-lead')
        .send({
          listId: 'list_123',
          email: 'no-draft@example.com',
        });

      expect(response.status).toBe(201);
      expect(agentModeService.updateEmailDraftForLead).not.toHaveBeenCalled();
    });

    it('should include configured auto draft instruction when creating draft', async () => {
      const leadListWithInstruction = {
        ...mockLeadList,
        autoDraftEnabled: true,
        autoDraftInstruction: 'Mention the ROI benchmark from the attached case study.',
      };
      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(leadListWithInstruction);
      (crmDb.createLead as jest.Mock).mockResolvedValue({
        leadId: 'lead_555',
        listId: 'list_123',
        email: 'with-instruction@example.com',
      });

      const response = await request(app)
        .post('/api/webhooks/forward-lead')
        .send({
          listId: 'list_123',
          email: 'with-instruction@example.com',
          source: 'landing_page',
        });

      expect(response.status).toBe(201);
      expect(agentModeService.updateEmailDraftForLead).toHaveBeenCalledWith(
        'list_123',
        'lead_555',
        expect.stringContaining('Mention the ROI benchmark from the attached case study.'),
        expect.stringMatching(/^auto_draft_/),
        'user_123',
        'text'
      );
    });

    it('should return response without waiting for auto draft completion', async () => {
      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockLeadList);
      (crmDb.createLead as jest.Mock).mockResolvedValue({
        leadId: 'lead_async',
        listId: 'list_123',
        email: 'async@example.com',
      });

      (agentModeService.updateEmailDraftForLead as jest.Mock).mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve({ success: true }), 1000))
      );

      const responsePromise = request(app)
        .post('/api/webhooks/forward-lead')
        .send({
          listId: 'list_123',
          email: 'async@example.com',
        });

      const raceResult = await Promise.race([
        responsePromise.then(() => 'response'),
        new Promise((resolve) => setTimeout(() => resolve('timeout'), 150)),
      ]);

      expect(raceResult).toBe('response');
      const response = await responsePromise;
      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(agentModeService.updateEmailDraftForLead).toHaveBeenCalled();
    });

    it('should include CORS headers in response', async () => {
      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockLeadList);
      (crmDb.createLead as jest.Mock).mockResolvedValue({
        leadId: 'lead_123',
        listId: 'list_123',
        email: 'test@example.com',
      });

      const response = await request(app)
        .post('/api/webhooks/forward-lead')
        .send({
          listId: 'list_123',
          email: 'test@example.com',
        });

      expect(response.headers['access-control-allow-origin']).toBe('*');
      expect(response.headers['access-control-allow-methods']).toContain('POST');
    });

    describe('Warmly Webhook Payload Mapping', () => {
      it('should map Warmly payload fields to Lead schema when source is warmly', async () => {
        const mockLead = {
          leadId: 'lead_warmly_1',
          listId: 'list_123',
          email: 'visitor@company.com',
          firstName: 'Jane',
          lastName: 'Smith',
          company: 'Acme Inc',
          title: 'VP Marketing',
          linkedin: 'https://linkedin.com/in/janesmith',
          customFields: {
            source: 'warmly',
            warmly_visitor_id: 'wv_abc123',
            pages_viewed: ['/pricing', '/demo'],
            time_on_site: 342,
            forwardedAt: expect.any(String),
          },
        };

        (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockLeadList);
        (crmDb.createLead as jest.Mock).mockResolvedValue(mockLead);

        const response = await request(app)
          .post('/api/webhooks/forward-lead')
          .send({
            listId: 'list_123',
            source: 'warmly',
            warmly_visitor_id: 'wv_abc123',
            visitor_email: 'visitor@company.com',
            visitor_first_name: 'Jane',
            visitor_last_name: 'Smith',
            visitor_company: 'Acme Inc',
            visitor_title: 'VP Marketing',
            visitor_linkedin_url: 'https://linkedin.com/in/janesmith',
            visitor_phone: '+1987654321',
            pages_viewed: ['/pricing', '/demo'],
            time_on_site: 342,
          });

        expect(response.status).toBe(201);
        expect(response.body.success).toBe(true);

        expect(crmDb.createLead).toHaveBeenCalledWith(
          'list_123',
          expect.objectContaining({
            email: 'visitor@company.com',
            firstName: 'Jane',
            lastName: 'Smith',
            company: 'Acme Inc',
            title: 'VP Marketing',
            linkedin: 'https://linkedin.com/in/janesmith',
            phone: '+1987654321',
            customFields: expect.objectContaining({
              source: 'warmly',
              warmly_visitor_id: 'wv_abc123',
              pages_viewed: ['/pricing', '/demo'],
              time_on_site: 342,
            }),
          })
        );
      });

      it('should detect Warmly payload by warmly_visitor_id field even without explicit source', async () => {
        const mockLead = {
          leadId: 'lead_warmly_2',
          listId: 'list_123',
          email: 'auto-detect@company.com',
          firstName: 'Bob',
          lastName: '',
          customFields: {
            source: 'warmly',
            warmly_visitor_id: 'wv_xyz789',
            forwardedAt: expect.any(String),
          },
        };

        (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockLeadList);
        (crmDb.createLead as jest.Mock).mockResolvedValue(mockLead);

        const response = await request(app)
          .post('/api/webhooks/forward-lead')
          .send({
            listId: 'list_123',
            warmly_visitor_id: 'wv_xyz789',
            visitor_email: 'auto-detect@company.com',
            visitor_first_name: 'Bob',
          });

        expect(response.status).toBe(201);
        expect(crmDb.createLead).toHaveBeenCalledWith(
          'list_123',
          expect.objectContaining({
            email: 'auto-detect@company.com',
            firstName: 'Bob',
            customFields: expect.objectContaining({
              source: 'warmly',
              warmly_visitor_id: 'wv_xyz789',
            }),
          })
        );
      });

      it('should store Warmly enrichment fields in customFields', async () => {
        const mockLead = {
          leadId: 'lead_warmly_3',
          listId: 'list_123',
          email: 'enriched@company.com',
          customFields: {
            source: 'warmly',
            warmly_visitor_id: 'wv_enrich1',
            pages_viewed: ['/about', '/contact'],
            time_on_site: 120,
            visitor_location: 'San Francisco, CA',
            referrer: 'https://google.com',
            forwardedAt: expect.any(String),
          },
        };

        (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockLeadList);
        (crmDb.createLead as jest.Mock).mockResolvedValue(mockLead);

        const response = await request(app)
          .post('/api/webhooks/forward-lead')
          .send({
            listId: 'list_123',
            source: 'warmly',
            warmly_visitor_id: 'wv_enrich1',
            visitor_email: 'enriched@company.com',
            pages_viewed: ['/about', '/contact'],
            time_on_site: 120,
            visitor_location: 'San Francisco, CA',
            referrer: 'https://google.com',
          });

        expect(response.status).toBe(201);
        expect(crmDb.createLead).toHaveBeenCalledWith(
          'list_123',
          expect.objectContaining({
            customFields: expect.objectContaining({
              warmly_visitor_id: 'wv_enrich1',
              pages_viewed: ['/about', '/contact'],
              time_on_site: 120,
              visitor_location: 'San Francisco, CA',
              referrer: 'https://google.com',
            }),
          })
        );
      });

      it('should not affect non-Warmly payloads (regression)', async () => {
        const mockLead = {
          leadId: 'lead_normal',
          listId: 'list_123',
          email: 'normal@example.com',
          firstName: 'Normal',
          lastName: 'User',
          customFields: {
            source: 'website',
            forwardedAt: expect.any(String),
          },
        };

        (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockLeadList);
        (crmDb.createLead as jest.Mock).mockResolvedValue(mockLead);

        const response = await request(app)
          .post('/api/webhooks/forward-lead')
          .send({
            listId: 'list_123',
            email: 'normal@example.com',
            firstName: 'Normal',
            lastName: 'User',
            source: 'website',
          });

        expect(response.status).toBe(201);
        expect(crmDb.createLead).toHaveBeenCalledWith(
          'list_123',
          expect.objectContaining({
            email: 'normal@example.com',
            firstName: 'Normal',
            lastName: 'User',
            customFields: expect.objectContaining({
              source: 'website',
            }),
          })
        );
        // Should NOT have warmly-specific fields
        const createCall = (crmDb.createLead as jest.Mock).mock.calls[0][1];
        expect(createCall.customFields.warmly_visitor_id).toBeUndefined();
      });
    });

    describe('Auto Send', () => {
      const autoSendLeadList = {
        ...mockLeadList,
        autoDraftEnabled: true,
        autoSendEnabled: true,
        userId: 'user_123',
      };

      const mockDraftResult = {
        success: true,
        data: {
          email: {
            subject: 'Hello from Acme',
            textContent: 'Hi there',
            htmlContent: '<p>Hi there</p>',
          },
        },
      };

      const mockSenders = {
        success: true,
        senders: [{ id: 'sender_1', email: 'sales@acme.com', fromName: 'Acme Sales' }],
        defaultSenderId: 'sender_1',
      };

      beforeEach(() => {
        (agentModeService.updateEmailDraftForLead as jest.Mock).mockResolvedValue(mockDraftResult);
        (agentModeService.getCrmSenders as jest.Mock).mockResolvedValue(mockSenders);
        (resendService.sendEmail as jest.Mock).mockResolvedValue({ id: 'email_123' });
        (crmDb.getLeadById as jest.Mock).mockResolvedValue({ leadId: 'lead_auto', email: 'lead@example.com' });
      });

      it('should auto-send email after draft creation when autoSendEnabled is true', async () => {
        (crmDb.getLeadListById as jest.Mock).mockResolvedValue(autoSendLeadList);
        (crmDb.createLead as jest.Mock).mockResolvedValue({
          leadId: 'lead_auto',
          listId: 'list_123',
          email: 'lead@example.com',
        });

        const response = await request(app)
          .post('/api/webhooks/forward-lead')
          .send({
            listId: 'list_123',
            email: 'lead@example.com',
            firstName: 'Auto',
          });

        expect(response.status).toBe(201);
        expect(response.body.success).toBe(true);

        // Wait for fire-and-forget to complete
        await new Promise((r) => setTimeout(r, 200));

        expect(agentModeService.updateEmailDraftForLead).toHaveBeenCalled();
        expect(agentModeService.getCrmSenders).toHaveBeenCalledWith('user_123');
        expect(resendService.sendEmail).toHaveBeenCalledWith(
          expect.objectContaining({
            from: 'Acme Sales <sales@acme.com>',
            to: 'lead@example.com',
            subject: 'Hello from Acme',
          })
        );
        // Should clear draft and set lastAutoSendAt
        expect(crmDb.updateLead).toHaveBeenCalledWith(
          'list_123',
          'lead_auto',
          expect.objectContaining({ emailDraft: null, lastAutoSendAt: expect.any(String) })
        );
      });

      it('should skip auto-send if email was already sent today', async () => {
        (crmDb.getLeadListById as jest.Mock).mockResolvedValue(autoSendLeadList);
        (crmDb.createLead as jest.Mock).mockResolvedValue({
          leadId: 'lead_today',
          listId: 'list_123',
          email: 'today@example.com',
        });
        (crmDb.getLeadById as jest.Mock).mockResolvedValue({
          leadId: 'lead_today',
          email: 'today@example.com',
          lastAutoSendAt: new Date().toISOString(), // sent today
        });

        const response = await request(app)
          .post('/api/webhooks/forward-lead')
          .send({
            listId: 'list_123',
            email: 'today@example.com',
            firstName: 'Today',
          });

        expect(response.status).toBe(201);

        // Wait for fire-and-forget
        await new Promise((r) => setTimeout(r, 200));

        expect(agentModeService.updateEmailDraftForLead).toHaveBeenCalled();
        expect(resendService.sendEmail).not.toHaveBeenCalled();
      });

      it('should skip auto-send when no sender is configured', async () => {
        (crmDb.getLeadListById as jest.Mock).mockResolvedValue(autoSendLeadList);
        (crmDb.createLead as jest.Mock).mockResolvedValue({
          leadId: 'lead_nosender',
          listId: 'list_123',
          email: 'nosender@example.com',
        });
        (agentModeService.getCrmSenders as jest.Mock).mockResolvedValue({
          success: true,
          senders: [],
          defaultSenderId: null,
        });

        const response = await request(app)
          .post('/api/webhooks/forward-lead')
          .send({
            listId: 'list_123',
            email: 'nosender@example.com',
          });

        expect(response.status).toBe(201);

        await new Promise((r) => setTimeout(r, 200));

        expect(resendService.sendEmail).not.toHaveBeenCalled();
      });

      it('should not auto-send when autoSendEnabled is false', async () => {
        const draftOnlyList = { ...autoSendLeadList, autoSendEnabled: false };
        (crmDb.getLeadListById as jest.Mock).mockResolvedValue(draftOnlyList);
        (crmDb.createLead as jest.Mock).mockResolvedValue({
          leadId: 'lead_draftonly',
          listId: 'list_123',
          email: 'draftonly@example.com',
        });

        const response = await request(app)
          .post('/api/webhooks/forward-lead')
          .send({
            listId: 'list_123',
            email: 'draftonly@example.com',
          });

        expect(response.status).toBe(201);

        await new Promise((r) => setTimeout(r, 200));

        expect(agentModeService.updateEmailDraftForLead).toHaveBeenCalled();
        expect(resendService.sendEmail).not.toHaveBeenCalled();
      });

      it('should send alert with accurate auto-send status after completion', async () => {
        (crmDb.getLeadListById as jest.Mock).mockResolvedValue(autoSendLeadList);
        (crmDb.createLead as jest.Mock).mockResolvedValue({
          leadId: 'lead_alert',
          listId: 'list_123',
          email: 'alert@example.com',
        });

        await request(app)
          .post('/api/webhooks/forward-lead')
          .send({
            listId: 'list_123',
            email: 'alert@example.com',
            firstName: 'Alert',
          });

        // Wait for fire-and-forget
        await new Promise((r) => setTimeout(r, 200));

        expect(leadListAlertService.notifyLeadListOwnerIfConfigured).toHaveBeenCalledWith(
          expect.anything(),
          expect.anything(),
          'api.lead_added',
          expect.objectContaining({
            autoDraftStatus: 'created',
            autoSendStatus: 'sent',
          }),
          expect.any(String)
        );
      });
    });

    describe('LinkedIn Auto-Connection Trigger', () => {
      const linkedInLeadList = {
        ...mockLeadList,
        autoDraftEnabled: false,
        linkedInAutoConnectEnabled: true,
      };

      it('should trigger LinkedIn connection request when lead has LinkedIn URL', async () => {
        (crmDb.getLeadListById as jest.Mock).mockResolvedValue(linkedInLeadList);
        (crmDb.createLead as jest.Mock).mockResolvedValue({
          leadId: 'lead_li_1',
          listId: 'list_123',
          email: 'linkedin-lead@example.com',
          linkedin: 'https://linkedin.com/in/johndoe',
          company: 'Acme Corp',
          title: 'CEO',
        });
        (agentModeService.queueLinkedInConnectionForLead as jest.Mock).mockResolvedValue({
          success: true,
          message: 'Connection request queued',
        });

        const response = await request(app)
          .post('/api/webhooks/forward-lead')
          .send({
            listId: 'list_123',
            email: 'linkedin-lead@example.com',
            linkedin: 'https://linkedin.com/in/johndoe',
            company: 'Acme Corp',
            title: 'CEO',
          });

        expect(response.status).toBe(201);
        expect(response.body.success).toBe(true);

        // Wait for fire-and-forget
        await new Promise((r) => setTimeout(r, 200));

        expect(agentModeService.queueLinkedInConnectionForLead).toHaveBeenCalledWith(
          'user_123',
          'https://linkedin.com/in/johndoe',
          expect.objectContaining({
            company: 'Acme Corp',
            title: 'CEO',
          })
        );
      });

      it('should NOT trigger LinkedIn connection when lead has no LinkedIn URL', async () => {
        (crmDb.getLeadListById as jest.Mock).mockResolvedValue(linkedInLeadList);
        (crmDb.createLead as jest.Mock).mockResolvedValue({
          leadId: 'lead_no_li',
          listId: 'list_123',
          email: 'no-linkedin@example.com',
        });

        const response = await request(app)
          .post('/api/webhooks/forward-lead')
          .send({
            listId: 'list_123',
            email: 'no-linkedin@example.com',
            firstName: 'NoLinkedIn',
          });

        expect(response.status).toBe(201);

        await new Promise((r) => setTimeout(r, 200));

        expect(agentModeService.queueLinkedInConnectionForLead).not.toHaveBeenCalled();
      });

      it('should NOT send duplicate connection request for same LinkedIn URL (existing lead)', async () => {
        const existingLeadWithLinkedIn = {
          leadId: 'lead_existing_li',
          listId: 'list_123',
          email: 'existing@example.com',
          firstName: 'Existing',
          lastName: 'Lead',
          phone: '',
          company: 'OldCorp',
          title: 'CTO',
          notes: '',
          linkedin: 'https://linkedin.com/in/existinguser',
          customFields: { source: 'api', linkedInConnectionQueued: true },
        };

        (crmDb.getLeadListById as jest.Mock).mockResolvedValue(linkedInLeadList);
        (crmDb.getLeadByEmail as jest.Mock).mockResolvedValue(existingLeadWithLinkedIn);

        const response = await request(app)
          .post('/api/webhooks/forward-lead')
          .send({
            listId: 'list_123',
            email: 'existing@example.com',
            company: 'NewCorp',
            linkedin: 'https://linkedin.com/in/existinguser',
          });

        // lead.updated because company changed
        expect(response.status).toBe(200);
        expect(response.body.event).toBe('lead.updated');

        await new Promise((r) => setTimeout(r, 200));

        // Should NOT trigger because linkedInConnectionQueued is already true
        expect(agentModeService.queueLinkedInConnectionForLead).not.toHaveBeenCalled();
      });

      it('should queue connection for Warmly lead with LinkedIn URL', async () => {
        const warmlyLeadList = {
          ...linkedInLeadList,
          autoDraftEnabled: true,
        };

        (crmDb.getLeadListById as jest.Mock).mockResolvedValue(warmlyLeadList);
        (crmDb.createLead as jest.Mock).mockResolvedValue({
          leadId: 'lead_warmly_li',
          listId: 'list_123',
          email: 'warmly-linkedin@company.com',
          linkedin: 'https://linkedin.com/in/warmlyuser',
          company: 'WarmCorp',
          title: 'VP Sales',
        });
        (agentModeService.queueLinkedInConnectionForLead as jest.Mock).mockResolvedValue({
          success: true,
          message: 'Connection request queued',
        });

        const response = await request(app)
          .post('/api/webhooks/forward-lead')
          .send({
            listId: 'list_123',
            source: 'warmly',
            warmly_visitor_id: 'wv_li_test',
            visitor_email: 'warmly-linkedin@company.com',
            visitor_linkedin_url: 'https://linkedin.com/in/warmlyuser',
            visitor_company: 'WarmCorp',
            visitor_title: 'VP Sales',
          });

        expect(response.status).toBe(201);
        expect(response.body.success).toBe(true);

        await new Promise((r) => setTimeout(r, 200));

        expect(agentModeService.queueLinkedInConnectionForLead).toHaveBeenCalledWith(
          'user_123',
          'https://linkedin.com/in/warmlyuser',
          expect.objectContaining({
            company: 'WarmCorp',
            title: 'VP Sales',
          })
        );
      });
    });
  });
});
