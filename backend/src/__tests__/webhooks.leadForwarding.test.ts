import request from 'supertest';
import express from 'express';
import webhookRouter from '../routes/webhooks';
import { crmDb } from '../services/db';
import { leadListAlertService } from '../services/leadListAlertService';
import { recordLeadCaptureFailure } from '../services/leadCaptureFailureService';
import { agentModeService } from '../services/agentModeService';
import { resendService } from '../services/resendService';
import { dripSequenceDb } from '../services/dripSequenceDb';
import { externalCrmSyncService } from '../services/externalCrmSyncService';

// Mock dependencies
jest.mock('../services/orgLeadNotificationService', () => ({
  dispatchLeadCreated: jest.fn().mockResolvedValue(undefined),
  dispatchLeadsCreated: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../services/db', () => ({
  crmDb: {
    getLeadListById: jest.fn(),
    getLeadByEmail: jest.fn(),
    createLead: jest.fn(),
    updateLead: jest.fn(),
    getLeadById: jest.fn(),
  },
}));

jest.mock('../services/dripSequenceDb', () => ({
  dripSequenceDb: {
    getSequencesByAutoEnrollList: jest.fn(),
    bulkEnroll: jest.fn(),
  },
}));

jest.mock('../services/externalCrmSyncService', () => ({
  externalCrmSyncService: {
    autoSyncLead: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../services/leadListAlertService', () => ({
  leadListAlertService: {
    notifyLeadListOwnerIfConfigured: jest.fn(),
  },
}));

jest.mock('../services/leadCaptureFailureService', () => ({
  recordLeadCaptureFailure: jest.fn(),
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
    sendSystemEmail: jest.fn(),
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

const flushAsyncWork = async () => {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
};

// ENG-2320: forward-lead sends customFields to updateLead as a per-key PATCH (customFieldsKeyMerge), so what
// these tests pin is the RESULT: the stored map with the patch applied, not the call's argument shape.
const applied = (stored: Record<string, any>, updates: any): Record<string, any> =>
  updates.customFieldsKeyMerge ? { ...stored, ...updates.customFields } : { ...updates.customFields };
const STORED = { forwardedAt: '2020-01-01T00:00:00.000Z', source: 'hero-form' };

describe('Lead Forwarding API (List ID Authentication)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (crmDb.getLeadByEmail as jest.Mock).mockResolvedValue(null);
    (crmDb.updateLead as jest.Mock).mockResolvedValue(undefined);
    (resendService.sendSystemEmail as jest.Mock).mockResolvedValue({ id: 'email_123' });
    (agentModeService.updateEmailDraftForLead as jest.Mock).mockResolvedValue({
      success: true,
      message: 'Email and message drafts created successfully',
    });
    (dripSequenceDb.getSequencesByAutoEnrollList as jest.Mock).mockResolvedValue([]);
    (dripSequenceDb.bulkEnroll as jest.Mock).mockResolvedValue(undefined);
    (externalCrmSyncService.autoSyncLead as jest.Mock).mockResolvedValue(undefined);
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

    it('records a capture failure when the listId does not exist (404)', async () => {
      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(null);

      const response = await request(app)
        .post('/api/webhooks/forward-lead')
        .send({
          listId: 'list_nonexistent',
          email: 'lead@acme.com',
          source: 'demystifying_ai_lead_magnet',
        });

      expect(response.status).toBe(404);
      expect(recordLeadCaptureFailure).toHaveBeenCalledTimes(1);
      expect(recordLeadCaptureFailure).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: 'list_not_found',
          listId: 'list_nonexistent',
          status: 404,
          source: 'demystifying_ai_lead_magnet',
        })
      );
    });

    it('records a capture failure when public access is disabled (403)', async () => {
      (crmDb.getLeadListById as jest.Mock).mockResolvedValue({
        ...mockLeadList,
        publicAccessEnabled: false,
      });

      const response = await request(app)
        .post('/api/webhooks/forward-lead')
        .send({
          listId: 'list_123',
          email: 'lead@acme.com',
          source: 'ai-readiness-roadmap',
        });

      expect(response.status).toBe(403);
      expect(recordLeadCaptureFailure).toHaveBeenCalledTimes(1);
      expect(recordLeadCaptureFailure).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: 'public_access_disabled',
          listId: 'list_123',
          status: 403,
          source: 'ai-readiness-roadmap',
          userId: mockLeadList.userId,
        })
      );
    });

    it('does not record a capture failure on a successful forward', async () => {
      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockLeadList);
      (crmDb.createLead as jest.Mock).mockResolvedValue({
        leadId: 'lead_ok',
        listId: 'list_123',
        email: 'lead@acme.com',
      });

      const response = await request(app)
        .post('/api/webhooks/forward-lead')
        .send({
          listId: 'list_123',
          email: 'lead@acme.com',
          source: 'ai-readiness-roadmap',
        });

      expect(response.status).toBe(201);
      expect(recordLeadCaptureFailure).not.toHaveBeenCalled();
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
      // ENG-2082: a lead needs SOMETHING contactable, not an email specifically. This
      // payload carries neither, so it is still refused.
      expect(response.body.message).toBe('Email or phone is required');
    });

    it('allowAnonymousLead: records a submission with no email or phone when the lander opts in', async () => {
      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockLeadList);
      (crmDb.createLead as jest.Mock).mockResolvedValue({ leadId: 'lead_anon', listId: 'list_123' });

      const response = await request(app)
        .post('/api/webhooks/forward-lead')
        .send({ listId: 'list_123', allowAnonymousLead: true, brand: 'Rheem', model_number: 'XE50' });

      expect(response.status).toBe(201);
      const created = (crmDb.createLead as jest.Mock).mock.calls.at(-1)[1];
      expect(created.email).toBeUndefined();
      expect(created.customFields.brand).toBe('Rheem');
      expect(created.customFields.allowAnonymousLead).toBeUndefined();
    });

    it('ENG-2082: a SYNTHETIC phone-only lead is keyed deterministically (the smoke test reads it back)', async () => {
      // A phone-only lander used to be impossible: this route required an email, so every
      // submission was refused before a row was built and the page captured nothing.
      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockLeadList);
      (crmDb.createLead as jest.Mock).mockResolvedValue({
        leadId: 'lead_ph_abc', listId: 'list_123', phone: '4155550142', customFields: {},
      });

      const response = await request(app)
        .post('/api/webhooks/forward-lead')
        .send({ listId: 'list_123', phone: '+1 (415) 555-0142' });

      expect(response.status).toBe(201);
      // No email lookup is possible, so none is attempted — the deterministic leadId is
      // what dedupes instead.
      expect(crmDb.getLeadByEmail).not.toHaveBeenCalled();

      const [, created] = (crmDb.createLead as jest.Mock).mock.calls[0];
      expect(created.failIfExists).toBe(true);
      expect(created.leadId).toMatch(/^lead_ph_[0-9a-f]{24}$/);
      // `email` is omitted entirely, never written as '': it keys the email-index GSI and
      // DynamoDB rejects an empty string for an index key attribute.
      expect('email' in created).toBe(false);
    });

    it('ENG-2123: a REAL phone-only lead gets an ordinary timestamp id, not a deterministic one', async () => {
      // leadId is the RANGE key and getLeadsByListId pages it with ScanIndexForward:false,
      // so a `lead_ph_…` id ('p' = 0x70, above every digit) sorts ABOVE every
      // lead_<timestamp>_… row — pinning phone-only leads to the top of the customer's list
      // in hash order forever, and pushing email leads off page one once the 1MB page cap
      // is reached. Synthetic numbers keep the deterministic id because the smoke test has
      // to read its own row back; real captures must not pay for that.
      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockLeadList);
      (crmDb.createLead as jest.Mock).mockResolvedValue({
        leadId: 'lead_1790000000000_abc', listId: 'list_123', phone: '2125559876', customFields: {},
      });

      const response = await request(app)
        .post('/api/webhooks/forward-lead')
        .send({ listId: 'list_123', phone: '+1 (212) 555-9876' });

      expect(response.status).toBe(201);
      const [, created] = (crmDb.createLead as jest.Mock).mock.calls[0];
      expect(created.leadId).toBeUndefined();
      expect(created.failIfExists).toBeUndefined();
      // still a phone-only row: email omitted, never ''
      expect('email' in created).toBe(false);
      expect(created.phone).toBeTruthy();
    });

    it('ENG-2082: the same number in a different format collapses onto the same row', async () => {
      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockLeadList);
      (crmDb.createLead as jest.Mock).mockResolvedValue({ leadId: 'x', listId: 'list_123', customFields: {} });

      await request(app).post('/api/webhooks/forward-lead')
        .send({ listId: 'list_123', phone: '+1 (415) 555-0142' });
      await request(app).post('/api/webhooks/forward-lead')
        .send({ listId: 'list_123', phone: '4155550142' });

      const first = (crmDb.createLead as jest.Mock).mock.calls[0][1].leadId;
      const second = (crmDb.createLead as jest.Mock).mock.calls[1][1].leadId;
      expect(second).toBe(first);
    });

    it('ENG-2082: losing the conditional create adopts the winning row instead of 500ing', async () => {
      // The dedupe succeeding, not a fault. isNew must stay false so the new-lead side
      // effects do not fire twice for one person.
      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockLeadList);
      const race: any = new Error('Lead already exists for this deterministic key');
      race.leadAlreadyExists = true;
      (crmDb.createLead as jest.Mock).mockRejectedValueOnce(race);
      (crmDb.getLeadById as jest.Mock).mockResolvedValue({
        leadId: 'lead_ph_existing', listId: 'list_123', phone: '4155550142', customFields: {},
      });

      const response = await request(app)
        .post('/api/webhooks/forward-lead')
        .send({ listId: 'list_123', phone: '4155550142' });

      // `not.toBe(500)` would pass on a 400 or a 404 too. The contract is specific: the
      // duplicate is reported as a success, the row is read CONSISTENTLY (the conditional
      // write just proved it exists, so an eventually-consistent miss would be a lie), and
      // isNew stays false so the new-lead side effects do not fire twice for one person.
      expect(response.status).toBe(200);
      expect(response.body.event).toBe('lead.unchanged');
      expect(crmDb.getLeadById).toHaveBeenCalledWith(
        'list_123',
        expect.stringMatching(/^lead_ph_[0-9a-f]{24}$/),
        { consistentRead: true }
      );
    });

    it('ENG-2082: a lead captured by the winner is never reported as a 500 to the visitor', async () => {
      // A double-click on a phone-only lander. The loser's consistent read can still come
      // back empty if the winning row was removed in between; throwing there would return a
      // 500 for a submission that WAS captured, and fire a false api.lead_failed alert.
      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockLeadList);
      const race: any = new Error('Lead already exists for this deterministic key');
      race.leadAlreadyExists = true;
      (crmDb.createLead as jest.Mock).mockRejectedValueOnce(race);
      (crmDb.getLeadById as jest.Mock).mockResolvedValue(null);

      const response = await request(app)
        .post('/api/webhooks/forward-lead')
        .send({ listId: 'list_123', phone: '4155550142' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it('ENG-2082: a repeat submission keeps the ORIGINAL forwardedAt but takes the NEW source', async () => {
      // Two system-stamped keys, opposite handling. forwardedAt is minted by this handler on
      // every submission (existingLead is null on the adopt path), so the merged copy is
      // never the visitor's data and the stored one must win — it is the lead's capture time
      // and the owner alert renders it. `source` IS caller-supplied when the lander sends
      // one, so reverting it would silently discard step 2 of a multi-step form, which is the
      // data-loss incident this file documents.
      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockLeadList);
      const race: any = new Error('Lead already exists for this deterministic key');
      race.leadAlreadyExists = true;
      (crmDb.createLead as jest.Mock).mockRejectedValueOnce(race);
      (crmDb.getLeadById as jest.Mock).mockResolvedValue({
        leadId: 'lead_ph_existing', listId: 'list_123', phone: '4155550142', firstName: '',
        customFields: { forwardedAt: '2020-01-01T00:00:00.000Z', source: 'hero-form' },
      });

      await request(app)
        .post('/api/webhooks/forward-lead')
        .send({ listId: 'list_123', phone: '4155550142', source: 'qualify-form', qualified: 'yes' });

      expect(crmDb.updateLead).toHaveBeenCalled();
      const [, , updates] = (crmDb.updateLead as jest.Mock).mock.calls[0];
      const result = applied(STORED, updates);
      expect(result.forwardedAt).toBe('2020-01-01T00:00:00.000Z');
      expect(result.source).toBe('qualify-form');
      expect(result.qualified).toBe('yes');
    });

    it('the EMAIL path also keeps a stored source when the submission omits one', async () => {
      // Same defect, far more common path: `source` defaults to 'api' whenever the caller
      // omits it, and the email branch spreads incoming over existing unconditionally.
      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockLeadList);
      (crmDb.getLeadByEmail as jest.Mock).mockResolvedValue({
        leadId: 'lead_existing', listId: 'list_123', email: 'x@example.com', firstName: '',
        customFields: { forwardedAt: '2020-01-01T00:00:00.000Z', source: 'hero-form' },
      });

      await request(app)
        .post('/api/webhooks/forward-lead')
        .send({ listId: 'list_123', email: 'x@example.com', qualified: 'yes' });

      const [, , updates] = (crmDb.updateLead as jest.Mock).mock.calls[0];
      const result = applied(STORED, updates);
      expect(result.qualified).toBe('yes');
      expect(result.source).toBe('hero-form');
    });

    it('the EMAIL path still lets a submission that NAMES a source overwrite the stored one', async () => {
      // The other direction of the same guard, and the one a blanket restore would break:
      // the adopt path has both directions covered, the email path only had the omitted
      // case. Without `callerSuppliedSource` this reverts to 'hero-form' and a multi-step
      // lander can never record which step converted.
      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockLeadList);
      (crmDb.getLeadByEmail as jest.Mock).mockResolvedValue({
        leadId: 'lead_existing', listId: 'list_123', email: 'x@example.com', firstName: '',
        customFields: { forwardedAt: '2020-01-01T00:00:00.000Z', source: 'hero-form' },
      });

      await request(app)
        .post('/api/webhooks/forward-lead')
        .send({ listId: 'list_123', email: 'x@example.com', source: 'qualify-form', qualified: 'yes' });

      const [, , updates] = (crmDb.updateLead as jest.Mock).mock.calls[0];
      const result = applied(STORED, updates);
      expect(result.source).toBe('qualify-form');
      expect(result.forwardedAt).toBe('2020-01-01T00:00:00.000Z');
    });

    it('ENG-2082: a repeat submission that omits source must not clobber the stored one', async () => {
      // `source` is never absent from incomingCustomFields — the destructure defaults it to
      // 'api'. So restoring only forwardedAt means that synthesized default overwrites a
      // real stored value whenever any OTHER field changes. Step 1 of a multi-step lander
      // posts source "hero-form"; step 2 posts only the qualification answer; the row ends
      // up reading "api". Same data loss as before, moved one case over.
      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockLeadList);
      const race: any = new Error('Lead already exists for this deterministic key');
      race.leadAlreadyExists = true;
      (crmDb.createLead as jest.Mock).mockRejectedValueOnce(race);
      (crmDb.getLeadById as jest.Mock).mockResolvedValue({
        leadId: 'lead_ph_existing', listId: 'list_123', phone: '4155550142', firstName: '',
        customFields: { forwardedAt: '2020-01-01T00:00:00.000Z', source: 'hero-form' },
      });

      await request(app)
        .post('/api/webhooks/forward-lead')
        .send({ listId: 'list_123', phone: '4155550142', qualified: 'yes' });

      const [, , updates] = (crmDb.updateLead as jest.Mock).mock.calls[0];
      const result = applied(STORED, updates);
      expect(result.qualified).toBe('yes');
      expect(result.forwardedAt).toBe('2020-01-01T00:00:00.000Z');
      expect(result.source).toBe('hero-form');
    });

    it('ENG-2082: a repeat phone submission merges its new data instead of discarding it', async () => {
      // failIfExists + a deterministic id means every later submission from the same number
      // lands on the adopt path, not just the concurrent race. A multi-step lander posts the
      // phone first and the qualification answers second; without a merge the second call
      // returns success and the answers vanish.
      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockLeadList);
      const race: any = new Error('Lead already exists for this deterministic key');
      race.leadAlreadyExists = true;
      (crmDb.createLead as jest.Mock).mockRejectedValueOnce(race);
      (crmDb.getLeadById as jest.Mock).mockResolvedValue({
        leadId: 'lead_ph_existing', listId: 'list_123', phone: '4155550142',
        firstName: '', customFields: {},
      });

      await request(app)
        .post('/api/webhooks/forward-lead')
        .send({ listId: 'list_123', phone: '4155550142', firstName: 'Dana', qualified: 'yes' });

      expect(crmDb.updateLead).toHaveBeenCalled();
      const [, , updates] = (crmDb.updateLead as jest.Mock).mock.calls[0];
      expect(updates.firstName).toBe('Dana');
      expect(updates.customFields.qualified).toBe('yes');
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
        }), 'form_fill'
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

    it('should send the AI Readiness roadmap for a new final roadmap lead', async () => {
      const mockLead = {
        leadId: 'lead_roadmap_new',
        listId: 'list_123',
        email: 'roadmap@example.com',
        firstName: 'Road',
        lastName: 'Map',
        customFields: {
          source: 'ai-readiness-popup',
          stage: 4,
          partial: false,
        },
      };

      (crmDb.getLeadListById as jest.Mock).mockResolvedValue({
        ...mockLeadList,
        autoDraftEnabled: false,
      });
      (crmDb.createLead as jest.Mock).mockResolvedValue(mockLead);

      const response = await request(app)
        .post('/api/webhooks/forward-lead')
        .send({
          listId: 'list_123',
          email: 'roadmap@example.com',
          firstName: 'Road',
          source: 'ai-readiness-popup',
          customFields: {
            stage: 4,
            partial: false,
          },
        });

      expect(response.status).toBe(201);
      await flushAsyncWork();

      expect(resendService.sendSystemEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'roadmap@example.com',
          subject: 'Your AI Marketing Readiness Roadmap (Stage 4)',
        })
      );
      expect(crmDb.updateLead).toHaveBeenCalledWith(
        'list_123',
        'lead_roadmap_new',
        expect.objectContaining({
          customFields: expect.objectContaining({
            roadmapEmailSentAt: expect.any(String),
            roadmapEmailStage: 4,
          }),
        })
      );
    });

    it('should send the roadmap when an existing AI Eval lead is later updated with a stage', async () => {
      const existingLead = {
        leadId: 'lead_existing_eval',
        listId: 'list_123',
        email: 'existing@example.com',
        firstName: 'Existing',
        customFields: {
          source: 'ai-readiness-popup-ai-eval-started',
          ai_eval_auto_triggered: true,
        },
      };

      (crmDb.getLeadListById as jest.Mock).mockResolvedValue({
        ...mockLeadList,
        autoDraftEnabled: false,
      });
      (crmDb.getLeadByEmail as jest.Mock).mockResolvedValue(existingLead);

      const response = await request(app)
        .post('/api/webhooks/forward-lead')
        .send({
          listId: 'list_123',
          email: 'existing@example.com',
          source: 'ai-readiness-popup',
          customFields: {
            stage: 5,
            partial: false,
          },
        });

      expect(response.status).toBe(200);
      expect(response.body.event).toBe('lead.updated');
      await flushAsyncWork();

      expect(resendService.sendSystemEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'existing@example.com',
          subject: 'Your AI Marketing Readiness Roadmap (Stage 5)',
        })
      );
      expect(crmDb.updateLead).toHaveBeenLastCalledWith(
        'list_123',
        'lead_existing_eval',
        // ENG-2320: the delivery marker writes ONLY the two keys it owns, per key, so it can never
        // clobber keys a concurrent submission just merged. `stage` was written by the merge call.
        expect.objectContaining({
          customFieldsKeyMerge: true,
          customFields: {
            roadmapEmailSentAt: expect.any(String),
            roadmapEmailStage: 5,
          },
        })
      );
      const mergeCall = (crmDb.updateLead as jest.Mock).mock.calls[0][2];
      expect(applied(existingLead.customFields, mergeCall).stage).toBe(5);
    });

    it('should not resend the roadmap after it has been marked delivered', async () => {
      const existingLead = {
        leadId: 'lead_already_sent',
        listId: 'list_123',
        email: 'sent@example.com',
        firstName: 'Already',
        customFields: {
          source: 'ai-readiness-popup',
          stage: 3,
          partial: false,
          roadmapEmailSentAt: '2026-06-08T19:00:00.000Z',
          roadmapEmailStage: 3,
        },
      };

      (crmDb.getLeadListById as jest.Mock).mockResolvedValue({
        ...mockLeadList,
        autoDraftEnabled: false,
      });
      (crmDb.getLeadByEmail as jest.Mock).mockResolvedValue(existingLead);

      const response = await request(app)
        .post('/api/webhooks/forward-lead')
        .send({
          listId: 'list_123',
          email: 'sent@example.com',
          source: 'ai-readiness-popup',
          customFields: {
            stage: 3,
            partial: false,
          },
        });

      expect(response.status).toBe(200);
      await flushAsyncWork();

      expect(resendService.sendSystemEmail).not.toHaveBeenCalled();
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
        }), 'form_fill'
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
      expect(crmDb.createLead).not.toHaveBeenCalled();
      expect(agentModeService.updateEmailDraftForLead).not.toHaveBeenCalled();
      expect(leadListAlertService.notifyLeadListOwnerIfConfigured).not.toHaveBeenCalled();

      // ENG-926 §B: a repeat touch may now write the match-quality signals this lead was
      // missing (clientIp / clientUserAgent / metaFbp), so updateLead is no longer
      // guaranteed to be uncalled. The contract that matters is unchanged and is asserted
      // above and below: the lead still reports `lead.unchanged`, no draft is created, no
      // owner alert fires — and the write, if any, touches ONLY those metadata fields.
      // Deliberately narrowed rather than deleted: "no user-visible field was modified" is
      // the property this test exists to protect.
      const MATCH_QUALITY_KEYS = ['clientIp', 'clientUserAgent', 'metaFbp'];
      for (const call of (crmDb.updateLead as jest.Mock).mock.calls) {
        const written = Object.keys(call[2]);
        expect(written.length).toBeGreaterThan(0);
        expect(written.filter((k) => !MATCH_QUALITY_KEYS.includes(k))).toEqual([]);
      }
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
          }), 'form_fill'
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
          }), 'form_fill'
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

      // Regression: the existing-lead MERGE path used to drop attribution
      // entirely — lastTouch was DOA for any lead that came through the webhook
      // more than once (firstTouch === lastTouch forever). The merge whitelist
      // previously only carried standardFields + customFields.
      describe('existing-lead merge path (lastTouch refresh)', () => {
        const firstTouch = {
          timestamp: '2026-04-19T10:00:00.000Z',
          utm: { source: 'linkedin', medium: 'social', campaign: 'first' },
        };

        it('refreshes lastTouch on a repeat touch, preserves firstTouch + utm denorm', async () => {
          (crmDb.getLeadByEmail as jest.Mock).mockResolvedValue({
            leadId: 'lead_repeat',
            listId: 'list_123',
            email: 'repeat@example.com',
            firstName: 'Repeat',
            firstTouch,
            lastTouch: firstTouch,
            utmSource: 'linkedin',
            utmMedium: 'social',
            customFields: { source: 'api' },
          });

          const response = await request(app)
            .post('/api/webhooks/forward-lead')
            .send({
              listId: 'list_123',
              email: 'repeat@example.com',
              attribution: {
                timestamp: '2026-04-20T10:00:00.000Z',
                utm: { source: 'google', medium: 'cpc', campaign: 'second' },
              },
            });

          expect(response.status).toBe(200);
          expect(response.body.event).toBe('lead.updated');

          const updates = (crmDb.updateLead as jest.Mock).mock.calls.find(
            (c) => c[1] === 'lead_repeat'
          )?.[2];
          expect(updates).toBeDefined();
          // lastTouch ALWAYS refreshes to the new touch
          expect(updates.lastTouch).toEqual(
            expect.objectContaining({
              utm: expect.objectContaining({ source: 'google', medium: 'cpc' }),
            })
          );
          // firstTouch must NEVER be in the update payload (immutable)
          expect(updates.firstTouch).toBeUndefined();
          // utmSource/utmMedium are denormalized from firstTouch — never overwritten
          // once present, so they must not be in the update payload here.
          expect(updates.utmSource).toBeUndefined();
          expect(updates.utmMedium).toBeUndefined();
        });

        it('backfills firstTouch + utm denorm when an existing lead has none', async () => {
          (crmDb.getLeadByEmail as jest.Mock).mockResolvedValue({
            leadId: 'lead_noattr',
            listId: 'list_123',
            email: 'noattr@example.com',
            firstName: 'NoAttr',
            customFields: { source: 'manual' },
            // no firstTouch / lastTouch / utmSource / utmMedium
          });

          const response = await request(app)
            .post('/api/webhooks/forward-lead')
            .send({
              listId: 'list_123',
              email: 'noattr@example.com',
              attribution: {
                timestamp: '2026-04-20T10:00:00.000Z',
                utm: { source: 'twitter', medium: 'social', campaign: 'late' },
              },
            });

          expect(response.status).toBe(200);
          expect(response.body.event).toBe('lead.updated');

          const updates = (crmDb.updateLead as jest.Mock).mock.calls.find(
            (c) => c[1] === 'lead_noattr'
          )?.[2];
          expect(updates).toBeDefined();
          // firstTouch backfilled (was absent) — only-if-absent
          expect(updates.firstTouch).toEqual(
            expect.objectContaining({
              utm: expect.objectContaining({ source: 'twitter' }),
            })
          );
          // lastTouch set too
          expect(updates.lastTouch).toEqual(
            expect.objectContaining({
              utm: expect.objectContaining({ source: 'twitter' }),
            })
          );
          // utm denorm backfilled from the new firstTouch
          expect(updates.utmSource).toBe('twitter');
          expect(updates.utmMedium).toBe('social');
        });

        // ENG-1176 — the click-ID denorm follows the same only-if-absent
        // contract as the utm denorm above.
        it('backfills clickIds when an existing lead has none', async () => {
          (crmDb.getLeadByEmail as jest.Mock).mockResolvedValue({
            leadId: 'lead_noclick',
            listId: 'list_123',
            email: 'noclick@example.com',
            firstName: 'NoClick',
            customFields: { source: 'manual' },
            // no firstTouch / clickIds
          });

          const response = await request(app)
            .post('/api/webhooks/forward-lead')
            .send({
              listId: 'list_123',
              email: 'noclick@example.com',
              attribution: {
                timestamp: '2026-08-13T10:00:00.000Z',
                utm: { source: 'google', medium: 'cpc', campaign: 'brand' },
                clickIds: { gclid: 'Cj0-late-backfill' },
              },
            });

          expect(response.status).toBe(200);

          const updates = (crmDb.updateLead as jest.Mock).mock.calls.find(
            (c) => c[1] === 'lead_noclick'
          )?.[2];
          expect(updates.clickIds).toEqual({ gclid: 'Cj0-late-backfill' });
        });

        it('never overwrites clickIds once the acquiring click is stamped', async () => {
          (crmDb.getLeadByEmail as jest.Mock).mockResolvedValue({
            leadId: 'lead_hasclick',
            listId: 'list_123',
            email: 'hasclick@example.com',
            firstName: 'HasClick',
            firstTouch,
            lastTouch: firstTouch,
            utmSource: 'linkedin',
            utmMedium: 'social',
            clickIds: { gclid: 'original-acquiring-click' },
            customFields: { source: 'api' },
          });

          const response = await request(app)
            .post('/api/webhooks/forward-lead')
            .send({
              listId: 'list_123',
              email: 'hasclick@example.com',
              attribution: {
                timestamp: '2026-08-13T11:00:00.000Z',
                clickIds: { gclid: 'a-later-click' },
              },
            });

          expect(response.status).toBe(200);

          const updates = (crmDb.updateLead as jest.Mock).mock.calls.find(
            (c) => c[1] === 'lead_hasclick'
          )?.[2];
          // The later click refreshes lastTouch and nothing else — attributing
          // the lead to the click that re-engaged it would credit the wrong
          // campaign for an acquisition it did not cause.
          expect(updates.clickIds).toBeUndefined();
          expect(updates.lastTouch).toEqual(
            expect.objectContaining({
              clickIds: expect.objectContaining({ gclid: 'a-later-click' }),
            })
          );
        });

        it('does not touch attribution fields when the repeat touch carries none', async () => {
          (crmDb.getLeadByEmail as jest.Mock).mockResolvedValue({
            leadId: 'lead_noinc',
            listId: 'list_123',
            email: 'noinc@example.com',
            firstName: 'Old',
            firstTouch,
            lastTouch: firstTouch,
            utmSource: 'linkedin',
            utmMedium: 'social',
            customFields: { source: 'api' },
          });

          const response = await request(app)
            .post('/api/webhooks/forward-lead')
            .send({
              listId: 'list_123',
              email: 'noinc@example.com',
              firstName: 'New', // forces a change so updateLead is called
            });

          expect(response.status).toBe(200);
          expect(response.body.event).toBe('lead.updated');

          const updates = (crmDb.updateLead as jest.Mock).mock.calls.find(
            (c) => c[1] === 'lead_noinc'
          )?.[2];
          expect(updates).toBeDefined();
          expect(updates.firstName).toBe('New');
          // No incoming attribution → no attribution keys in the update
          expect(updates.firstTouch).toBeUndefined();
          expect(updates.lastTouch).toBeUndefined();
          expect(updates.utmSource).toBeUndefined();
          expect(updates.utmMedium).toBeUndefined();
        });
      });
    });

    describe('Real-time external CRM sync (HubSpot / Attio)', () => {
      const syncLeadList = {
        listId: 'list_123',
        userId: 'owner_123',
        name: 'Test List',
        publicAccessEnabled: true,
        autoDraftEnabled: false,
      };

      beforeEach(() => {
        (crmDb.getLeadListById as jest.Mock).mockResolvedValue(syncLeadList);
        (crmDb.getLeadByEmail as jest.Mock).mockResolvedValue(null);
      });

      it('pushes a newly created lead to HubSpot and Attio with event "created"', async () => {
        const createdLead = { leadId: 'lead_sync_new', listId: 'list_123', email: 'sync@example.com' };
        (crmDb.createLead as jest.Mock).mockResolvedValue(createdLead);

        const response = await request(app)
          .post('/api/webhooks/forward-lead')
          .send({ listId: 'list_123', email: 'sync@example.com' });

        expect(response.status).toBe(201);
        await flushAsyncWork();

        expect(externalCrmSyncService.autoSyncLead).toHaveBeenCalledWith(
          'owner_123', 'list_123', createdLead, 'hubspot', 'created'
        );
        expect(externalCrmSyncService.autoSyncLead).toHaveBeenCalledWith(
          'owner_123', 'list_123', createdLead, 'attio', 'created'
        );
      });

      it('pushes an updated existing lead with event "updated"', async () => {
        (crmDb.getLeadByEmail as jest.Mock).mockResolvedValue({
          leadId: 'lead_sync_existing',
          listId: 'list_123',
          email: 'existing@example.com',
          firstName: '',
        });

        const response = await request(app)
          .post('/api/webhooks/forward-lead')
          .send({ listId: 'list_123', email: 'existing@example.com', firstName: 'Updated' });

        expect(response.status).toBe(200);
        await flushAsyncWork();

        expect(externalCrmSyncService.autoSyncLead).toHaveBeenCalledWith(
          'owner_123', 'list_123', expect.objectContaining({ leadId: 'lead_sync_existing' }), 'hubspot', 'updated'
        );
      });

      it('does not sync when the lead exists with no changes (unchanged)', async () => {
        (crmDb.getLeadByEmail as jest.Mock).mockResolvedValue({
          leadId: 'lead_sync_same',
          listId: 'list_123',
          email: 'same@example.com',
          firstName: 'Same',
          customFields: { source: 'api' },
        });

        const response = await request(app)
          .post('/api/webhooks/forward-lead')
          .send({ listId: 'list_123', email: 'same@example.com', firstName: 'Same' });

        expect(response.status).toBe(200);
        expect(response.body.event).toBe('lead.unchanged');
        await flushAsyncWork();

        expect(externalCrmSyncService.autoSyncLead).not.toHaveBeenCalled();
      });

      it('does not fail the request when external CRM sync throws', async () => {
        (crmDb.createLead as jest.Mock).mockResolvedValue({
          leadId: 'lead_sync_err', listId: 'list_123', email: 'err@example.com',
        });
        (externalCrmSyncService.autoSyncLead as jest.Mock).mockRejectedValue(new Error('hubspot down'));

        const response = await request(app)
          .post('/api/webhooks/forward-lead')
          .send({ listId: 'list_123', email: 'err@example.com' });

        expect(response.status).toBe(201);
        await flushAsyncWork();
        expect(externalCrmSyncService.autoSyncLead).toHaveBeenCalled();
      });
    });

    describe('Auto-enroll into list-bound drip sequences', () => {
      const mockLeadList = {
        listId: 'list_123',
        userId: 'owner_123',
        name: 'Test List',
        publicAccessEnabled: true,
        autoDraftEnabled: false,
      };

      const mockSequence = {
        sequenceId: 'seq_123',
        userId: 'owner_123',
        name: 'AI Readiness Drip',
      };

      beforeEach(() => {
        (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockLeadList);
        (crmDb.getLeadByEmail as jest.Mock).mockResolvedValue(null);
      });

      it('enrolls a newly created public-form lead into a list-bound sequence', async () => {
        (crmDb.createLead as jest.Mock).mockResolvedValue({
          leadId: 'lead_enroll',
          listId: 'list_123',
          email: 'enroll@acme.io',
        });
        (dripSequenceDb.getSequencesByAutoEnrollList as jest.Mock).mockResolvedValue([mockSequence]);

        const response = await request(app)
          .post('/api/webhooks/forward-lead')
          .send({ listId: 'list_123', email: 'enroll@acme.io' });

        expect(response.status).toBe(201);

        // Wait for fire-and-forget
        await new Promise((r) => setTimeout(r, 200));

        expect(dripSequenceDb.getSequencesByAutoEnrollList).toHaveBeenCalledWith('owner_123', 'list_123');
        expect(dripSequenceDb.bulkEnroll).toHaveBeenCalledWith([
          expect.objectContaining({
            sequenceId: 'seq_123',
            userId: 'owner_123',
            listId: 'list_123',
            leadId: 'lead_enroll',
            leadEmail: 'enroll@acme.io',
          }),
        ]);
      });

      it('enrolls an updated existing lead into a list-bound sequence', async () => {
        (crmDb.getLeadByEmail as jest.Mock).mockResolvedValue({
          leadId: 'lead_existing',
          listId: 'list_123',
          email: 'existing@acme.io',
          firstName: '',
        });
        (dripSequenceDb.getSequencesByAutoEnrollList as jest.Mock).mockResolvedValue([mockSequence]);

        const response = await request(app)
          .post('/api/webhooks/forward-lead')
          .send({ listId: 'list_123', email: 'existing@acme.io', firstName: 'Updated' });

        expect(response.status).toBe(200);

        // Wait for fire-and-forget
        await new Promise((r) => setTimeout(r, 200));

        expect(dripSequenceDb.bulkEnroll).toHaveBeenCalledWith([
          expect.objectContaining({
            sequenceId: 'seq_123',
            leadId: 'lead_existing',
            leadEmail: 'existing@acme.io',
          }),
        ]);
      });

      it('does not call bulkEnroll when no sequences watch the list', async () => {
        (crmDb.createLead as jest.Mock).mockResolvedValue({
          leadId: 'lead_none',
          listId: 'list_123',
          email: 'none@example.com',
        });
        (dripSequenceDb.getSequencesByAutoEnrollList as jest.Mock).mockResolvedValue([]);

        await request(app)
          .post('/api/webhooks/forward-lead')
          .send({ listId: 'list_123', email: 'none@example.com' });

        // Wait for fire-and-forget
        await new Promise((r) => setTimeout(r, 200));

        expect(dripSequenceDb.getSequencesByAutoEnrollList).toHaveBeenCalledWith('owner_123', 'list_123');
        expect(dripSequenceDb.bulkEnroll).not.toHaveBeenCalled();
      });

      it('does not enroll when the lead exists with no changes', async () => {
        (crmDb.getLeadByEmail as jest.Mock).mockResolvedValue({
          leadId: 'lead_same',
          listId: 'list_123',
          email: 'same@example.com',
          firstName: 'Same',
          customFields: { source: 'api' },
        });
        (dripSequenceDb.getSequencesByAutoEnrollList as jest.Mock).mockResolvedValue([mockSequence]);

        const response = await request(app)
          .post('/api/webhooks/forward-lead')
          .send({ listId: 'list_123', email: 'same@example.com', firstName: 'Same' });

        expect(response.status).toBe(200);
        expect(response.body.event).toBe('lead.unchanged');

        // Wait for fire-and-forget
        await new Promise((r) => setTimeout(r, 200));

        expect(dripSequenceDb.getSequencesByAutoEnrollList).not.toHaveBeenCalled();
        expect(dripSequenceDb.bulkEnroll).not.toHaveBeenCalled();
      });

      it('does not fail the request when enrollment throws', async () => {
        (crmDb.createLead as jest.Mock).mockResolvedValue({
          leadId: 'lead_err',
          listId: 'list_123',
          email: 'err@example.com',
        });
        (dripSequenceDb.getSequencesByAutoEnrollList as jest.Mock).mockRejectedValue(
          new Error('drip db down')
        );

        const response = await request(app)
          .post('/api/webhooks/forward-lead')
          .send({ listId: 'list_123', email: 'err@example.com' });

        expect(response.status).toBe(201);
        expect(response.body.success).toBe(true);

        // Wait for fire-and-forget; should not throw
        await new Promise((r) => setTimeout(r, 200));
        expect(dripSequenceDb.bulkEnroll).not.toHaveBeenCalled();
      });
    });
  });


  // ENG-449 gap #3: the post-deploy smoke test submits a REAL lead through a customer's real
  // form. Deleting the row afterwards does not undo HubSpot/Attio sync, drip enrolment or an
  // auto-sent email — those fire the instant the lead is created. The guard therefore has to
  // recognise the lead by EITHER marker at creation time.
  describe('POST /api/webhooks/forward-lead — synthetic smoke-test lead suppression', () => {
    const smokeLeadList = {
      listId: 'list_123',
      userId: 'user_123',
      name: 'Test List',
      publicAccessEnabled: true,
      autoDraftEnabled: true,
    };

    beforeEach(() => {
      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(smokeLeadList);
    });

    it('skips the whole side-effect cascade for a lead recognised by its email', async () => {
      (crmDb.createLead as jest.Mock).mockResolvedValue({
        leadId: 'lead_smoke', listId: 'list_123', email: 'smoke-test+1789767265236@agentweb.pro',
      });

      const response = await request(app)
        .post('/api/webhooks/forward-lead')
        .send({ listId: 'list_123', email: 'smoke-test+1789767265236@agentweb.pro' });

      expect(response.status).toBe(201);
      await new Promise((r) => setTimeout(r, 200));
      expect(externalCrmSyncService.autoSyncLead).not.toHaveBeenCalled();
    });

    // The org lead NOTIFICATION sat above the synthetic gate, so it fired for smoke-test
    // leads — a real Slack/email alert to a human about a lead that does not exist.
    // `!isNew` is now exclusively the smoke-test adopt path for a phone-only capture
    // (deterministicLeadId was narrowed to synthetic numbers), and buildSmokeTestPhone
    // draws from only 100 reserved numbers, so collisions — and therefore these
    // notifications — are routine by construction rather than rare.
    it('does not send an org lead notification for a synthetic re-submission', async () => {
      const { dispatchLeadCreated } = require('../services/orgLeadNotificationService');
      (dispatchLeadCreated as jest.Mock).mockClear?.();
      // An ADOPT, which is the ONLY way to reach `!isNew`: the conditional create loses to
      // an earlier submission of the same synthetic number and throws leadAlreadyExists,
      // then the row is read back. Resolving createLead instead leaves isNew true and the
      // notification is never reached — which is how the first version of this test passed
      // with the gate deleted.
      (crmDb.createLead as jest.Mock).mockRejectedValue(
        Object.assign(new Error('exists'), { leadAlreadyExists: true }),
      );
      (crmDb.getLeadById as jest.Mock).mockResolvedValue({
        leadId: 'lead_ph_existing', listId: 'list_123', phone: '(415) 555-0142',
      });

      const response = await request(app)
        .post('/api/webhooks/forward-lead')
        .send({ listId: 'list_123', phone: '(415) 555-0142' });

      expect([200, 201]).toContain(response.status);
      await new Promise((r) => setTimeout(r, 200));
      expect(dispatchLeadCreated).not.toHaveBeenCalled();
    });

    it('skips the cascade for a lead recognised by its PHONE, when the address cannot carry the marker', async () => {
      // A lander with no email field substitutes its own placeholder address (observed live:
      // noemail+<ts>@waterheater.app). Without the phone marker, a real auto-sent email and a
      // real CRM sync fire for a lead that never existed.
      (crmDb.createLead as jest.Mock).mockResolvedValue({
        leadId: 'lead_smoke_phone', listId: 'list_123',
        email: 'noemail+1789767265236@waterheater.app', phone: '(415) 555-0142',
      });

      const response = await request(app)
        .post('/api/webhooks/forward-lead')
        .send({
          listId: 'list_123',
          email: 'noemail+1789767265236@waterheater.app',
          phone: '(415) 555-0142',
        });

      expect(response.status).toBe(201);
      await new Promise((r) => setTimeout(r, 200));
      expect(externalCrmSyncService.autoSyncLead).not.toHaveBeenCalled();
    });

    it('still runs the cascade for a real lead whose phone merely looks similar', async () => {
      (crmDb.createLead as jest.Mock).mockResolvedValue({
        leadId: 'lead_real', listId: 'list_123', email: 'buyer@acme.com', phone: '4155551234',
      });

      await request(app)
        .post('/api/webhooks/forward-lead')
        .send({ listId: 'list_123', email: 'buyer@acme.com', phone: '4155551234' });

      await new Promise((r) => setTimeout(r, 200));
      expect(externalCrmSyncService.autoSyncLead).toHaveBeenCalled();
    });
  });
});
