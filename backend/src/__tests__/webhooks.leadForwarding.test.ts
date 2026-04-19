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

    describe('Attribution (UTM) capture', () => {
      const mockLeadList = {
        listId: 'list_123',
        userId: 'user_123',
        name: 'Test List',
        publicAccessEnabled: true,
        autoDraftEnabled: false,
      };

      beforeEach(() => {
        (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockLeadList);
        (crmDb.getLeadByEmail as jest.Mock).mockResolvedValue(null);
        (crmDb.createLead as jest.Mock).mockResolvedValue({
          leadId: 'lead_123',
          listId: 'list_123',
          email: 'utm@example.com',
        });
      });

      it('stamps firstTouch and lastTouch from the new `attribution` shape', async () => {
        const response = await request(app)
          .post('/api/webhooks/forward-lead')
          .send({
            listId: 'list_123',
            email: 'utm@example.com',
            attribution: {
              timestamp: '2026-04-19T10:00:00.000Z',
              utm: { source: 'linkedin', medium: 'social', campaign: 'launch' },
              referrer: 'https://linkedin.com/feed',
              landingUrl: 'https://agentweb.pro/?utm_source=linkedin',
            },
          });

        expect(response.status).toBe(201);
        expect(crmDb.createLead).toHaveBeenCalledWith(
          'list_123',
          expect.objectContaining({
            email: 'utm@example.com',
            firstTouch: expect.objectContaining({
              utm: expect.objectContaining({ source: 'linkedin', medium: 'social' }),
            }),
            lastTouch: expect.objectContaining({
              utm: expect.objectContaining({ source: 'linkedin' }),
            }),
          })
        );
      });

      it('stamps firstTouch from the legacy flat `utm` shape', async () => {
        const response = await request(app)
          .post('/api/webhooks/forward-lead')
          .send({
            listId: 'list_123',
            email: 'utm@example.com',
            utm: {
              utm_source: 'google',
              utm_medium: 'cpc',
              utm_campaign: 'branded',
            },
          });

        expect(response.status).toBe(201);
        expect(crmDb.createLead).toHaveBeenCalledWith(
          'list_123',
          expect.objectContaining({
            firstTouch: expect.objectContaining({
              utm: expect.objectContaining({ source: 'google', medium: 'cpc' }),
            }),
          })
        );
      });

      it('does not stamp attribution when none is provided (no-op)', async () => {
        const response = await request(app)
          .post('/api/webhooks/forward-lead')
          .send({
            listId: 'list_123',
            email: 'noutm@example.com',
          });

        expect(response.status).toBe(201);
        const call = (crmDb.createLead as jest.Mock).mock.calls[0][1];
        expect(call.firstTouch).toBeUndefined();
        expect(call.lastTouch).toBeUndefined();
      });
    });
  });
});
